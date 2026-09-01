/**
 * F-MOD-001: Dataset import, freeze, draft creation, and player listing
 *
 * Uses real DB and real HTTP. CSV parsing runs in a worker thread.
 * Commissioner tokens are signed directly to avoid the rate-limited auth endpoint.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

// Minimal multipart body builder for server.inject
function multipartBody(fieldName: string, csvContent: string, filename = 'players.csv'): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary12345';
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    'Content-Type: text/csv',
    '',
    csvContent,
    `--${boundary}--`,
  ].join('\r\n');
  return {
    body: Buffer.from(body),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe.skipIf(SKIP_DB)('F-MOD-001 dataset and draft', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId = '';

  function makeCommToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: authEpoch });
  }

  async function createLeague(name = 'Dataset Test League'): Promise<{ leagueId: string; token: string }> {
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
      // Clean up in dependency order
      await sql`DELETE FROM drafts WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM player_dataset_entries WHERE dataset_id IN (
        SELECT id FROM draft_datasets WHERE league_id = ${testLeagueId}
      )`;
      await sql`DELETE FROM draft_datasets WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${testLeagueId}`;
      testLeagueId = '';
    }
    // Clean up any orphaned players inserted during CSV import
    // (players not referenced by any dataset entry)
    await sql`DELETE FROM players WHERE id NOT IN (
      SELECT DISTINCT player_id FROM player_dataset_entries
    )`;
  });

  // ── POST /leagues/:id/datasets ────────────────────────────────────────────

  it('test_F_MOD_001_create_dataset_returns_201_with_status_DRAFT_version_1', async () => {
    const { leagueId, token } = await createLeague();

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; version: number }>();
    expect(body.status).toBe('DRAFT');
    expect(body.version).toBe(1);
    expect(typeof body.id).toBe('string');
  });

  // ── POST .../import/csv ───────────────────────────────────────────────────

  it('test_F_MOD_001_csv_import_parses_in_worker_thread_returns_rows_imported', async () => {
    const { leagueId, token } = await createLeague('CSV Import League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    const csv = [
      'name,position,nfl_team,aav_minor,projected_points,tier',
      'Patrick Mahomes,QB,KC,5000,380,1',
      'Justin Jefferson,WR,MIN,4500,320,1',
      'Christian McCaffrey,RB,SF,4800,340,1',
    ].join('\n');

    const { body, contentType } = multipartBody('file', csv);
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    const result = res.json<{ rows_imported: number; errors: unknown[] }>();
    expect(result.rows_imported).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('test_F_MOD_001_csv_import_returns_errors_for_invalid_rows', async () => {
    const { leagueId, token } = await createLeague('CSV Error League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    const csv = [
      'name,position,nfl_team,aav_minor',
      'Valid Player,QB,KC,1000',
      ',RB,DAL,2000',      // missing name → error
      'Bad AAV,WR,SF,notanumber', // bad aav_minor → error
    ].join('\n');

    const { body, contentType } = multipartBody('file', csv);
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    const result = res.json<{ rows_imported: number; errors: Array<{ row: number; message: string }> }>();
    // 1 valid, 2 errors
    expect(result.rows_imported).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('test_F_MOD_001_csv_import_on_frozen_dataset_returns_409', async () => {
    const { leagueId, token } = await createLeague('Frozen Import League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    // Import one player so we can freeze
    const csv = ['name,position,nfl_team,aav_minor', 'Player A,QB,KC,1000'].join('\n');
    const { body: csvBody, contentType } = multipartBody('file', csv);
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body: csvBody,
    });

    // Freeze
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Try to import again — must get 409
    const { body: body2, contentType: ct2 } = multipartBody('file', 'name,position,nfl_team,aav_minor\nPlayer B,RB,DAL,500');
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': ct2 },
      body: body2,
    });
    expect(res.statusCode).toBe(409);
  });

  // ── POST .../freeze ───────────────────────────────────────────────────────

  it('test_F_MOD_001_freeze_dataset_sets_status_FROZEN_and_records_frozen_at', async () => {
    const { leagueId, token } = await createLeague('Freeze League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    // Import player first (freeze requires non-empty dataset)
    const csv = ['name,position,nfl_team,aav_minor', 'Freeze Test QB,QB,KC,1500'].join('\n');
    const { body: csvBody, contentType } = multipartBody('file', csv);
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body: csvBody,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string; frozen_at: string }>();
    expect(body.status).toBe('FROZEN');
    expect(body.frozen_at).toBeTruthy();
  });

  // ── POST /leagues/:id/drafts ──────────────────────────────────────────────

  it('test_F_MOD_001_create_draft_with_non_frozen_dataset_returns_4xx', async () => {
    const { leagueId, token } = await createLeague('Draft Non-Frozen League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { dataset_id: datasetId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('test_F_MOD_001_create_draft_with_frozen_dataset_returns_201_status_CREATED', async () => {
    const { leagueId, token } = await createLeague('Draft Frozen League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    // Import + freeze
    const csv = ['name,position,nfl_team,aav_minor', 'Draft QB,QB,GB,2000'].join('\n');
    const { body: csvBody, contentType } = multipartBody('file', csv);
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body: csvBody,
    });
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/freeze`,
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { dataset_id: datasetId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; league_id: string; status: string; dataset_id: string }>();
    expect(body.status).toBe('CREATED');
    expect(body.league_id).toBe(leagueId);
    expect(body.dataset_id).toBe(datasetId);
    expect(typeof body.id).toBe('string');
  });

  // ── GET /leagues/:id/players ──────────────────────────────────────────────

  it('test_F_MOD_001_list_players_returns_integer_aav_minor_no_floats', async () => {
    const { leagueId, token } = await createLeague('Players League');

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    // Import players with aav_minor values
    const csv = [
      'name,position,nfl_team,aav_minor,projected_points,tier',
      'Top QB,QB,KC,5000,380.5,1',
      'Top RB,RB,SF,4500,320.25,2',
    ].join('\n');
    const { body: csvBody, contentType } = multipartBody('file', csv);
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body: csvBody,
    });

    // Freeze so list endpoint uses this dataset
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
    const body = res.json<{ players: Array<{ aav_minor: number; name: string; position: string }> }>();
    expect(body.players.length).toBe(2);

    for (const player of body.players) {
      // aav_minor must be integer (not float)
      expect(Number.isInteger(player.aav_minor)).toBe(true);
    }

    const qb = body.players.find((p) => p.position === 'QB');
    expect(qb).toBeTruthy();
    expect(qb?.aav_minor).toBe(5000);
  });

  it('test_F_MOD_001_list_players_no_frozen_dataset_returns_empty_array', async () => {
    const { leagueId, token } = await createLeague('Empty Players League');

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/players`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ players: unknown[] }>();
    expect(body.players).toHaveLength(0);
  });
});
