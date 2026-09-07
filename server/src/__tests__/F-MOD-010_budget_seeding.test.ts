/**
 * F-MOD-010-rework-01 item 3 (draft-start budget seeding half of the bug):
 * POST /drafts/:draftId/start previously seeded every team's
 * draft_team_states.remaining_budget_minor from auction_configurations
 * .initial_budget_minor uniformly, ignoring teams.starting_budget_override_minor.
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

describe.skipIf(SKIP_DB)('F-MOD-010 draft-start budget seeding', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let leagueId = '';
  let draftId = '';
  let datasetId = '';

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
    if (draftId) {
      await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM drafts WHERE id = ${draftId}`;
      draftId = '';
    }
    if (datasetId) {
      await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
      datasetId = '';
    }
    if (leagueId) {
      await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
        SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
      )`;
      await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
      leagueId = '';
    }
  });

  it('test_F_MOD_010_draft_start_seeds_override_budget_for_team_with_override_and_league_budget_for_others', async () => {
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `Budget Seed ${Date.now()}`, site_password: 's', commissioner_password: 'c' },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    const commToken = server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const t1 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Overridden', team_password: 'p1', draft_order: 1 },
    });
    const overriddenTeamId = t1.json<{ id: string }>().id;

    const t2 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Default', team_password: 'p2', draft_order: 2 },
    });
    const defaultTeamId = t2.json<{ id: string }>().id;

    // Set a starting-budget override on team 1 only, via F-MOD-010's own endpoint.
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/teams/${overriddenTeamId}`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { starting_budget_override_minor: 15000 },
    });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 1,
        slots: [{ position: 'QB', priority: 1, is_starter: true, slot_count: 1 }],
      },
    });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: 20000,
        nomination_timer_ms: 60000,
        second_bid_timer_ms: 60000,
        rebid_timer_ms: 60000,
        anti_snipe_threshold_ms: 500,
        anti_snipe_extension_ms: 500,
        min_bid_minor: 100,
      },
    });

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;
    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;

    const startRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(startRes.statusCode).toBe(200);

    const rows = await sql<Array<{ team_id: string; remaining_budget_minor: number }>>`
      SELECT team_id, remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId}
    `;
    const byTeam = Object.fromEntries(rows.map((r) => [r.team_id, r.remaining_budget_minor]));

    expect(byTeam[overriddenTeamId]).toBe(15000);
    expect(byTeam[defaultTeamId]).toBe(20000);
  });
});
