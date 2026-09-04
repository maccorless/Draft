/**
 * F-MOD-001: League setup behavioral expectations
 *
 * Tests run against a real database (DATABASE_URL must point to a test DB).
 * To avoid hitting the rate limit on the auth endpoint, commissioner tokens are
 * signed directly via server.jwt.sign() — the auth endpoint itself is covered by
 * F-MOD-000 tests.
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

describe.skipIf(SKIP_DB)('F-MOD-001 league CRUD', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId = '';

  // Sign a commissioner token directly — avoids the rate-limited /auth/league/:id endpoint.
  // The preHandler validates the claim against the DB; this only bypasses the HTTP wrapper.
  function makeCommToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: authEpoch });
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
      await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
        SELECT id FROM roster_configurations WHERE league_id = ${testLeagueId}
      )`;
      await sql`DELETE FROM roster_configurations WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM auction_configurations WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${testLeagueId}`;
      testLeagueId = '';
    }
  });

  // ── POST /leagues ─────────────────────────────────────────────────────────

  it('test_F_MOD_001_create_league_returns_201_with_id_and_name', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: 'Test League Alpha',
        site_password: 'sitepass',
        commissioner_password: 'commpass',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string }>();
    expect(body.name).toBe('Test League Alpha');
    expect(typeof body.id).toBe('string');
    testLeagueId = body.id;
  });

  it('test_F_MOD_001_create_league_stores_bcrypt_hashes_not_plaintext_and_auth_epoch_is_1', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: 'Hash Test League',
        site_password: 'mysitepass',
        commissioner_password: 'mycommpass',
      },
    });
    expect(res.statusCode).toBe(201);
    testLeagueId = res.json<{ id: string }>().id;

    const [row] = await sql<[{ site_password_hash: string; commissioner_password_hash: string; auth_epoch: number }]>`
      SELECT site_password_hash, commissioner_password_hash, auth_epoch
      FROM leagues WHERE id = ${testLeagueId}
    `;
    // bcrypt hashes start with $2b$ or $2a$
    expect(row.site_password_hash).toMatch(/^\$2[ab]\$/);
    expect(row.commissioner_password_hash).toMatch(/^\$2[ab]\$/);
    expect(row.site_password_hash).not.toBe('mysitepass');
    expect(row.commissioner_password_hash).not.toBe('mycommpass');
    // auth_epoch=1 for newly created leagues (spec: "assigns a fresh auth_epoch = 1")
    expect(row.auth_epoch).toBe(1);
  });

  it('test_F_MOD_001_create_league_missing_fields_returns_400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Incomplete' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /leagues/:id ──────────────────────────────────────────────────────

  it('test_F_MOD_001_get_league_returns_id_and_name_without_password_hashes', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Get League Test', site_password: 'sp', commissioner_password: 'cp' },
    });
    testLeagueId = create.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['id']).toBe(testLeagueId);
    expect(body['name']).toBe('Get League Test');
    expect(body['site_password_hash']).toBeUndefined();
    expect(body['commissioner_password_hash']).toBeUndefined();
  });

  it('test_F_MOD_001_get_league_token_for_different_league_returns_403', async () => {
    const c1 = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'League One', site_password: 'sp1', commissioner_password: 'cp1' },
    });
    const league1Id = c1.json<{ id: string }>().id;
    testLeagueId = league1Id;

    const c2 = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'League Two', site_password: 'sp2', commissioner_password: 'cp2' },
    });
    const league2Id = c2.json<{ id: string }>().id;

    // Use league1's token to access league2 — scope mismatch
    const token1 = makeCommToken(league1Id);
    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${league2Id}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(res.statusCode).toBe(403);

    await sql`DELETE FROM leagues WHERE id = ${league2Id}`;
  });

  // ── POST /leagues/:id/teams ───────────────────────────────────────────────

  it('test_F_MOD_001_create_team_returns_201_with_id_name_draft_order', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Team Create League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${testLeagueId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'The Sharks', team_password: 'sharkpass', draft_order: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; draft_order: number }>();
    expect(body.name).toBe('The Sharks');
    expect(body.draft_order).toBe(1);
    expect(typeof body.id).toBe('string');
  });

  it('test_F_MOD_001_create_team_stores_bcrypt_hash_not_plaintext', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Team Hash League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${testLeagueId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'The Dolphins', team_password: 'dolphinpass', draft_order: 2 },
    });
    const teamId = res.json<{ id: string }>().id;

    const [row] = await sql<[{ team_password_hash: string }]>`
      SELECT team_password_hash FROM teams WHERE id = ${teamId}
    `;
    expect(row.team_password_hash).toMatch(/^\$2[ab]\$/);
    expect(row.team_password_hash).not.toBe('dolphinpass');
  });

  // ── GET /leagues/:id/teams ────────────────────────────────────────────────

  it('test_F_MOD_001_list_teams_returns_array_without_password_hashes', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'List Teams League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    await server.inject({
      method: 'POST',
      url: `/leagues/${testLeagueId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Eagles', team_password: 'ep', draft_order: 1 },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${testLeagueId}/teams`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ teams: Array<Record<string, unknown>> }>();
    expect(Array.isArray(body.teams)).toBe(true);
    expect(body.teams.length).toBeGreaterThan(0);
    const t = body.teams[0];
    expect(t?.['name']).toBe('Eagles');
    expect(t?.['team_password_hash']).toBeUndefined();
  });

  // ── PUT /leagues/:id/config/roster ────────────────────────────────────────

  it('test_F_MOD_001_set_roster_config_valid_request_returns_200', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Roster Config League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/roster`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        bench_slots: 6,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
          { position: 'WR', priority: 3, is_starter: true, slot_count: 2 },
          { position: 'TE', priority: 4, is_starter: true, slot_count: 1 },
        ],
      },
    });
    // total_roster_size = 1+2+2+1+6 = 12
    expect(res.statusCode).toBe(200);
  });

  it('test_F_MOD_001_set_roster_config_auto_creates_bench_slot_definition', async () => {
    // The commissioner submits only starter slots plus a bench_slots count —
    // never a manual 'BN' row (the UI doesn't ask for one). The auction
    // engine's assignRosterSlot needs an actual roster_slot_definitions row
    // to assign bench picks to, so the endpoint must materialize one itself.
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Bench Auto League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/roster`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        bench_slots: 6,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
        ],
      },
    });

    const rows = await sql<{ position: string; is_starter: boolean; slot_count: number }[]>`
      SELECT rsd.position, rsd.is_starter, rsd.slot_count
      FROM roster_slot_definitions rsd
      JOIN roster_configurations rc ON rc.id = rsd.config_id
      WHERE rc.league_id = ${testLeagueId}
    `;
    const bench = rows.find((r) => r.position === 'BN');
    expect(bench).toBeTruthy();
    expect(bench?.is_starter).toBe(false);
    expect(bench?.slot_count).toBe(6);
    // Exactly one bench row — not duplicated if the commissioner re-saves.
    expect(rows.filter((r) => r.position === 'BN').length).toBe(1);
  });

  it('test_F_MOD_001_set_roster_config_zero_bench_slots_creates_no_bench_row', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'No Bench League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/roster`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        bench_slots: 0,
        slots: [{ position: 'QB', priority: 1, is_starter: true, slot_count: 1 }],
      },
    });

    const rows = await sql<{ position: string }[]>`
      SELECT rsd.position
      FROM roster_slot_definitions rsd
      JOIN roster_configurations rc ON rc.id = rsd.config_id
      WHERE rc.league_id = ${testLeagueId}
    `;
    expect(rows.some((r) => r.position === 'BN')).toBe(false);
  });

  it('test_F_MOD_001_set_roster_config_empty_slots_returns_4xx', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Roster Invariant League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/roster`,
      headers: { authorization: `Bearer ${token}` },
      payload: { bench_slots: 6, slots: [] },
    });
    // Empty slots violates min(1) constraint
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── PUT /leagues/:id/config/auction ───────────────────────────────────────

  it('test_F_MOD_001_set_auction_config_stores_integer_values_no_floats', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Auction Config League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/auction`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        initial_budget_minor: 20000,
        nomination_timer_ms: 90000,
        second_bid_timer_ms: 30000,
        rebid_timer_ms: 15000,
        anti_snipe_threshold_ms: 5000,
        anti_snipe_extension_ms: 10000,
        min_bid_minor: 100,
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await sql<[{
      initial_budget_minor: number;
      nomination_timer_ms: number;
      min_bid_minor: number;
    }]>`
      SELECT initial_budget_minor, nomination_timer_ms, min_bid_minor
      FROM auction_configurations WHERE league_id = ${testLeagueId}
    `;
    expect(Number.isInteger(row.initial_budget_minor)).toBe(true);
    expect(row.initial_budget_minor).toBe(20000);
    expect(row.nomination_timer_ms).toBe(90000);
    expect(row.min_bid_minor).toBe(100);
  });
});
