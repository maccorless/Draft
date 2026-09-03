/**
 * F-MOD-010: War Room / Draft Room read endpoints
 *   GET /drafts/:draftId/roster-grid
 *   GET /drafts/:draftId/config
 *   GET /drafts/:draftId/activity
 * Plus the enriched STATE_SNAPSHOT.current_auction (player details for reconnect).
 *
 * Tests run against a real database and real HTTP/WebSocket server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

async function connectAndAuth(port: number, draftId: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token } }));
    });
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'STATE_SNAPSHOT') resolve();
      else reject(new Error(`Expected STATE_SNAPSHOT, got ${msg.type}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connectAndAuth timed out')), 5000);
  });
  return ws;
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    ws.once('message', (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe.skipIf(SKIP_DB)('F-MOD-010 War Room read endpoints', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  let leagueId = '';
  let team1Id = '';
  let team2Id = '';
  let datasetId = '';
  let draftId = '';
  let commToken = '';
  let team1Token = '';
  let team2Token = '';
  let playerIds: string[] = [];
  let player1EntryId = '';

  function makeToken(payload: object): string {
    return server.jwt.sign(payload);
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
  }, 15000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  async function setupDraft(): Promise<void> {
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F010 Test ${Date.now()}`, site_password: 's', commissioner_password: 'c' },
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

    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const [e2] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team2Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1.auth_epoch });
    team2Token = makeToken({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2.auth_epoch });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
          { position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
        ],
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

    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F010-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    playerIds = [p1!.id];

    const [en1] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, tier, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 1, 'CSV') RETURNING id
    `;
    player1EntryId = en1!.id;

    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;
  }

  afterEach(async () => {
    if (!draftId) return;
    await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    if (playerIds.length > 0) {
      await sql`DELETE FROM player_dataset_entries WHERE player_id = ANY(${playerIds})`;
    }
    await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    if (playerIds.length > 0) {
      await sql`DELETE FROM players WHERE id = ANY(${playerIds})`;
    }
    await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
      SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
    )`;
    await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    draftId = '';
    playerIds = [];
  });

  it('test_F_MOD_010_config_returns_roster_slots_and_auction_settings', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/config`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      roster: { total_roster_size: number; bench_slots: number };
      roster_slots: Array<{ position: string; is_starter: boolean; slot_count: number }>;
      auction: { initial_budget_minor: number; min_bid_minor: number };
    }>();
    expect(body.roster.bench_slots).toBe(0);
    expect(body.roster_slots.map((s) => s.position)).toEqual(['QB', 'RB', 'BN']);
    expect(body.auction.initial_budget_minor).toBe(20000);
    expect(body.auction.min_bid_minor).toBe(100);
  });

  it('test_F_MOD_010_roster_grid_returns_all_teams_before_any_picks', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/roster-grid`,
      headers: { authorization: `Bearer ${team2Token}` }, // team2 reading team1's public info — must work
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      teams: Array<{
        team_id: string;
        team_name: string;
        remaining_budget_minor: number;
        max_legal_bid_minor: number;
        control_mode: string;
        slots: Array<{ position: string; filled: number; total: number }>;
      }>;
    }>();
    expect(body.teams.length).toBe(2);
    const alpha = body.teams.find((t) => t.team_id === team1Id)!;
    expect(alpha.team_name).toBe('Alpha');
    expect(alpha.remaining_budget_minor).toBe(20000);
    expect(alpha.control_mode).toBe('MANUAL');
    const qbSlot = alpha.slots.find((s) => s.position === 'QB')!;
    expect(qbSlot).toEqual({ position: 'QB', is_starter: true, filled: 0, total: 1 });
    // required_remaining_spots at draft start = total roster spots (QB 1 + RB 2 + BN 6 = 9)
    // -> max legal bid = budget - (9-1)*100
    expect(alpha.max_legal_bid_minor).toBe(20000 - 800);
  });

  it('test_F_MOD_010_roster_grid_and_activity_reflect_awarded_pick', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const [nom1] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
        })),
      ),
    ]);
    const auctionId = String(nom1.payload?.['player_auction_id'] ?? '');

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;
    const [award1] = await Promise.all([waitForMessage(ws1, 4000), waitForMessage(ws2, 4000)]);
    expect(award1.type).toBe('PLAYER_AWARDED');

    // An award always advances the nomination turn (own transaction, after the
    // PLAYER_AWARDED broadcast) — wait for it so cleanup doesn't race a
    // still-in-flight draft_events insert against DELETE FROM drafts.
    await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);
    ws1.close();
    ws2.close();

    const gridRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/roster-grid`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    const grid = gridRes.json<{ teams: Array<{ team_id: string; remaining_budget_minor: number; slots: Array<{ position: string; filled: number }> }> }>();
    const alpha = grid.teams.find((t) => t.team_id === team1Id)!;
    expect(alpha.remaining_budget_minor).toBe(19900);
    expect(alpha.slots.find((s) => s.position === 'QB')!.filled).toBe(1);

    const activityRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/activity`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(activityRes.statusCode).toBe(200);
    const activity = activityRes.json<{ recent: Array<{ player_name: string; team_id: string; price_minor: number; bid_count: number }> }>();
    expect(activity.recent.length).toBe(1);
    expect(activity.recent[0]!.player_name).toBe('F010-Josh-Allen');
    expect(activity.recent[0]!.team_id).toBe(team1Id);
    expect(activity.recent[0]!.price_minor).toBe(100);
    // Nomination sets the opening price directly — no bid_attempts row is written
    // unless a competing BID_COMMAND is placed, which this test doesn't send.
    expect(activity.recent[0]!.bid_count).toBe(0);
  }, 10000);

  it('test_F_MOD_010_nomination_turn_advances_to_next_team_after_award', async () => {
    // Regression test: an award previously never advanced nomination_cursor,
    // so the same team could nominate forever — this pins the fix.
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const [nom1] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
        })),
      ),
    ]);
    const auctionId = String(nom1.payload?.['player_auction_id'] ?? '');

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;
    await Promise.all([waitForMessage(ws1, 4000), waitForMessage(ws2, 4000)]); // PLAYER_AWARDED

    const [turnChanged1, turnChanged2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
    ]);
    expect(turnChanged1.type).toBe('NOMINATION_TURN_CHANGED');
    expect(turnChanged1.payload?.['current_nominator_team_id']).toBe(team2Id);
    expect(turnChanged2.payload?.['current_nominator_team_id']).toBe(team2Id);
    ws1.close();
    ws2.close();

    // A fresh connection (no NOMINATION_TURN_CHANGED heard live) must also see
    // the correct next nominator from the snapshot alone.
    const ws3 = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    const snapshot = await new Promise<{ payload: Record<string, unknown> }>((resolve, reject) => {
      ws3.on('open', () => {
        ws3.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: team2Token } }));
      });
      ws3.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'STATE_SNAPSHOT') resolve(msg);
      });
      setTimeout(() => reject(new Error('timed out')), 4000);
    });
    expect(snapshot.payload['current_nominator_team_id']).toBe(team2Id);
    ws3.close();
  }, 10000);

  it('test_F_MOD_010_roster_grid_rejects_token_from_a_different_league', async () => {
    await setupDraft();
    // A valid, non-revoked token for a *different real* league must be rejected
    // with a league-mismatch 403, not the draft's own league's 401.
    const otherLeagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F010 Other League ${Date.now()}`, site_password: 's', commissioner_password: 'c' },
    });
    const otherLeagueId = otherLeagueRes.json<{ id: string }>().id;
    const otherLeagueToken = makeToken({ league_id: otherLeagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/roster-grid`,
      headers: { authorization: `Bearer ${otherLeagueToken}` },
    });
    expect(res.statusCode).toBe(403);

    await sql`DELETE FROM leagues WHERE id = ${otherLeagueId}`;
  });

  it('test_F_MOD_010_roster_grid_missing_token_returns_401', async () => {
    await setupDraft();
    const res = await server.inject({ method: 'GET', url: `/drafts/${draftId}/roster-grid` });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_010_state_snapshot_includes_player_details_for_open_auction', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    await new Promise<void>((resolve, reject) => {
      ws1.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
      }));
      ws1.once('message', () => resolve());
      setTimeout(() => reject(new Error('timed out')), 4000);
    });

    // A fresh connection (simulating reconnect/War Room load) must see player details
    // in the snapshot alone, without waiting for a NOMINATION_STARTED broadcast.
    const ws2 = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    const snapshot = await new Promise<{ payload: Record<string, unknown> }>((resolve, reject) => {
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: team2Token } }));
      });
      ws2.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'STATE_SNAPSHOT') resolve(msg);
      });
      setTimeout(() => reject(new Error('timed out')), 4000);
    });

    const currentAuction = snapshot.payload['current_auction'] as Record<string, unknown>;
    expect(currentAuction).toBeTruthy();
    expect(currentAuction['player_name']).toBe('F010-Josh-Allen');
    expect(currentAuction['position']).toBe('QB');
    expect(currentAuction['nfl_team']).toBe('BUF');
    expect(currentAuction['aav_minor']).toBe(5000);
    expect(currentAuction['tier']).toBe(1);
    expect(currentAuction['nominator_team_id']).toBe(team1Id);

    ws1.close();
    ws2.close();
  }, 10000);
});
