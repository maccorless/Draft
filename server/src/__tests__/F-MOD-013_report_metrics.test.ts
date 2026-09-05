/**
 * F-MOD-013: Draft Summary Report metrics (PRD §36.1-36.3) — behavioral expectations.
 *
 * Tests run against a real Postgres database and real Fastify HTTP server.
 * No mocks — this exercises the full report-generation pipeline end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
process.env['SENDGRID_API_KEY'] =
  process.env['SENDGRID_API_KEY'] ?? 'test-sendgrid-key-placeholder';

const DATABASE_URL = process.env['DATABASE_URL'];
const SKIP_DB = !DATABASE_URL;

interface ReportBody {
  draft_id: string;
  completed_at: string;
  league_totals: { spend_minor: number; aav_minor: number };
  teams: Array<{
    team_id: string;
    team_name: string;
    final_budget_minor: number;
    acquisitions: Array<{ player_name: string; position: string; price_minor: number; roster_slot: string }>;
    projected_starter_points: number;
    roster_depth_score: { value: number; calculation_version: string };
    aav_efficiency_pct: number;
  }>;
}

describe.skipIf(SKIP_DB)('F-MOD-013 draft summary report metrics', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  let leagueId: string;
  let team1Id: string;
  let team2Id: string;
  let draftId: string;
  let commToken: string;
  let datasetId: string;
  let p1Id: string;
  let p2Id: string;
  let p3Id: string;
  let p4Id: string;

  function makeToken(payload: object): string {
    return server.jwt.sign(payload);
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
  }, 20000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  /**
   * Team1 wins 2 players (P1 assigned the sole starter QB slot, P2 assigned
   * the one bench slot once the starter slot is full — a real, active
   * roster_entries row with is_starter=false). Team2 wins 2 players (P3
   * starter, P4 bench) — every team must fully fill its roster
   * (starter + bench) for the draft to auto-complete, which the report
   * endpoint requires (409 otherwise).
   *
   * Since F-MOD-002-rework-04, a bid can only ever be won when an eligible
   * slot (starter or bench) actually exists — awardAuction() now fails
   * loudly instead of silently completing an acquisition with no roster
   * slot, so this fixture must give both teams a real bench slot rather
   * than engineering the old "no slot at all" edge case (which also
   * silently kept the draft artificially "complete" one pick too early).
   *
   * AAV/price/points values are fixed literals so the expected metrics
   * below are hand-computed from the spec's formula description, not by
   * re-invoking the report code.
   */
  async function setupCompleteDraftWithMetrics(): Promise<void> {
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F013 Test ${Date.now()}`, site_password: 'site', commissioner_password: 'comm' },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    commToken = makeToken({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const t1 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Alpha', team_password: 'alpha', draft_order: 1 },
    });
    team1Id = t1.json<{ id: string }>().id;

    const t2 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Beta', team_password: 'beta', draft_order: 2 },
    });
    team2Id = t2.json<{ id: string }>().id;

    // Roster config: single starter QB slot plus one bench slot
    // (total_roster_size=2). Team1's second pick (P2) fills the bench slot
    // once the starter slot is full — a real roster_entries row with
    // is_starter=false, which reports.ts's LEFT JOIN surfaces normally.
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
        initial_budget_minor: 50000,
        nomination_timer_ms: 60000,
        second_bid_timer_ms: 5000,
        rebid_timer_ms: 5000,
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

    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F013-QB1', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F013-QB2', 'QB', 'KC') RETURNING id
    `;
    const [p3] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F013-QB3', 'QB', 'SF') RETURNING id
    `;
    const [p4] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F013-QB4', 'QB', 'DAL') RETURNING id
    `;
    p1Id = p1.id;
    p2Id = p2.id;
    p3Id = p3.id;
    p4Id = p4.id;

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, projected_points, source)
      VALUES
        (${datasetId}, ${p1Id}, 2500, 20.0, 'test'),
        (${datasetId}, ${p2Id}, 1000, 8.0, 'test'),
        (${datasetId}, ${p3Id}, 1400, 15.0, 'test'),
        (${datasetId}, ${p4Id}, 1000, 6.0, 'test')
    `;

    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    const pastDeadline = new Date(Date.now() - 10000);

    // Team1: P1 (starter, $2000) then P2 (bench — starter slot already full, $500)
    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${p1Id}, 'OPEN', 2000, ${team1Id}, 1, ${pastDeadline}, NULL)
    `;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${p2Id}, 'OPEN', 500, ${team1Id}, 1, ${pastDeadline}, NULL)
    `;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Team2: P3 (starter, $1500) then P4 (bench — starter slot already full, $300)
    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${p3Id}, 'OPEN', 1500, ${team2Id}, 1, ${pastDeadline}, NULL)
    `;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${p4Id}, 'OPEN', 300, ${team2Id}, 1, ${pastDeadline}, NULL)
    `;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  it('F_MOD_013_report_includes_projected_starter_points_roster_depth_and_aav_efficiency', async () => {
    await setupCompleteDraftWithMetrics();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<ReportBody>();

    const team1 = body.teams.find((t) => t.team_id === team1Id)!;
    const team2 = body.teams.find((t) => t.team_id === team2Id)!;
    expect(team1).toBeDefined();
    expect(team2).toBeDefined();

    // Team1: P1 (starter, 20 pts) + P2 (bench, 8 pts). Starter points exclude bench.
    expect(team1.projected_starter_points).toBeCloseTo(20, 5);
    expect(team1.roster_depth_score.value).toBeCloseTo(8, 5);
    expect(team1.roster_depth_score.calculation_version).toBeTruthy();

    // Team2: P3 (starter, 15 pts) + P4 (bench, 6 pts). Starter points exclude bench.
    expect(team2.projected_starter_points).toBeCloseTo(15, 5);
    expect(team2.roster_depth_score.value).toBeCloseTo(6, 5);

    // AAV efficiency: (sumAav - sumPrice) / sumAav * 100
    // Team1: sumAav=3500, sumPrice=2500 -> (3500-2500)/3500*100 = 28.5714...
    expect(team1.aav_efficiency_pct).toBeCloseTo(28.5714, 3);
    // Team2: sumAav=2400, sumPrice=1800 -> (2400-1800)/2400*100 = 25
    expect(team2.aav_efficiency_pct).toBeCloseTo(25, 3);
  }, 20000);

  it('F_MOD_013_report_bench_player_points_excluded_from_starter_sum', async () => {
    await setupCompleteDraftWithMetrics();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const body = res.json<ReportBody>();
    const team1 = body.teams.find((t) => t.team_id === team1Id)!;

    // P2's 8 points must not be folded into the 20-point starter sum.
    expect(team1.projected_starter_points).not.toBeCloseTo(28, 1);
  }, 20000);

  it('F_MOD_013_report_includes_league_wide_spend_vs_aav_totals', async () => {
    await setupCompleteDraftWithMetrics();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const body = res.json<ReportBody>();

    // spend: 2000 + 500 + 1500 + 300 = 4300; aav: 2500 + 1000 + 1400 + 1000 = 5900
    expect(body.league_totals.spend_minor).toBe(4300);
    expect(body.league_totals.aav_minor).toBe(5900);
  }, 20000);

  it('F_MOD_013_report_still_returns_409_for_non_complete_draft', async () => {
    // Reuses the existing setup steps but without starting/completing the draft.
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F013 Incomplete ${Date.now()}`, site_password: 'site', commissioner_password: 'comm' },
    });
    const incompleteLeagueId = leagueRes.json<{ id: string }>().id;
    const token = makeToken({ league_id: incompleteLeagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${incompleteLeagueId}/datasets`,
      headers: { authorization: `Bearer ${token}` },
    });
    const incompleteDatasetId = dsRes.json<{ id: string }>().id;
    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${incompleteDatasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${incompleteLeagueId}/drafts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { dataset_id: incompleteDatasetId },
    });
    const incompleteDraftId = draftRes.json<{ id: string }>().id;

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${incompleteDraftId}/report`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  }, 15000);
});
