/**
 * F-MOD-011: Commissioner Draft Control Live-Operation UI — REST + WS layer.
 *
 * Behavioral expectations tested (screen-information-architecture.md §9.1/§9.2/§9.6,
 * PRD.md §30). Pause/resume and Manual/Auto-Agent toggle reuse MOD-002/MOD-004
 * endpoints already covered by their own suites — not re-tested here.
 *
 * Tests run against a real database and real HTTP/WebSocket server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

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

function waitForMessage(
  ws: WebSocket,
  predicate?: (msg: { type: string; payload?: Record<string, unknown> }) => boolean,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string; payload?: Record<string, unknown> };
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe.skipIf(SKIP_DB)('F-MOD-011 commissioner draft control', () => {
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
  let player2EntryId = '';

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
    const tag = Date.now();
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F011-Test-${tag}`, site_password: 's', commissioner_password: 'c' },
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
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });
    team2Token = makeToken({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2!.auth_epoch });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
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
      INSERT INTO players (name, position, nfl_team) VALUES (${`F011-P1-${tag}`}, 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES (${`F011-P2-${tag}`}, 'QB', 'KC') RETURNING id
    `;
    playerIds = [p1!.id, p2!.id];

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, tier, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 1, 'CSV')
    `;
    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, tier, source)
      VALUES (${datasetId}, ${p2!.id}, 3000, 2, 'CSV')
    `;
    player1EntryId = p1!.id;
    player2EntryId = p2!.id;

    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

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
      await sql`DELETE FROM player_aav_sources WHERE player_id = ANY(${playerIds})`;
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

  async function nominate(ws: WebSocket, playerEntryId: string, openingBid = 100): Promise<string> {
    const [nom] = await Promise.all([
      waitForMessage(ws, (m) => m.type === 'NOMINATION_STARTED'),
      Promise.resolve().then(() =>
        ws.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: openingBid },
        })),
      ),
    ]);
    return String(nom.payload?.['player_auction_id'] ?? '');
  }

  // ─── Timer extend ─────────────────────────────────────────────────────────

  it('test_F_MOD_011_timer_extend_moves_deadline_and_bumps_version', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const auctionId = await nominate(ws1, player1EntryId);

    const [before] = await sql<[{ rebid_deadline: Date; auction_version: number }]>`
      SELECT rebid_deadline, auction_version FROM player_auctions WHERE id = ${auctionId}
    `;

    const broadcastPromise = waitForMessage(ws1, (m) => m.type === 'AUCTION_DEADLINE_EXTENDED');
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/timers/extend`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { seconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ player_auction_id: string; new_deadline_at: string; auction_version: number }>();
    expect(body.player_auction_id).toBe(auctionId);
    expect(body.auction_version).toBe(before!.auction_version + 1);

    const newDeadline = new Date(body.new_deadline_at).getTime();
    const oldDeadline = new Date(before!.rebid_deadline).getTime();
    expect(newDeadline).toBeGreaterThanOrEqual(oldDeadline + 29000);

    const broadcast = await broadcastPromise;
    expect(broadcast.payload?.['player_auction_id']).toBe(auctionId);
    expect(broadcast.payload?.['auction_version']).toBe(before!.auction_version + 1);

    ws1.close();
  }, 10000);

  it('test_F_MOD_011_timer_extend_rejected_when_no_open_auction', async () => {
    await setupDraft();
    const [before] = await sql<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt FROM draft_events WHERE draft_id = ${draftId}
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/timers/extend`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { seconds: 30 },
    });
    expect(res.statusCode).toBe(409);

    const [after] = await sql<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt FROM draft_events WHERE draft_id = ${draftId}
    `;
    expect(after!.cnt).toBe(before!.cnt);
  });

  it('test_F_MOD_011_timer_extend_forbidden_for_owner', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/timers/extend`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { seconds: 30 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_011_timer_extend_forbidden_for_wrong_league', async () => {
    await setupDraft();
    const otherLeagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F011-Other-${Date.now()}`, site_password: 's', commissioner_password: 'c' },
    });
    const otherLeagueId = otherLeagueRes.json<{ id: string }>().id;
    const wrongToken = makeToken({ league_id: otherLeagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/timers/extend`,
      headers: { authorization: `Bearer ${wrongToken}` },
      payload: { seconds: 30 },
    });
    expect(res.statusCode).toBe(403);

    await sql`DELETE FROM leagues WHERE id = ${otherLeagueId}`;
  });

  // ─── Budget adjustment ────────────────────────────────────────────────────

  it('test_F_MOD_011_budget_adjustment_applies_exact_delta_and_appends_ledger', async () => {
    await setupDraft();
    const broadcastPromise = new Promise<{ type: string; payload?: Record<string, unknown> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: team1Token } })));
      let gotSnapshot = false;
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString()) as { type: string; payload?: Record<string, unknown> };
        if (!gotSnapshot && msg.type === 'STATE_SNAPSHOT') { gotSnapshot = true; return; }
        if (msg.type === 'BUDGET_ADJUSTED') { ws.close(); resolve(msg); }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out')), 5000);
    });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/budget-adjustment`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { delta_minor: -500, reason: 'Whammy penalty override' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ team_id: string; new_remaining_budget_minor: number }>();
    expect(body.team_id).toBe(team1Id);
    expect(body.new_remaining_budget_minor).toBe(20000 - 500);

    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state!.remaining_budget_minor).toBe(19500);

    const [ledger] = await sql<[{ amount_minor: number; entry_type: string }]>`
      SELECT amount_minor, entry_type FROM budget_ledger_entries
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(ledger!.amount_minor).toBe(-500);
    expect(ledger!.entry_type).toBe('COMMISSIONER_ADJUSTMENT');

    const broadcast = await broadcastPromise;
    expect(broadcast.payload?.['new_remaining_budget_minor']).toBe(19500);
  }, 10000);

  it('test_F_MOD_011_budget_adjustment_rejects_missing_reason', async () => {
    await setupDraft();
    const [before] = await sql<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt FROM budget_ledger_entries WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/budget-adjustment`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { delta_minor: -500, reason: '' },
    });
    expect(res.statusCode).toBe(400);

    const [after] = await sql<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt FROM budget_ledger_entries WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(after!.cnt).toBe(before!.cnt);
  });

  it('test_F_MOD_011_budget_adjustment_forbidden_for_owner', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/budget-adjustment`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { delta_minor: -500, reason: 'test' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Reassign open auction ────────────────────────────────────────────────

  it('test_F_MOD_011_reassign_changes_player_on_open_auction', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const auctionId = await nominate(ws1, player1EntryId);

    const broadcastPromise = waitForMessage(ws1, (m) => m.type === 'AUCTION_REASSIGNED');
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/auctions/current/reassign`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { new_player_dataset_entry_id: player2EntryId },
    });
    expect(res.statusCode).toBe(200);

    const [auction] = await sql<[{ dataset_player_id: string; auction_version: number }]>`
      SELECT dataset_player_id, auction_version FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction!.dataset_player_id).toBe(player2EntryId);
    expect(auction!.auction_version).toBe(2);

    const broadcast = await broadcastPromise;
    expect(broadcast.payload?.['player_auction_id']).toBe(auctionId);

    ws1.close();
  }, 10000);

  it('test_F_MOD_011_reassign_manually_awards_to_team', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const auctionId = await nominate(ws1, player1EntryId);

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/auctions/current/reassign`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { award_to_team_id: team2Id, award_price_minor: 750 },
    });
    expect(res.statusCode).toBe(200);

    const [auction] = await sql<[{ current_leader_id: string; current_bid_minor: number }]>`
      SELECT current_leader_id, current_bid_minor FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction!.current_leader_id).toBe(team2Id);
    expect(auction!.current_bid_minor).toBe(750);

    ws1.close();
  }, 10000);

  it('test_F_MOD_011_reassign_rejected_when_no_open_auction', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/auctions/current/reassign`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { award_to_team_id: team2Id, award_price_minor: 750 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('test_F_MOD_011_reassign_forbidden_for_owner', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/auctions/current/reassign`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { award_to_team_id: team2Id, award_price_minor: 750 },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Draft Health ─────────────────────────────────────────────────────────

  it('test_F_MOD_011_health_panel_reports_status_and_connection_counts', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/health`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      auctions_completed: number;
      connected_team_count: number;
      auto_agent_team_count: number;
      reconnecting_team_count: number;
      current_player_auction_id: string | null;
      warnings: string[];
    }>();
    expect(body.status).toBe('RUNNING');
    expect(body.auctions_completed).toBe(0);
    expect(body.connected_team_count).toBe(2);
    expect(body.auto_agent_team_count).toBe(0);
    expect(body.reconnecting_team_count).toBe(0);
    expect(body.current_player_auction_id).toBeNull();
    expect(Array.isArray(body.warnings)).toBe(true);

    ws1.close();
    ws2.close();
  }, 10000);

  it('test_F_MOD_011_health_reflects_current_open_auction', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const auctionId = await nominate(ws1, player1EntryId);

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/health`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const body = res.json<{ current_player_auction_id: string | null; current_deadline_at: string | null }>();
    expect(body.current_player_auction_id).toBe(auctionId);
    expect(body.current_deadline_at).not.toBeNull();

    ws1.close();
  }, 10000);

  it('test_F_MOD_011_health_forbidden_for_owner', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/health`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Audit log ────────────────────────────────────────────────────────────

  it('test_F_MOD_011_audit_log_includes_module_actions_most_recent_first', async () => {
    await setupDraft();

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/pause`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/resume`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/budget-adjustment`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { delta_minor: 100, reason: 'audit test' },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/audit-log`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ event_type: string; occurred_at: string }>; next_cursor: string | null }>();

    const types = body.entries.map((e) => e.event_type);
    expect(types).toContain('DRAFT_PAUSED');
    expect(types).toContain('DRAFT_RESUMED');
    expect(types).toContain('BUDGET_ADJUSTED');

    // Most-recent-first
    const budgetIdx = types.indexOf('BUDGET_ADJUSTED');
    const resumeIdx = types.indexOf('DRAFT_RESUMED');
    const pauseIdx = types.indexOf('DRAFT_PAUSED');
    expect(budgetIdx).toBeLessThan(resumeIdx);
    expect(resumeIdx).toBeLessThan(pauseIdx);
  });

  it('test_F_MOD_011_audit_log_forbidden_for_owner', async () => {
    await setupDraft();
    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/audit-log`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Commissioner override: nominate/bid on behalf of a team ─────────────

  it('test_F_MOD_011_on_behalf_of_nominate_attributed_to_target_team', async () => {
    await setupDraft();
    const wsComm = await connectAndAuth(serverPort, draftId, commToken);

    const [nom] = await Promise.all([
      waitForMessage(wsComm, (m) => m.type === 'NOMINATION_STARTED'),
      Promise.resolve().then(() =>
        wsComm.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: {
            player_dataset_entry_id: player1EntryId,
            opening_bid_minor: 100,
            on_behalf_of_team_id: team2Id,
          },
        })),
      ),
    ]);

    expect(nom.payload?.['nominator_team_id']).toBe(team2Id);

    const [auction] = await sql<[{ nominator_team_id: string }]>`
      SELECT nominator_team_id FROM player_auctions WHERE id = ${String(nom.payload?.['player_auction_id'])}
    `;
    expect(auction!.nominator_team_id).toBe(team2Id);

    wsComm.close();
  }, 10000);

  it('test_F_MOD_011_on_behalf_of_bid_accepted_and_attributed_to_target_team', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const wsComm = await connectAndAuth(serverPort, draftId, commToken);
    const auctionId = await nominate(ws1, player1EntryId);

    const [bidResult] = await Promise.all([
      waitForMessage(wsComm, (m) => m.type === 'BID_ACCEPTED'),
      Promise.resolve().then(() =>
        wsComm.send(JSON.stringify({
          type: 'BID_COMMAND',
          payload: {
            player_auction_id: auctionId,
            bid_amount_minor: 200,
            bid_type: 'ABSOLUTE',
            on_behalf_of_team_id: team2Id,
          },
        })),
      ),
    ]);

    expect(bidResult.payload?.['leading_team_id']).toBe(team2Id);

    const [auction] = await sql<[{ current_leader_id: string; current_bid_minor: number }]>`
      SELECT current_leader_id, current_bid_minor FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction!.current_leader_id).toBe(team2Id);
    expect(auction!.current_bid_minor).toBe(200);

    ws1.close();
    wsComm.close();
  }, 10000);

  it('test_F_MOD_011_on_behalf_of_rejected_for_non_commissioner', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const auctionId = await nominate(ws1, player1EntryId);

    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);
    const [errorMsg] = await Promise.all([
      waitForMessage(ws2, (m) => m.type === 'ERROR' || m.type === 'BID_REJECTED' || m.type === 'BID_ACCEPTED'),
      Promise.resolve().then(() =>
        ws2.send(JSON.stringify({
          type: 'BID_COMMAND',
          payload: {
            player_auction_id: auctionId,
            bid_amount_minor: 200,
            bid_type: 'ABSOLUTE',
            on_behalf_of_team_id: team1Id,
          },
        })),
      ),
    ]);

    // Must not be silently accepted attributed to team1 — either rejected outright
    // or (at minimum) never leaves team1 as the leader via team2's request.
    expect(errorMsg.type).not.toBe('BID_ACCEPTED');

    const [auction] = await sql<[{ current_leader_id: string }]>`
      SELECT current_leader_id FROM player_auctions WHERE id = ${auctionId}
    `;
    // Leadership must remain with the actual nominator (team1), not shift to
    // team2 (the sender) using team1's identity, and team2 must not have
    // successfully impersonated team1 either.
    expect(auction!.current_leader_id).toBe(team1Id);

    ws1.close();
    ws2.close();
  }, 10000);
});
