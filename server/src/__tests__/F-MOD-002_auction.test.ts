/**
 * F-MOD-002: Live Auction Engine — behavioral expectations
 *
 * Tests run against a real database and real HTTP/WebSocket server.
 * No mocks — this exercises the full bid pipeline end to end.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';
import { computeMaxLegalBid, stopAwardTimer } from '../auction/engine.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function connectAndAuth(
  port: number,
  draftId: string,
  token: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token } }));
    });
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      // F-MOD-003 changed auth confirmation from AUTHENTICATED → STATE_SNAPSHOT
      if (msg.type === 'AUTHENTICATED' || msg.type === 'STATE_SNAPSHOT') resolve();
      else reject(new Error(`Expected AUTHENTICATED or STATE_SNAPSHOT, got ${msg.type}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connectAndAuth timed out')), 5000);
  });
  return ws;
}

async function sendAndReceive(
  ws: WebSocket,
  message: object,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`sendAndReceive timed out waiting for response to ${JSON.stringify(message)}`)),
      timeoutMs,
    );
    ws.once('message', (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(message));
  });
}

async function waitForMessage(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('waitForMessage timed out')),
      timeoutMs,
    );
    ws.once('message', (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-002 auction engine', () => {
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
  // Track player UUIDs so cleanup is reliable
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

  async function setupDraft(
    opts: { antiSnipeThresholdMs?: number; nominationTimerMs?: number } = {},
  ): Promise<void> {
    // League
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F002 Test ${Date.now()}`,
        site_password: 's',
        commissioner_password: 'c',
      },
    });
    leagueId = leagueRes.json<{ id: string }>().id;

    commToken = makeToken({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    // Teams
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

    // Roster config (include bench as a slot definition)
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
          { position: 'WR', priority: 3, is_starter: true, slot_count: 2 },
          { position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
        ],
      },
    });

    // Auction config — use large anti_snipe_threshold_ms for anti-snipe tests
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: 20000,
        nomination_timer_ms: opts.nominationTimerMs ?? 60000,
        second_bid_timer_ms: 60000,
        rebid_timer_ms: 60000,
        anti_snipe_threshold_ms: opts.antiSnipeThresholdMs ?? 500,
        anti_snipe_extension_ms: 500,
        min_bid_minor: 100,
      },
    });

    // Dataset
    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    // Insert 2 players (QB + RB for testing roster assignment)
    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F002-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F002-CMC', 'RB', 'SF') RETURNING id
    `;
    playerIds = [p1!.id, p2!.id];

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 'CSV')
    `;
    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p2!.id}, 4500, 'CSV')
    `;
    // Now equal to the player's own id (F-MOD-016): dataset_player_id FKs to players.id.
    player1EntryId = p1!.id;

    // Freeze dataset
    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

    // Draft
    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;
  }

  afterEach(async () => {
    if (!leagueId) return;
    // Stop award timer first — prevents concurrent acquisitions INSERT racing the cleanup
    if (draftId) stopAwardTimer(draftId);
    // Pause draft in DB so no in-flight timer cycle awards anything
    if (draftId) {
      await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId} AND status = 'RUNNING'`;
    }
    // Clean in strict FK order
    await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM nomination_queue_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM do_not_draft_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    // Delete entries by player_id (covers all datasets — clean by UUID, not name)
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

    leagueId = '';
    team1Id = '';
    team2Id = '';
    datasetId = '';
    draftId = '';
    playerIds = [];
    player1EntryId = '';
  });

  // ── REST: Draft lifecycle ─────────────────────────────────────────────────

  it('test_F_MOD_002_start_draft_transitions_CREATED_to_RUNNING_and_appends_event', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ draft_id: string; status: string }>();
    expect(body.status).toBe('RUNNING');
    expect(body.draft_id).toBe(draftId);

    const [draft] = await sql<[{ status: string }]>`SELECT status FROM drafts WHERE id = ${draftId}`;
    expect(draft.status).toBe('RUNNING');

    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events WHERE draft_id = ${draftId}
    `;
    expect(events.some((e) => e.event_type === 'DRAFT_STARTED')).toBe(true);
  });

  it('test_F_MOD_002_start_draft_non_commissioner_returns_403_draft_stays_CREATED', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);

    const [draft] = await sql<[{ status: string }]>`SELECT status FROM drafts WHERE id = ${draftId}`;
    expect(draft.status).toBe('CREATED');
  });

  it('test_F_MOD_002_start_draft_initializes_draft_team_states_with_correct_budget', async () => {
    await setupDraft();

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    const states = await sql<[{
      team_id: string;
      remaining_budget_minor: number;
      required_remaining_spots: number;
    }]>`
      SELECT team_id, remaining_budget_minor, required_remaining_spots
      FROM draft_team_states WHERE draft_id = ${draftId}
    `;
    // 2 teams each get state rows
    expect(states.length).toBe(2);
    // initial_budget_minor = 20000
    expect(states.every((s) => s.remaining_budget_minor === 20000)).toBe(true);
    // total_roster_size = QB(1) + RB(2) + WR(2) + BN(6) = 11
    expect(states.every((s) => s.required_remaining_spots === 11)).toBe(true);
  });

  it('test_F_MOD_002_pause_and_resume_append_events_and_transition_status', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const pauseRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/pause`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json<{ status: string }>().status).toBe('PAUSED');

    const resumeRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/resume`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json<{ status: string }>().status).toBe('RUNNING');

    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events WHERE draft_id = ${draftId} ORDER BY sequence
    `;
    const types = events.map((e) => e.event_type);
    expect(types).toContain('DRAFT_STARTED');
    expect(types).toContain('DRAFT_PAUSED');
    expect(types).toContain('DRAFT_RESUMED');
  });

  it('test_F_MOD_002_starting_already_running_draft_returns_409', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });
    const res = await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });
    expect(res.statusCode).toBe(409);
  });

  // ── WS: Authentication ────────────────────────────────────────────────────

  it('test_F_MOD_002_ws_authenticate_sends_AUTHENTICATED_on_valid_token', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws = await connectAndAuth(serverPort, draftId, team1Token);
    // F-MOD-003: auth confirmation is now STATE_SNAPSHOT (connectAndAuth accepts both)
    ws.close();
  });

  it('test_F_MOD_002_ws_closes_4401_on_invalid_jwt', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: 'not-a-valid-jwt' } }));
      });
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(4401);
  });

  it('test_F_MOD_002_ws_closes_4401_when_auth_epoch_is_stale', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const [t1Row] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const staleToken = makeToken({
      league_id: leagueId,
      team_id: team1Id,
      role: 'OWNER',
      auth_epoch: t1Row.auth_epoch + 99,
    });

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: staleToken } })));
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(4401);
  });

  it('test_F_MOD_002_ws_closes_4401_on_wrong_league_in_token', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const wrongToken = makeToken({
      league_id: '00000000-0000-0000-0000-000000000099',
      team_id: team1Id,
      role: 'OWNER',
      auth_epoch: 0,
    });

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: wrongToken } })));
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(4401);
  });

  // ── WS: Nomination ────────────────────────────────────────────────────────

  it('test_F_MOD_002_nominate_creates_OPEN_player_auction_and_broadcasts_NOMINATION_STARTED', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Both listen before the nominate is sent
    const [msg1, msg2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 500 },
        })),
      ),
    ]);

    expect(msg1.type).toBe('NOMINATION_STARTED');
    expect(msg2.type).toBe('NOMINATION_STARTED');
    expect(msg1.payload?.['opening_bid_minor']).toBe(500);
    expect(msg1.payload?.['system_nominated']).toBe(false);
    expect(typeof msg1.payload?.['player_auction_id']).toBe('string');

    // Verify DB
    const rows = await sql<[{ status: string; current_bid_minor: number }]>`
      SELECT status, current_bid_minor FROM player_auctions
      WHERE draft_id = ${draftId} AND dataset_player_id = ${player1EntryId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('OPEN');
    expect(rows[0]!.current_bid_minor).toBe(500);

    ws1.close();
    ws2.close();
  });

  // ── WS: Bidding ───────────────────────────────────────────────────────────

  it('test_F_MOD_002_absolute_bid_accepted_persists_bid_attempt_and_broadcasts_BID_ACCEPTED', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate
    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000); // drain nom from ws2
    expect(nomResp.type).toBe('NOMINATION_STARTED');
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Both listen before team2 bids
    const [bid1, bid2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws2.send(JSON.stringify({
          type: 'BID_COMMAND',
          payload: { player_auction_id: auctionId, bid_amount_minor: 200, bid_type: 'ABSOLUTE' },
        })),
      ),
    ]);

    expect(bid1.type).toBe('BID_ACCEPTED');
    expect(bid2.type).toBe('BID_ACCEPTED');
    expect(bid1.payload?.['bid_amount_minor']).toBe(200);
    expect(bid1.payload?.['leading_team_id']).toBe(team2Id);
    // auction_version: nomination sets it to 1, bid increments to 2
    expect(bid1.payload?.['auction_version']).toBe(2);
    expect(typeof bid1.payload?.['rebid_deadline_ts']).toBe('number');
    expect(bid1.payload?.['anti_snipe_extended']).toBe(false);

    // Verify BidAttempt accepted=true
    const attempts = await sql<[{ accepted: boolean; bid_amount_minor: number }]>`
      SELECT accepted, bid_amount_minor FROM bid_attempts
      WHERE draft_id = ${draftId} AND bid_amount_minor = 200
    `;
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.accepted).toBe(true);

    // Verify DraftEvent BID_ACCEPTED
    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events WHERE draft_id = ${draftId}
    `;
    expect(events.some((e) => e.event_type === 'BID_ACCEPTED')).toBe(true);

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_bid_rejected_when_exceeds_max_legal_bid', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // max_legal_bid = 1200 - (10-1)*100 = 1200 - 900 = 300
    await sql`
      UPDATE draft_team_states
      SET remaining_budget_minor = 1200, required_remaining_spots = 10
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;

    // Bid 400 > max_legal_bid 300 → rejected
    const response = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 400, bid_type: 'ABSOLUTE' },
    });

    expect(response.type).toBe('BID_REJECTED');
    expect(response.payload?.['code']).toBe('EXCEEDS_MAX_LEGAL_BID');

    // BidAttempt must exist with accepted=false
    const attempts = await sql<[{ accepted: boolean }]>`
      SELECT accepted FROM bid_attempts
      WHERE draft_id = ${draftId} AND bid_amount_minor = 400
    `;
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.accepted).toBe(false);

    // PlayerAuction must not have changed
    const [auction] = await sql<[{ current_bid_minor: number }]>`
      SELECT current_bid_minor FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction.current_bid_minor).toBe(100); // unchanged from nomination

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_relative_bid_rejected_on_stale_auction_version', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Wrong expected_auction_version → STALE_STATE
    const response = await sendAndReceive(ws1, {
      type: 'BID_COMMAND',
      payload: {
        player_auction_id: auctionId,
        bid_amount_minor: 200,
        bid_type: 'RELATIVE',
        expected_current_bid_minor: 100,
        expected_auction_version: 999,
      },
    });

    expect(response.type).toBe('BID_REJECTED');
    expect(response.payload?.['code']).toBe('STALE_STATE');

    // Stale bid attempt recorded with accepted=false
    const attempts = await sql<[{ accepted: boolean; rejection_reason: string }]>`
      SELECT accepted, rejection_reason FROM bid_attempts
      WHERE draft_id = ${draftId} AND bid_amount_minor = 200
    `;
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.accepted).toBe(false);

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_max_legal_bid_computed_as_integer_no_floating_point', () => {
    // max_legal_bid = remaining_budget_minor - (required_remaining_spots - 1) * 100
    // independent verification with known values
    expect(computeMaxLegalBid(20000, 12)).toBe(18900);
    expect(Number.isInteger(computeMaxLegalBid(20000, 12))).toBe(true);
    expect(computeMaxLegalBid(500, 1)).toBe(500);
    expect(computeMaxLegalBid(20000, 0)).toBe(20000); // 0 spots: max(0,-1)*100=0
  });

  it('test_F_MOD_002_anti_snipe_extends_rebid_deadline_when_bid_arrives_within_threshold', async () => {
    // Use a large threshold (15s) so the deadline can be set far enough in the future
    // that the award timer doesn't fire, but still triggers anti-snipe.
    await setupDraft({ antiSnipeThresholdMs: 15000 });
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Set deadline 10s in the future — server_receipt_time will be ~now,
    // (10000ms < 15000ms threshold) → anti-snipe fires
    const originalDeadline = new Date(Date.now() + 10000);
    await sql`
      UPDATE player_auctions SET rebid_deadline = ${originalDeadline.toISOString()}
      WHERE id = ${auctionId}
    `;

    const response = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 200, bid_type: 'ABSOLUTE' },
    });
    // ws1 received BID_ACCEPTED broadcast too, but with no pending listener (it fired into the void).
    // Don't await it — set up a listener on ws1 BEFORE the bid is sent if that's needed.

    expect(response.type).toBe('BID_ACCEPTED');
    expect(response.payload?.['anti_snipe_extended']).toBe(true);

    // rebid_deadline_ts in the event must be > originalDeadline
    const newDeadlineTs = Number(response.payload?.['rebid_deadline_ts']);
    expect(newDeadlineTs).toBeGreaterThan(originalDeadline.getTime());

    // Verify in DB — postgres.js returns timestamptz as a string or Date; normalise.
    const [row] = await sql<[{ rebid_deadline: string | Date }]>`
      SELECT rebid_deadline FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(new Date(row.rebid_deadline as string | Date).getTime()).toBeGreaterThan(
      originalDeadline.getTime(),
    );

    ws1.close();
    ws2.close();
  }, 15000);

  it('test_F_MOD_002_player_awarded_after_rebid_deadline_expires_with_all_DB_rows', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate
    const [nom1, nom2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
        })),
      ),
    ]);
    expect(nom1.type).toBe('NOMINATION_STARTED');
    const auctionId = String(nom1.payload?.['player_auction_id'] ?? '');
    void nom2; // used as proof ws2 received the broadcast

    // Expire the deadline so award fires on next timer tick
    await sql`
      UPDATE player_auctions
      SET rebid_deadline = NOW() - INTERVAL '2 seconds'
      WHERE id = ${auctionId}
    `;

    // Wait for PLAYER_AWARDED (timer fires within ~500ms)
    const [award1, award2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
    ]);

    expect(award1.type).toBe('PLAYER_AWARDED');
    expect(award2.type).toBe('PLAYER_AWARDED');
    expect(award1.payload?.['winning_team_id']).toBe(team1Id);
    expect(award1.payload?.['price_minor']).toBe(100);
    expect(award1.payload?.['player_auction_id']).toBe(auctionId);
    expect(typeof award1.payload?.['resolution_sequence']).toBe('number');

    // DB: PlayerAuction → AWARDED
    const [auction] = await sql<[{ status: string }]>`SELECT status FROM player_auctions WHERE id = ${auctionId}`;
    expect(auction.status).toBe('AWARDED');

    // Acquisition row
    const acqs = await sql<[{ price_minor: number; active: boolean }]>`
      SELECT price_minor, active FROM acquisitions WHERE draft_id = ${draftId}
    `;
    expect(acqs.length).toBe(1);
    expect(acqs[0]!.price_minor).toBe(100);
    expect(acqs[0]!.active).toBe(true);

    // BudgetLedgerEntry
    const ledger = await sql<[{ amount_minor: number; entry_type: string }]>`
      SELECT amount_minor, entry_type FROM budget_ledger_entries WHERE draft_id = ${draftId}
    `;
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.amount_minor).toBe(-100);
    expect(ledger[0]!.entry_type).toBe('AWARD');

    // DraftTeamState updated
    const [state] = await sql<[{ remaining_budget_minor: number; roster_filled_count: number }]>`
      SELECT remaining_budget_minor, roster_filled_count
      FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state.remaining_budget_minor).toBe(19900);
    expect(state.roster_filled_count).toBe(1);

    // RosterEntry created
    const rosterRows = await sql<[{ active: boolean }]>`
      SELECT active FROM roster_entries WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rosterRows.length).toBe(1);
    expect(rosterRows[0]!.active).toBe(true);

    // An award always advances the nomination turn (own transaction, after the
    // PLAYER_AWARDED broadcast) — wait for it so cleanup doesn't race a
    // still-in-flight draft_events insert against DELETE FROM drafts.
    await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);

    ws1.close();
    ws2.close();
  }, 10000);

  it('test_F_MOD_002_starter_first_roster_assigns_QB_to_QB_slot_not_bench', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate Josh Allen (QB)
    const [nomMsg] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
        })),
      ),
    ]);
    const auctionId = String(nomMsg.payload?.['player_auction_id'] ?? '');

    // Expire immediately
    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    const award = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000); // drain ws2

    expect(award.type).toBe('PLAYER_AWARDED');
    // QB should go to the QB slot (priority=1, is_starter=true)
    expect(award.payload?.['roster_slot']).toBe('QB');

    // An award always advances the nomination turn (own transaction, after the
    // PLAYER_AWARDED broadcast) — wait for it so cleanup doesn't race a
    // still-in-flight draft_events insert against DELETE FROM drafts.
    await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);

    ws1.close();
    ws2.close();
  }, 15000);

  it('test_F_MOD_002_superflex_slot_accepts_any_position_including_QB', async () => {
    await setupDraft();
    // Override the default roster with a SUPERFLEX-only starter slot (no
    // dedicated QB slot) to prove SUPERFLEX genuinely accepts any position,
    // not just RB/WR/TE like FLEX.
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'SUPERFLEX', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
        ],
      },
    });
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate Josh Allen (QB) — same player used by the FLEX/starter-first test above.
    const [nomMsg] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
        })),
      ),
    ]);
    const auctionId = String(nomMsg.payload?.['player_auction_id'] ?? '');

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    const award = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);

    expect(award.type).toBe('PLAYER_AWARDED');
    expect(award.payload?.['roster_slot']).toBe('SUPERFLEX');

    await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);

    ws1.close();
    ws2.close();
  }, 10000);

  it('test_F_MOD_002_auth_epoch_revocation_returns_ERROR_on_next_command', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);

    // Nominate a player to open an auction
    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    expect(nomResp.type).toBe('NOMINATION_STARTED');
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Bump auth_epoch (simulate revocation)
    await sql`UPDATE teams SET auth_epoch = auth_epoch + 1 WHERE id = ${team1Id}`;

    // Next command should yield ERROR/close (auth_epoch is re-read every command)
    const response = await new Promise<{ type: string; payload?: Record<string, unknown> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for error/close')), 5000);
      ws1.once('message', (data: Buffer | string) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      ws1.once('close', () => {
        clearTimeout(timer);
        // If socket was closed before message, resolve with a close event
        resolve({ type: 'CLOSED' });
      });
      ws1.send(JSON.stringify({
        type: 'BID_COMMAND',
        payload: { player_auction_id: auctionId, bid_amount_minor: 200, bid_type: 'ABSOLUTE' },
      }));
    });

    // Server should send ERROR with AUTH_EPOCH_INVALID before closing
    expect(['ERROR', 'CLOSED']).toContain(response.type);
    if (response.type === 'ERROR') {
      expect(response.payload?.['code']).toBe('AUTH_EPOCH_INVALID');
    }

    ws1.close();
  }, 8000);

  it('test_F_MOD_002_draft_events_have_strictly_incrementing_sequence_per_draft', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate
    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Bid — ws1 also receives BID_ACCEPTED from broadcast but has no pending listener;
    // the message is dropped. Only check ws2's response then read DB.
    const bidResp = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 200, bid_type: 'ABSOLUTE' },
    });
    expect(bidResp.type).toBe('BID_ACCEPTED');

    const events = await sql<[{ sequence: number }]>`
      SELECT sequence FROM draft_events WHERE draft_id = ${draftId} ORDER BY sequence
    `;
    // Must be 0, 1, 2, ... (no gaps)
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(i);
    }

    ws1.close();
    ws2.close();
  });

  // ── F-MOD-002-rework-01: Auto-nomination on turn advance / timer expiry ────

  it('test_F_MOD_002_rework_01_manual_team_nomination_timer_expiry_auto_nominates_highest_aav', async () => {
    // Short nomination timer so the test can observe expiry quickly.
    await setupDraft({ nominationTimerMs: 300 });
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Neither team sends NOMINATE_COMMAND — wait for the nomination-turn timer
    // to expire and the server to auto-nominate on team1's behalf (cursor starts at 0).
    const [nom1, nom2] = await Promise.all([
      waitForMessage(ws1, 3000),
      waitForMessage(ws2, 3000),
    ]);

    expect(nom1.type).toBe('NOMINATION_STARTED');
    expect(nom2.type).toBe('NOMINATION_STARTED');
    expect(nom1.payload?.['system_nominated']).toBe(true);
    expect(nom1.payload?.['nominator_team_id']).toBe(team1Id);
    // Highest AAV among available players (player1 = 5000 > player2 = 4500), no queue entries.
    expect(nom1.payload?.['player_name']).toBe('F002-Josh-Allen');
    expect(nom1.payload?.['opening_bid_minor']).toBe(100); // min_bid_minor

    ws1.close();
    ws2.close();
  }, 8000);

  it('test_F_MOD_002_rework_01_auto_nomination_excludes_do_not_draft_players', async () => {
    await setupDraft({ nominationTimerMs: 300 });

    // Team1 blacklists the higher-AAV player (Josh Allen) — the fallback
    // selection must skip it even though it's the argmax(aav_minor) candidate.
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { player_id: player1EntryId },
    });

    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const [nom1] = await Promise.all([
      waitForMessage(ws1, 3000),
      waitForMessage(ws2, 3000),
    ]);

    expect(nom1.type).toBe('NOMINATION_STARTED');
    expect(nom1.payload?.['system_nominated']).toBe(true);
    expect(nom1.payload?.['player_name']).toBe('F002-CMC');

    ws1.close();
    ws2.close();
  }, 8000);

  it('test_F_MOD_002_rework_01_auto_nomination_prefers_nomination_queue_top_entry_over_aav_fallback', async () => {
    await setupDraft({ nominationTimerMs: 300 });

    // Queue the lower-AAV player (CMC, 4500) for team1 — should win over the
    // higher-AAV player (Josh Allen, 5000) once the nomination timer expires.
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: playerIds[1] },
    });

    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const [nom1] = await Promise.all([
      waitForMessage(ws1, 3000),
      waitForMessage(ws2, 3000),
    ]);

    expect(nom1.type).toBe('NOMINATION_STARTED');
    expect(nom1.payload?.['system_nominated']).toBe(true);
    expect(nom1.payload?.['player_name']).toBe('F002-CMC');

    ws1.close();
    ws2.close();
  }, 8000);

  it('test_F_MOD_002_rework_01_auto_agent_team_nominates_immediately_on_turn_advance_no_timer_wait', async () => {
    // Deliberately long nomination timer — proves the AUTO_AGENT path does NOT wait for it.
    await setupDraft({ nominationTimerMs: 60000 });
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // team1 nominates (team2 is still MANUAL here, so it does NOT reactive-bid).
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

    // team2 becomes AUTO_AGENT only after the nomination — by the time the
    // turn advances (post-award), team2's control_mode is AUTO_AGENT.
    await server.inject({
      method: 'PATCH',
      url: `/drafts/${draftId}/teams/${team2Id}/control-mode`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { mode: 'AUTO_AGENT' },
    });

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    // PLAYER_AWARDED, then NOMINATION_TURN_CHANGED, then — well within the 60s
    // MANUAL timer — a system NOMINATION_STARTED for team2 (AUTO_AGENT, immediate).
    const award1 = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);
    expect(award1.type).toBe('PLAYER_AWARDED');

    const turnChanged1 = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);
    expect(turnChanged1.type).toBe('NOMINATION_TURN_CHANGED');
    expect(turnChanged1.payload?.['current_nominator_team_id']).toBe(team2Id);

    const nom2 = await waitForMessage(ws1, 3000);
    await waitForMessage(ws2, 3000);
    expect(nom2.type).toBe('NOMINATION_STARTED');
    expect(nom2.payload?.['system_nominated']).toBe(true);
    expect(nom2.payload?.['nominator_team_id']).toBe(team2Id);
    expect(nom2.payload?.['player_name']).toBe('F002-CMC'); // only remaining player

    ws1.close();
    ws2.close();
  }, 15000);

  it('test_F_MOD_002_rework_01_completed_roster_team_skipped_in_nomination_turn_advance', async () => {
    await setupDraft({ nominationTimerMs: 60000 });

    // Add a third team so we can prove skip logic (not just normal round robin).
    const t3 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Gamma', team_password: 'gamma', draft_order: 3 },
    });
    const team3Id = t3.json<{ id: string }>().id;

    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    // Simulate team2 already having a completed roster.
    await sql`
      UPDATE draft_team_states SET required_remaining_spots = 0
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);

    // team1 (cursor 0) passes — advance should skip team2 (completed) and land on team3.
    const turnChanged = await sendAndReceive(ws1, { type: 'PASS_NOMINATION', payload: {} });
    expect(turnChanged.type).toBe('NOMINATION_TURN_CHANGED');
    expect(turnChanged.payload?.['current_nominator_team_id']).toBe(team3Id);

    ws1.close();

    // team3 is cleaned up by afterEach's `DELETE FROM teams WHERE league_id = ...`.
  }, 10000);

  // ── F-MOD-002-rework-02: dollar-formatted BID_REJECTED reasons ────────────
  // UF-01-03 item 1: engine.ts interpolated raw *_minor cents directly into
  // user-facing "reason" strings (e.g. "Bid 2600 must exceed current 2600").
  // Every reason that embeds a money amount must be formatted as whole
  // dollars (e.g. "$26"), matching the client's formatMoney convention —
  // no raw *_minor integer should ever reach a user-facing message.

  it('test_F_MOD_002_rework_02_bid_too_low_reason_is_dollar_formatted_not_raw_minor', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 2600 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // bid_amount_minor === current_bid_minor (2600) — the exact "legitimate
    // race" shape called out in the feedback (BID_TOO_LOW with equal amounts).
    const response = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 2600, bid_type: 'ABSOLUTE' },
    });

    expect(response.type).toBe('BID_REJECTED');
    expect(response.payload?.['code']).toBe('BID_TOO_LOW');
    const reason = String(response.payload?.['reason'] ?? '');
    // Dollar-formatted (2600 minor -> $26), never the raw minor integer.
    expect(reason).toContain('$26');
    expect(reason).not.toContain('2600');

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_rework_02_exceeds_max_legal_bid_reason_is_dollar_formatted_not_raw_minor', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // max_legal_bid = 1200 - (10-1)*100 = 300
    await sql`
      UPDATE draft_team_states
      SET remaining_budget_minor = 1200, required_remaining_spots = 10
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;

    const response = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 400, bid_type: 'ABSOLUTE' },
    });

    expect(response.type).toBe('BID_REJECTED');
    expect(response.payload?.['code']).toBe('EXCEEDS_MAX_LEGAL_BID');
    const reason = String(response.payload?.['reason'] ?? '');
    expect(reason).toContain('$4'); // 400 minor -> $4
    expect(reason).toContain('$3'); // max_legal_bid 300 minor -> $3
    expect(reason).not.toContain('400');
    expect(reason).not.toContain('300');

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_rework_02_nominate_opening_bid_too_low_reason_is_dollar_formatted', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);

    // min_bid_minor is 100 ($1) per setupDraft's auction config — nominate below it.
    const response = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 50 },
    });

    expect(response.type).toBe('ERROR');
    const reason = String(response.payload?.['reason'] ?? '');
    expect(reason).toContain('$1');
    expect(reason).not.toContain('100');

    ws1.close();
  });

  // ── F-MOD-002-rework-02: live-effect configuration (no restart required) ──
  // UF-01-03 item 2: a commissioner's mid-draft edit to nomination_timer_ms/
  // second_bid_timer_ms/rebid_timer_ms must take effect starting with the
  // very next auction/turn that reads it — no server restart. Confirms the
  // PUT /leagues/:id/config/auction route is a plain DB write (no in-process
  // cache to invalidate) and that dispatchNominationTurn picks up the new
  // value on the very next turn.

  it('test_F_MOD_002_rework_02_mid_draft_nomination_timer_edit_takes_effect_on_next_turn_without_restart', async () => {
    // Start with a long timer so the first turn would never auto-nominate
    // within the test window if the edit were NOT picked up.
    await setupDraft({ nominationTimerMs: 60000 });
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // team1 nominates manually (consumes the first turn without needing the
    // 60s timer to fire) so we can observe the SECOND team's turn dispatch,
    // which re-reads nomination_timer_ms fresh at dispatch time.
    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Mid-draft commissioner edit — no restart of the server/draft happens here.
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: 20000,
        nomination_timer_ms: 300, // was 60000 — should apply to team2's upcoming turn
        second_bid_timer_ms: 60000,
        rebid_timer_ms: 60000,
        anti_snipe_threshold_ms: 500,
        anti_snipe_extension_ms: 500,
        min_bid_minor: 100,
      },
    });

    // Force the auction to resolve so nomination-turn advance dispatches team2's turn.
    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    const award1 = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);
    expect(award1.type).toBe('PLAYER_AWARDED');

    const turnChanged1 = await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);
    expect(turnChanged1.type).toBe('NOMINATION_TURN_CHANGED');
    expect(turnChanged1.payload?.['current_nominator_team_id']).toBe(team2Id);

    // With the new 300ms timer in effect, team2 (still MANUAL, no NOMINATE_COMMAND
    // sent) auto-nominates well within a few seconds — proving the edit applied
    // without any server/draft restart.
    const nom2 = await waitForMessage(ws1, 3000);
    await waitForMessage(ws2, 3000);
    expect(nom2.type).toBe('NOMINATION_STARTED');
    expect(nom2.payload?.['system_nominated']).toBe(true);
    expect(nom2.payload?.['nominator_team_id']).toBe(team2Id);

    ws1.close();
    ws2.close();
  }, 15000);

  // ── F-MOD-002-rework-03: roster-grid exposes player identity + price per slot ──
  // UF-17-04: My Roster only showed fill counts (e.g. "QB 1/1") — the grid must
  // also carry, per filled slot, the acquired player's name and price paid,
  // reusing the same acquisitions/players join reports.ts already does.

  it('test_F_MOD_002_rework_03_roster_grid_exposes_player_name_and_price_for_filled_slot', async () => {
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

    await sql`
      UPDATE player_auctions
      SET rebid_deadline = NOW() - INTERVAL '2 seconds'
      WHERE id = ${auctionId}
    `;

    const [award1, award2] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
    ]);
    expect(award1.type).toBe('PLAYER_AWARDED');
    expect(award2.type).toBe('PLAYER_AWARDED');

    // An award always advances the nomination turn (own transaction, right after
    // the PLAYER_AWARDED broadcast) — drain it immediately so a later `await`
    // (the roster-grid GET below) doesn't leave the message unregistered and lost.
    await waitForMessage(ws1, 4000);
    await waitForMessage(ws2, 4000);

    const gridRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/roster-grid`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(gridRes.statusCode).toBe(200);
    const grid = gridRes.json<{
      teams: Array<{
        team_id: string;
        slots: Array<{ position: string; filled: number; total: number; players: Array<{ name: string; price_minor: number }> }>;
      }>;
    }>();
    const alpha = grid.teams.find((t) => t.team_id === team1Id)!;
    const qbSlot = alpha.slots.find((s) => s.position === 'QB')!;
    expect(qbSlot.filled).toBe(1);
    expect(qbSlot.players).toEqual([{ name: 'F002-Josh-Allen', price_minor: 100 }]);

    // Unfilled slots carry no player/price.
    const rbSlot = alpha.slots.find((s) => s.position === 'RB')!;
    expect(rbSlot.filled).toBe(0);
    expect(rbSlot.players).toEqual([]);

    ws1.close();
    ws2.close();
  }, 10000);

  // ── UF-17-06: roster-full hard gate ───────────────────────────────────────

  it('test_F_MOD_002_rework_04_bid_rejected_with_ROSTER_FULL_when_roster_already_full', async () => {
    await setupDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const nomResp = await sendAndReceive(ws1, {
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 },
    });
    await waitForMessage(ws2, 3000);
    const auctionId = String(nomResp.payload?.['player_auction_id'] ?? '');

    // Team2's roster is completely full (every starter + bench spot filled) —
    // required_remaining_spots <= 0 must independently gate the bid, even
    // though remaining_budget_minor is generous and max_legal_bid would
    // otherwise permit this amount (the bug this rework fixes: max_legal_bid's
    // reserve formula collapses to 0 once required_remaining_spots hits 0/1,
    // so the dollar check alone never rejects a full-roster team).
    await sql`
      UPDATE draft_team_states
      SET required_remaining_spots = 0
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;

    const response = await sendAndReceive(ws2, {
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 200, bid_type: 'ABSOLUTE' },
    });

    expect(response.type).toBe('BID_REJECTED');
    expect(response.payload?.['code']).toBe('ROSTER_FULL');

    // BidAttempt recorded as rejected
    const attempts = await sql<[{ accepted: boolean; rejection_reason: string }]>`
      SELECT accepted, rejection_reason FROM bid_attempts
      WHERE draft_id = ${draftId} AND bid_amount_minor = 200
    `;
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.accepted).toBe(false);
    expect(attempts[0]!.rejection_reason).toBe('ROSTER_FULL');

    // No DB rows modified — current bid unchanged
    const [auction] = await sql<[{ current_bid_minor: number }]>`
      SELECT current_bid_minor FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction.current_bid_minor).toBe(100);

    ws1.close();
    ws2.close();
  });

  it('test_F_MOD_002_rework_04_award_throws_and_does_not_charge_when_no_roster_slot_available', async () => {
    await setupDraft();

    // Force assignRosterSlot() to find no eligible slot for team1 by filling
    // every roster_slot_definition (QB 1 + RB 2 + WR 2 + BN 6 = 11) with dummy
    // acquisitions/roster_entries — WITHOUT touching draft_team_states, so
    // required_remaining_spots stays at its initial 11 and the ROSTER_FULL
    // gate (tested above) does not interfere with isolating this
    // defense-in-depth path.
    const slotDefs = await sql<[{ id: string; slot_count: number }]>`
      SELECT rsd.id, rsd.slot_count FROM roster_slot_definitions rsd
      JOIN roster_configurations rc ON rc.id = rsd.config_id
      WHERE rc.league_id = ${leagueId}
    `;
    const [dummyAuction] = await sql<[{ id: string }]>`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id, auction_version, resolution_sequence)
      VALUES
        (${draftId}, ${player1EntryId}, 'AWARDED', 100, ${team1Id}, 1, 1)
      RETURNING id
    `;
    // Fill each slot definition to its full slot_count — a single roster_entry
    // per definition would leave e.g. RB (slot_count 2) or BN (slot_count 6)
    // with room, so assignRosterSlot() would still find a home there.
    for (const slot of slotDefs) {
      for (let i = 0; i < slot.slot_count; i++) {
        const [acq] = await sql<[{ id: string }]>`
          INSERT INTO acquisitions (draft_id, team_id, player_auction_id, price_minor, resolution_sequence, active)
          VALUES (${draftId}, ${team1Id}, ${dummyAuction!.id}, 1, 1, true)
          RETURNING id
        `;
        await sql`
          INSERT INTO roster_entries (acquisition_id, draft_id, team_id, roster_slot_id, active)
          VALUES (${acq!.id}, ${draftId}, ${team1Id}, ${slot.id}, true)
        `;
      }
    }

    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    // Nominate the second (real, distinct) player so award logic runs on a
    // genuine OPEN auction rather than the dummy AWARDED row above.
    const [nom1] = await Promise.all([
      waitForMessage(ws1, 4000),
      waitForMessage(ws2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: playerIds[1], opening_bid_minor: 100 },
        })),
      ),
    ]);
    const auctionId = String(nom1.payload?.['player_auction_id'] ?? '');

    // Expire the deadline so the award timer attempts to award team1 (current
    // leader from nomination) — assignRosterSlot() must return null for team1
    // since every slot is already full, and awardAuction() must throw rather
    // than silently charging budget / incrementing roster_filled_count.
    await sql`
      UPDATE player_auctions
      SET rebid_deadline = NOW() - INTERVAL '2 seconds'
      WHERE id = ${auctionId}
    `;

    // No PLAYER_AWARDED should ever arrive for this auction — give the ~500ms
    // award-timer poll several chances to (wrongly) fire, then assert nothing
    // changed.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const [auction] = await sql<[{ status: string }]>`
      SELECT status FROM player_auctions WHERE id = ${auctionId}
    `;
    expect(auction.status).toBe('OPEN'); // never transitioned to AWARDED

    const acqs = await sql<[{ id: string }]>`
      SELECT id FROM acquisitions WHERE draft_id = ${draftId} AND player_auction_id = ${auctionId}
    `;
    expect(acqs.length).toBe(0); // no acquisition inserted for the un-awardable player

    const [state] = await sql<[{ remaining_budget_minor: number; roster_filled_count: number }]>`
      SELECT remaining_budget_minor, roster_filled_count
      FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state.remaining_budget_minor).toBe(20000); // unchanged — never charged
    expect(state.roster_filled_count).toBe(0); // unchanged — dummy fills bypassed this counter

    ws1.close();
    ws2.close();
  }, 10000);
});
