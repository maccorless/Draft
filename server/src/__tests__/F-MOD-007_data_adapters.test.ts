/**
 * F-MOD-007: Data Adapters — Excel, ESPN PDF, FantasyPros import endpoints
 *
 * Tests run against real DB and real Fastify. No mocks.
 * FantasyPros tests use a real local HTTP server to simulate API responses.
 * Excel tests use the real xlsx library to create test files.
 * ESPN PDF tests exercise defensive parsing with invalid PDF bytes.
 */

// ── Env setup — MUST happen before any module import that reads env vars ──────
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
process.env['SENDGRID_API_KEY'] = process.env['SENDGRID_API_KEY'] ?? 'test-sendgrid-key';
process.env['FANTASYPROS_API_KEY'] = process.env['FANTASYPROS_API_KEY'] ?? 'test-fantasypros-key';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { spawnSync } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const ENV_CHECK = path.join(__dirname, '../config/env-check.cjs');

const SKIP_DB = !process.env['DATABASE_URL'];

// ── Multipart helper ──────────────────────────────────────────────────────────

function multipartFile(
  fieldName: string,
  fileContent: Buffer,
  filename: string,
  mimeType: string,
): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary007';
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    '',
  ].join('\r\n');
  const footer = `\r\n--${boundary}--`;
  return {
    body: Buffer.concat([Buffer.from(header), fileContent, Buffer.from(footer)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Minimal PDF helpers ───────────────────────────────────────────────────────

/**
 * Build a minimal (but structurally valid) PDF buffer containing `text`.
 * pdfjs-dist can parse this; the content follows the ESPN AAV pattern so
 * the espn-pdf-worker can extract player rows from it.
 */
function buildMinimalPdf(text: string): Buffer {
  const parts: string[] = [];
  let pos = 0;
  const objOffsets: number[] = [];

  const write = (s: string): void => {
    parts.push(s);
    pos += s.length;
  };

  write('%PDF-1.4\n');

  objOffsets.push(pos);
  write('1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n');

  objOffsets.push(pos);
  write('2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n');

  objOffsets.push(pos);
  const res = '<</Font <</F1 <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>>>>>';
  write(`3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources ${res}>>\nendobj\n`);

  objOffsets.push(pos);
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  write(`4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`);

  const xrefOffset = pos;
  write('xref\n');
  write('0 5\n');
  write('0000000000 65535 f \n');
  for (const o of objOffsets) {
    write(o.toString().padStart(10, '0') + ' 00000 n \n');
  }
  write('trailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n');
  write(xrefOffset.toString() + '\n');
  write('%%EOF');

  return Buffer.from(parts.join(''), 'binary');
}

// ── FantasyPros test server ───────────────────────────────────────────────────

function startFpTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('F-MOD-007 env checker — FANTASYPROS_API_KEY', () => {
  it('test_F_MOD_007_env_check_passes_without_fantasypros_api_key', () => {
    // FANTASYPROS_API_KEY is optional — the server boots without it and the
    // FantasyPros adapter returns a 503 when the key is absent at call time.
    const result = spawnSync(process.execPath, [ENV_CHECK], {
      env: {
        DATABASE_URL: 'postgres://localhost/test',
        JWT_SECRET: 'test-secret-at-least-32-chars-long',
        NODE_ENV: 'test',
        // FANTASYPROS_API_KEY intentionally absent — must not block boot
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });

  it('test_F_MOD_007_env_example_contains_fantasypros_api_key_placeholder', () => {
    const { readFileSync } = require('fs');
    const envExample = readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8') as string;
    expect(envExample).toContain('FANTASYPROS_API_KEY');
  });
});

describe.skipIf(SKIP_DB)('F-MOD-007 data adapter routes', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId = '';

  function makeCommToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: authEpoch });
  }

  async function createLeague(name = 'Adapter Test League'): Promise<{ leagueId: string; token: string }> {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name, site_password: 's', commissioner_password: 'c' },
    });
    const leagueId = res.json<{ id: string }>().id;
    testLeagueId = leagueId;
    return { leagueId, token: makeCommToken(leagueId) };
  }

  async function createDataset(leagueId: string, token: string): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 2 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  afterEach(async () => {
    if (testLeagueId) {
      await sql`DELETE FROM drafts WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM player_aav_sources WHERE dataset_id IN (
        SELECT id FROM draft_datasets WHERE league_id = ${testLeagueId}
      )`;
      await sql`DELETE FROM draft_datasets WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${testLeagueId}`;
      testLeagueId = '';
    }
    await sql`DELETE FROM players WHERE id NOT IN (
      SELECT DISTINCT player_id FROM player_aav_sources
    )`;
  });

  // ── Auth and isolation tests (shared across all three new endpoints) ─────────

  it('test_F_MOD_007_excel_endpoint_missing_jwt_returns_401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues/00000000-0000-0000-0000-000000000001/datasets/00000000-0000-0000-0000-000000000002/import/excel',
      // No Authorization header
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_007_espn_pdf_endpoint_missing_jwt_returns_401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues/00000000-0000-0000-0000-000000000001/datasets/00000000-0000-0000-0000-000000000002/import/espn-pdf',
      // No Authorization header
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_007_fantasypros_endpoint_missing_jwt_returns_401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues/00000000-0000-0000-0000-000000000001/datasets/00000000-0000-0000-0000-000000000002/import/fantasypros',
      // No Authorization header
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_007_excel_endpoint_wrong_league_id_returns_403', async () => {
    const { leagueId: correctLeague } = await createLeague('Wrong League Test');
    const wrongLeagueToken = makeCommToken('00000000-0000-0000-0000-000000000099');

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${correctLeague}/datasets/00000000-0000-0000-0000-000000000002/import/excel`,
      headers: { authorization: `Bearer ${wrongLeagueToken}` },
    });
    // JWT league_id !== route leagueId → 403 (league isolation constraint #6)
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_007_fantasypros_endpoint_wrong_league_id_returns_403', async () => {
    const { leagueId: correctLeague } = await createLeague('FP Wrong League Test');
    const wrongLeagueToken = makeCommToken('00000000-0000-0000-0000-000000000099');

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${correctLeague}/datasets/00000000-0000-0000-0000-000000000002/import/fantasypros`,
      headers: { authorization: `Bearer ${wrongLeagueToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Excel import ─────────────────────────────────────────────────────────────

  it('test_F_MOD_007_excel_import_returns_import_result_with_source_EXCEL', async () => {
    const { leagueId, token } = await createLeague('Excel Import League');
    const datasetId = await createDataset(leagueId, token);

    // Build a real XLSX file with known player data
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { name: 'Patrick Mahomes', position: 'QB', nfl_team: 'KC', aav_minor: 12500, projected_points: 320.5 },
      { name: 'Justin Jefferson', position: 'WR', nfl_team: 'MIN', aav_minor: 8000, projected_points: 280.1 },
      { name: 'Christian McCaffrey', position: 'RB', nfl_team: 'SF', aav_minor: 11000, projected_points: 340.0 },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Players');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const { body, contentType } = multipartFile('file', xlsxBuf, 'players.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/excel`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });

    expect(res.statusCode).toBe(200);
    const result = res.json<{ rows_imported: number; source: string; errors: unknown[] }>();
    expect(result.source).toBe('EXCEL');
    // 3 valid rows
    expect(result.rows_imported).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('test_F_MOD_007_excel_import_partial_errors_still_returns_200', async () => {
    const { leagueId, token } = await createLeague('Excel Partial League');
    const datasetId = await createDataset(leagueId, token);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { name: 'Valid Player', position: 'QB', nfl_team: 'KC', aav_minor: 5000 },
      { name: '',  position: 'RB', nfl_team: 'DAL', aav_minor: 3000 },  // missing name → error
      { name: 'Bad AAV', position: 'WR', nfl_team: 'SF', aav_minor: 'not-a-number' }, // bad aav → error
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Players');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const { body, contentType } = multipartFile('file', xlsxBuf, 'partial.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/excel`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });

    // Partial errors → still 200, not 500
    expect(res.statusCode).toBe(200);
    const result = res.json<{ rows_imported: number; source: string; errors: Array<{ row: number; message: string }> }>();
    expect(result.source).toBe('EXCEL');
    expect(result.rows_imported).toBe(1); // only the valid row
    expect(result.errors.length).toBeGreaterThanOrEqual(2); // missing name + bad aav
  });

  it('test_F_MOD_007_excel_import_no_file_returns_400', async () => {
    const { leagueId, token } = await createLeague('Excel No File League');
    const datasetId = await createDataset(leagueId, token);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/excel`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=----empty' },
      body: Buffer.from('----empty--'),
    });

    expect(res.statusCode).toBe(400);
  });

  // ── ESPN PDF import ───────────────────────────────────────────────────────────

  it('test_F_MOD_007_espn_pdf_invalid_bytes_returns_200_with_errors_source_ESPN_PDF', async () => {
    const { leagueId, token } = await createLeague('ESPN PDF Invalid League');
    const datasetId = await createDataset(leagueId, token);

    // Non-PDF bytes — worker should catch the parse error and return 200 with errors
    const fakePdf = Buffer.from('this is not a pdf', 'utf-8');

    const { body, contentType } = multipartFile('file', fakePdf, 'fake.pdf', 'application/pdf');
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/espn-pdf`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });

    // Defensive parsing — invalid PDF → 200 with errors, NOT 500
    expect(res.statusCode).toBe(200);
    const result = res.json<{ rows_imported: number; source: string; errors: Array<{ row: number; message: string }> }>();
    expect(result.source).toBe('ESPN_PDF');
    expect(result.rows_imported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toMatch(/pdf|parse|worker/i);
  });

  it('test_F_MOD_007_espn_pdf_no_file_returns_400', async () => {
    const { leagueId, token } = await createLeague('ESPN PDF No File League');
    const datasetId = await createDataset(leagueId, token);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/espn-pdf`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=----empty' },
      body: Buffer.from('----empty--'),
    });

    expect(res.statusCode).toBe(400);
  });

  // ── FantasyPros import ────────────────────────────────────────────────────────

  it('test_F_MOD_007_fantasypros_non_2xx_returns_typed_error_response', async () => {
    const { leagueId, token } = await createLeague('FP Non-2xx League');
    const datasetId = await createDataset(leagueId, token);

    // Start a real test HTTP server that returns 503
    const { server: fpServer, port } = await startFpTestServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable' }));
    });

    try {
      // Override the FantasyPros API URL to our test server
      process.env['FANTASYPROS_API_URL'] = `http://127.0.0.1:${port}`;

      const res = await server.inject({
        method: 'POST',
        url: `/leagues/${leagueId}/datasets/${datasetId}/import/fantasypros`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { scoring_format: 'PPR' },
      });

      // Non-2xx from FantasyPros → typed ErrorResponse, no silent fallback
      expect(res.statusCode).toBe(502);
      const body = res.json<{ code: string; message: string }>();
      expect(body.code).toBe('FANTASYPROS_ERROR');
      expect(typeof body.message).toBe('string');
      expect(body.message).toContain('503');

      // Dataset should be unchanged — no rows inserted
      const playerCount = await sql`
        SELECT COUNT(*) as count FROM player_aav_sources WHERE dataset_id = ${datasetId}
      `;
      expect(Number(playerCount[0]!.count)).toBe(0);
    } finally {
      delete process.env['FANTASYPROS_API_URL'];
      await new Promise<void>((r) => fpServer.close(() => r()));
    }
  });

  it('test_F_MOD_007_fantasypros_valid_response_returns_rows_imported_with_source_FANTASYPROS', async () => {
    const { leagueId, token } = await createLeague('FP Valid League');
    const datasetId = await createDataset(leagueId, token);

    // Start a real test HTTP server that returns FantasyPros-format JSON
    const fpData = {
      players: [
        { player_name: 'Patrick Mahomes', player_position_id: 'QB', player_team_id: 'KC', avg: '320.5', rank: 1 },
        { player_name: 'Justin Jefferson', player_position_id: 'WR', player_team_id: 'MIN', avg: '280.1', rank: 2 },
      ],
    };
    const { server: fpServer, port } = await startFpTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fpData));
    });

    try {
      process.env['FANTASYPROS_API_URL'] = `http://127.0.0.1:${port}`;

      const res = await server.inject({
        method: 'POST',
        url: `/leagues/${leagueId}/datasets/${datasetId}/import/fantasypros`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { scoring_format: 'PPR' },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json<{ rows_imported: number; source: string; errors: unknown[] }>();
      expect(result.source).toBe('FANTASYPROS');
      // 2 valid players from the test server
      expect(result.rows_imported).toBe(2);
      expect(result.errors).toHaveLength(0);
    } finally {
      delete process.env['FANTASYPROS_API_URL'];
      await new Promise<void>((r) => fpServer.close(() => r()));
    }
  });

  it('test_F_MOD_007_fantasypros_invalid_scoring_format_returns_400', async () => {
    const { leagueId, token } = await createLeague('FP Invalid Format League');
    const datasetId = await createDataset(leagueId, token);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/fantasypros`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { scoring_format: 'INVALID' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  // ── Worker thread isolation ───────────────────────────────────────────────────

  it('test_F_MOD_007_excel_import_worker_does_not_block_main_event_loop', async () => {
    const { leagueId, token } = await createLeague('Worker Isolation League');
    const datasetId = await createDataset(leagueId, token);

    // Build a moderately-sized XLSX to ensure the worker is actually busy
    const rows = Array.from({ length: 50 }, (_, i) => ({
      name: `Player ${i}`,
      position: 'QB',
      nfl_team: 'KC',
      aav_minor: 1000 + i,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Players');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const { body: fileBody, contentType } = multipartFile('file', xlsxBuf, 'big.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const importStart = Date.now();

    // Fire the import (runs in a worker thread) and simultaneously ping health
    const [importRes, healthRes] = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/leagues/${leagueId}/datasets/${datasetId}/import/excel`,
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body: fileBody,
      }),
      server.inject({ method: 'GET', url: '/health' }),
    ]);

    const healthMs = Date.now() - importStart;

    expect(importRes.statusCode).toBe(200);
    expect(healthRes.statusCode).toBe(200);
    // Health endpoint should respond quickly — under 5 seconds even while import runs
    expect(healthMs).toBeLessThan(5000);
  });
});
