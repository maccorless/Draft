/**
 * F-MOD-016: Multi-source AAV and player intelligence data
 *
 * Uses real DB and real HTTP. CSV/Excel parsing runs in worker threads.
 * Commissioner tokens are signed directly to avoid the rate-limited auth endpoint.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import * as XLSX from 'xlsx';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

function multipartBody(fieldName: string, content: Buffer | string, filename: string, mime: string): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary016';
  const header = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
      `Content-Type: ${mime}`,
      '',
      '',
    ].join('\r\n'),
  );
  const footer = Buffer.from(`\r\n--${boundary}--`);
  const bodyContent = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    body: Buffer.concat([header, bodyContent, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe.skipIf(SKIP_DB)('F-MOD-016 multi-source AAV', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId = '';

  function makeCommToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: authEpoch });
  }

  async function createLeague(name = 'F016 Test League'): Promise<{ leagueId: string; token: string }> {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name, site_password: 's', commissioner_password: 'c' },
    });
    const leagueId = res.json<{ id: string }>().id;
    testLeagueId = leagueId;
    return { leagueId, token: makeCommToken(leagueId) };
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

  async function createDataset(leagueId: string, token: string): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.json<{ id: string }>().id;
  }

  function importCsv(leagueId: string, datasetId: string, token: string, csv: string) {
    const { body, contentType } = multipartBody('file', csv, 'players.csv', 'text/csv');
    return server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });
  }

  function importExcel(leagueId: string, datasetId: string, token: string, rows: Record<string, unknown>[]) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Players');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const { body, contentType } = multipartBody(
      'file',
      xlsxBuf,
      'players.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    return server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/excel`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
    });
  }

  // ── Multi-source rows ──────────────────────────────────────────────────────────

  it('test_F_MOD_016_import_from_one_source_creates_exactly_one_player_aav_sources_row', async () => {
    const { leagueId, token } = await createLeague('F016 One Source');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Solo Player,QB,KC,5000',
    ].join('\n'));

    const rows = await sql<Array<{ source: string }>>`
      SELECT pas.source FROM player_aav_sources pas
      JOIN players p ON p.id = pas.player_id
      WHERE pas.dataset_id = ${datasetId} AND p.name = 'F016 Solo Player'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('CSV');
  });

  it('test_F_MOD_016_import_same_player_from_second_source_adds_row_without_touching_first', async () => {
    const { leagueId, token } = await createLeague('F016 Two Sources');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Multi Player,RB,SF,4500',
    ].join('\n'));

    await importExcel(leagueId, datasetId, token, [
      { name: 'F016 Multi Player', position: 'RB', nfl_team: 'SF', aav_minor: 4800 },
    ]);

    const rows = await sql<Array<{ source: string; aav_minor: number }>>`
      SELECT pas.source, pas.aav_minor FROM player_aav_sources pas
      JOIN players p ON p.id = pas.player_id
      WHERE pas.dataset_id = ${datasetId} AND p.name = 'F016 Multi Player'
      ORDER BY pas.source ASC
    `;
    expect(rows).toHaveLength(2);
    const csvRow = rows.find((r) => r.source === 'CSV');
    const excelRow = rows.find((r) => r.source === 'EXCEL');
    expect(csvRow?.aav_minor).toBe(4500);
    expect(excelRow?.aav_minor).toBe(4800);
  });

  it('test_F_MOD_016_reimport_from_same_source_updates_in_place_not_duplicated', async () => {
    const { leagueId, token } = await createLeague('F016 Reimport');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Reimport Player,WR,MIA,3000',
    ].join('\n'));

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Reimport Player,WR,MIA,3300',
    ].join('\n'));

    const rows = await sql<Array<{ aav_minor: number }>>`
      SELECT pas.aav_minor FROM player_aav_sources pas
      JOIN players p ON p.id = pas.player_id
      WHERE pas.dataset_id = ${datasetId} AND p.name = 'F016 Reimport Player'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aav_minor).toBe(3300);
  });

  // ── Player intelligence fields ─────────────────────────────────────────────────

  it('test_F_MOD_016_csv_bye_week_and_injury_fields_are_persisted_onto_players', async () => {
    const { leagueId, token } = await createLeague('F016 Intelligence');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor,bye_week,injury_status,injury_detail',
      'F016 Hurt Player,TE,DAL,2000,9,QUESTIONABLE,Hamstring',
    ].join('\n'));

    const [row] = await sql<Array<{
      bye_week: number | null;
      injury_status: string | null;
      injury_detail: string | null;
      injury_updated_at: Date | null;
    }>>`
      SELECT bye_week, injury_status, injury_detail, injury_updated_at
      FROM players WHERE name = 'F016 Hurt Player'
    `;
    expect(row?.bye_week).toBe(9);
    expect(row?.injury_status).toBe('QUESTIONABLE');
    expect(row?.injury_detail).toBe('Hamstring');
    expect(row?.injury_updated_at).not.toBeNull();
  });

  it('test_F_MOD_016_later_import_without_intelligence_fields_does_not_clear_them', async () => {
    const { leagueId, token } = await createLeague('F016 Preserve Intelligence');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor,bye_week,injury_status',
      'F016 Preserved Player,RB,DEN,3500,7,OUT',
    ].join('\n'));

    // Second source's import omits bye_week/injury_status entirely.
    await importExcel(leagueId, datasetId, token, [
      { name: 'F016 Preserved Player', position: 'RB', nfl_team: 'DEN', aav_minor: 3600 },
    ]);

    const [row] = await sql<Array<{ bye_week: number | null; injury_status: string | null }>>`
      SELECT bye_week, injury_status FROM players WHERE name = 'F016 Preserved Player'
    `;
    expect(row?.bye_week).toBe(7);
    expect(row?.injury_status).toBe('OUT');
  });

  // ── GET /leagues/:id/players resolution ─────────────────────────────────────────

  it('test_F_MOD_016_listPlayers_includes_aav_sources_and_intelligence_fields', async () => {
    const { leagueId, token } = await createLeague('F016 List Players');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor,bye_week,injury_status,injury_detail',
      'F016 Listed Player,QB,LAC,6000,11,DOUBTFUL,Ankle',
    ].join('\n'));
    await importExcel(leagueId, datasetId, token, [
      { name: 'F016 Listed Player', position: 'QB', nfl_team: 'LAC', aav_minor: 6200 },
    ]);

    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/players`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      players: Array<{
        name: string;
        aav_minor: number;
        aav_sources: Array<{ source: string; aav_minor: number }>;
        bye_week: number | null;
        injury_status: string | null;
        injury_detail: string | null;
      }>;
    }>();
    const player = body.players.find((p) => p.name === 'F016 Listed Player');
    expect(player).toBeTruthy();
    expect(player!.aav_sources).toHaveLength(2);
    expect(player!.bye_week).toBe(11);
    expect(player!.injury_status).toBe('DOUBTFUL');
    expect(player!.injury_detail).toBe('Ankle');
    // No primary_aav_source selected yet, and two sources are loaded — no
    // unambiguous fallback, so aav_minor must not fabricate a value.
    expect(player!.aav_minor).toBe(0);
  });

  it('test_F_MOD_016_listPlayers_returns_null_intelligence_fields_when_source_never_supplied_them', async () => {
    const { leagueId, token } = await createLeague('F016 No Intelligence');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Plain Player,K,NYJ,100',
    ].join('\n'));

    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/players`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json<{ players: Array<{ name: string; bye_week: number | null; injury_status: string | null; aav_minor: number }> }>();
    const player = body.players.find((p) => p.name === 'F016 Plain Player');
    expect(player!.bye_week).toBeNull();
    expect(player!.injury_status).toBeNull();
    // Sole loaded source (CSV) is used as the implicit primary — backward
    // compatible with existing single-source datasets.
    expect(player!.aav_minor).toBe(100);
  });

  // ── PUT /leagues/:id/datasets/:id/aav-sources ───────────────────────────────────

  it('test_F_MOD_016_setAavSources_persists_selection_and_resolves_primary_secondary', async () => {
    const { leagueId, token } = await createLeague('F016 Set Sources');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Selected Player,WR,GB,7000',
    ].join('\n'));
    await importExcel(leagueId, datasetId, token, [
      { name: 'F016 Selected Player', position: 'WR', nfl_team: 'GB', aav_minor: 7500 },
    ]);

    const putRes = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/datasets/${datasetId}/aav-sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: { primary_aav_source: 'EXCEL', secondary_aav_source: 'CSV' },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json<{ primary_aav_source: string; secondary_aav_source: string | null }>()).toEqual({
      primary_aav_source: 'EXCEL',
      secondary_aav_source: 'CSV',
    });

    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });

    const listRes = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/players`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = listRes.json<{
      players: Array<{ name: string; aav_minor: number; primary_aav_minor: number | null; secondary_aav_minor: number | null }>;
    }>();
    const player = body.players.find((p) => p.name === 'F016 Selected Player');
    expect(player!.primary_aav_minor).toBe(7500);
    expect(player!.secondary_aav_minor).toBe(7000);
    expect(player!.aav_minor).toBe(7500);
  });

  it('test_F_MOD_016_setAavSources_rejects_source_not_loaded_and_makes_no_change', async () => {
    const { leagueId, token } = await createLeague('F016 Reject Source');
    const datasetId = await createDataset(leagueId, token);

    await importCsv(leagueId, datasetId, token, [
      'name,position,nfl_team,aav_minor',
      'F016 Reject Player,DEF,SEA,50',
    ].join('\n'));

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/datasets/${datasetId}/aav-sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: { primary_aav_source: 'FANTASYPROS' },
    });
    expect(res.statusCode).toBe(400);

    const [row] = await sql<Array<{ primary_aav_source: string | null }>>`
      SELECT primary_aav_source FROM draft_datasets WHERE id = ${datasetId}
    `;
    expect(row?.primary_aav_source).toBeNull();
  });

  it('test_F_MOD_016_setAavSources_401_when_no_token_provided', async () => {
    const { leagueId, token } = await createLeague('F016 Auth');
    const datasetId = await createDataset(leagueId, token);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/datasets/${datasetId}/aav-sources`,
      payload: { primary_aav_source: 'CSV' },
    });
    expect(res.statusCode).toBe(401);
  });
});
