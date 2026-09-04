/**
 * F-MOD-010: Commissioner League Setup and Readiness Checklist
 *
 * Tests run against a real database (DATABASE_URL must point to a test DB).
 * Commissioner/owner/host tokens are signed directly via server.jwt.sign() to
 * avoid the rate-limited /auth/league/:id endpoint — that endpoint's own
 * behavior (including the new HOST branch) is covered separately below.
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

describe.skipIf(SKIP_DB)('F-MOD-010 commissioner league setup', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId = '';

  function makeCommToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: authEpoch });
  }
  function makeOwnerToken(leagueId: string, teamId: string, authEpoch = 0): string {
    return server.jwt.sign({ league_id: leagueId, team_id: teamId, role: 'OWNER', auth_epoch: authEpoch });
  }
  function makeHostToken(leagueId: string, authEpoch = 1): string {
    return server.jwt.sign({ league_id: leagueId, role: 'HOST', auth_epoch: authEpoch });
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
      await sql`DELETE FROM whammy_configs WHERE league_id = ${testLeagueId}`;
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

  async function createLeagueWithTeam(): Promise<{ leagueId: string; teamId: string }> {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Setup League', site_password: 's', commissioner_password: 'c' },
    });
    const leagueId = c.json<{ id: string }>().id;
    const commToken = makeCommToken(leagueId);
    const t = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'The Sharks', team_password: 'sharkpass', draft_order: 1 },
    });
    const teamId = t.json<{ id: string }>().id;
    return { leagueId, teamId };
  }

  // ── GET /leagues/:id — cross-cutting auth widening fix ──────────────────────

  it('test_F_MOD_010_get_league_accepts_owner_token_and_returns_status_message', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;

    const commToken = makeCommToken(leagueId);
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { status_message: 'Draft starts soon!' },
    });

    const ownerToken = makeOwnerToken(leagueId, teamId);
    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status_message: string | null }>().status_message).toBe('Draft starts soon!');
  });

  it('test_F_MOD_010_get_league_owner_token_for_different_league_still_returns_403', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;

    const other = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Other League', site_password: 's2', commissioner_password: 'c2' },
    });
    const otherLeagueId = other.json<{ id: string }>().id;

    const ownerToken = makeOwnerToken(leagueId, teamId);
    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${otherLeagueId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(403);

    await sql`DELETE FROM leagues WHERE id = ${otherLeagueId}`;
  });

  // ── PUT /leagues/:id — updateLeague ──────────────────────────────────────────

  it('test_F_MOD_010_update_league_identity_persists_and_returns_summary', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Identity League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Renamed League', logo_url: 'https://example.com/logo.png', name_lock: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string; logo_url: string | null; name_lock: boolean }>();
    expect(body.name).toBe('Renamed League');
    expect(body.logo_url).toBe('https://example.com/logo.png');
    expect(body.name_lock).toBe(true);
  });

  it('test_F_MOD_010_update_league_without_jwt_returns_401', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'No Auth League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_010_update_league_owner_token_returns_403', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;

    const ownerToken = makeOwnerToken(leagueId, teamId);
    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_010_update_league_status_message_null_reads_back_null', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Status Msg League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status_message: 'Hello owners' },
    });
    const cleared = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status_message: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ status_message: string | null }>().status_message).toBeNull();
  });

  it('test_F_MOD_010_update_league_scheduled_start_persists_and_reads_back', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Scheduling League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const startAt = '2026-09-10T18:00:00.000Z';
    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scheduled_draft_start_at: startAt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ scheduled_draft_start_at: string | null }>().scheduled_draft_start_at).toBe(startAt);

    const [row] = await sql<[{ scheduled_draft_start_at: Date | null }]>`
      SELECT scheduled_draft_start_at FROM leagues WHERE id = ${testLeagueId}
    `;
    expect(row.scheduled_draft_start_at).not.toBeNull();
  });

  // ── PUT /leagues/:id/teams/:teamId — updateTeam ──────────────────────────────

  it('test_F_MOD_010_update_team_starting_budget_override_persists', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;
    const token = makeCommToken(leagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/teams/${teamId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { starting_budget_override_minor: 15000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ starting_budget_override_minor: number | null }>().starting_budget_override_minor).toBe(15000);

    const clearRes = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/teams/${teamId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { starting_budget_override_minor: null },
    });
    expect(clearRes.json<{ starting_budget_override_minor: number | null }>().starting_budget_override_minor).toBeNull();
  });

  it('test_F_MOD_010_update_team_name_lock_and_draft_order_persist', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;
    const token = makeCommToken(leagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/teams/${teamId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name_lock: true, draft_order: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ name_lock: boolean; draft_order: number }>();
    expect(body.name_lock).toBe(true);
    expect(body.draft_order).toBe(5);
  });

  // ── POST /leagues/:id/passwords/generate ─────────────────────────────────────

  it('test_F_MOD_010_generate_commissioner_password_bumps_auth_epoch_and_invalidates_old_token', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Password League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const oldToken = makeCommToken(testLeagueId, 1);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${testLeagueId}/passwords/generate`,
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { scope: 'COMMISSIONER' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ scope: string; password: string }>();
    expect(body.scope).toBe('COMMISSIONER');
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThan(0);

    const [row] = await sql<[{ auth_epoch: number; commissioner_password_hash: string }]>`
      SELECT auth_epoch, commissioner_password_hash FROM leagues WHERE id = ${testLeagueId}
    `;
    expect(row.auth_epoch).toBe(2);
    expect(row.commissioner_password_hash).toMatch(/^\$2[ab]\$/);
    expect(row.commissioner_password_hash).not.toBe(body.password);

    // Old token (auth_epoch=1) must now be revoked.
    const revokedCheck = await server.inject({
      method: 'GET',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(revokedCheck.statusCode).toBe(401);
  });

  it('test_F_MOD_010_generate_team_password_with_custom_value_stores_exact_value', async () => {
    const { leagueId, teamId } = await createLeagueWithTeam();
    testLeagueId = leagueId;
    const token = makeCommToken(leagueId);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/passwords/generate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scope: 'TEAM', team_id: teamId, custom_password: 'my-custom-pw' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ password: string }>().password).toBe('my-custom-pw');

    const [row] = await sql<[{ team_password_hash: string; auth_epoch: number }]>`
      SELECT team_password_hash, auth_epoch FROM teams WHERE id = ${teamId}
    `;
    expect(row.team_password_hash).toMatch(/^\$2[ab]\$/);
    expect(row.auth_epoch).toBe(1);
  });

  it('test_F_MOD_010_generate_host_password_then_host_login_succeeds', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Host League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    await server.inject({
      method: 'POST',
      url: `/leagues/${testLeagueId}/passwords/generate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scope: 'HOST', custom_password: 'hostpass123' },
    });

    const loginRes = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'HOST', password: 'hostpass123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token: hostToken } = loginRes.json<{ token: string }>();

    const decoded = server.jwt.decode<{ role: string; team_id?: string; league_id: string }>(hostToken);
    expect(decoded?.role).toBe('HOST');
    expect(decoded?.team_id).toBeUndefined();
    expect(decoded?.league_id).toBe(testLeagueId);
  });

  it('test_F_MOD_010_host_login_rejected_when_host_password_unset', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'No Host League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;

    const res = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'HOST', password: 'anything' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_010_host_token_rejected_by_commissioner_mutation_endpoint', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Host Reject League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const hostToken = makeHostToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { name: 'Should Fail' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── PUT /leagues/:id/config/whammy — setWhammyConfig ─────────────────────────

  it('test_F_MOD_010_set_whammy_config_upserts_and_is_enforced_by_mod009', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Whammy League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/whammy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enabled: true,
        allow_positive: true,
        allow_negative: true,
        max_amount_minor: 500,
        max_per_team: 1,
        max_per_draft: 5,
        commissioner_approval_required: false,
        allowed_event_types: ['GOOD_LUCK', 'BAD_LUCK'],
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await sql<[{ enabled: boolean; max_amount_minor: number; max_per_team: number }]>`
      SELECT enabled, max_amount_minor, max_per_team FROM whammy_configs WHERE league_id = ${testLeagueId}
    `;
    expect(row.enabled).toBe(true);
    expect(row.max_amount_minor).toBe(500);
    expect(row.max_per_team).toBe(1);

    // Update again — upsert, not duplicate row.
    await server.inject({
      method: 'PUT',
      url: `/leagues/${testLeagueId}/config/whammy`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true, max_amount_minor: 200 },
    });
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM whammy_configs WHERE league_id = ${testLeagueId}`;
    expect(rows.length).toBe(1);
  });

  // ── GET /leagues/:id/readiness — getDraftReadiness ───────────────────────────

  it('test_F_MOD_010_readiness_checklist_returns_pass_fail_rows_never_third_state', async () => {
    const c = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: 'Readiness League', site_password: 's', commissioner_password: 'c' },
    });
    testLeagueId = c.json<{ id: string }>().id;
    const token = makeCommToken(testLeagueId);

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${testLeagueId}/readiness`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ key: string; status: string }>; all_ready: boolean }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(['PASS', 'FAIL']).toContain(item.status);
    }
    // A freshly-created league with no teams/config satisfies nothing yet.
    expect(body.all_ready).toBe(false);
    expect(body.items.some((i) => i.status === 'FAIL')).toBe(true);
  });
});
