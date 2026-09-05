/**
 * F-MOD-004: Auto-Agent Mode for Disconnected Teams
 *
 * Behavioral expectations tested:
 * 1. Grace timer — no early transition (multi-window: partial disconnect doesn't fire)
 * 2. Grace timer — cancelled by reconnect within grace period
 * 3. Grace timer — fires → AUTO_AGENT transition + DraftEvent + broadcast
 * 4. No auto-resume on reconnect when already in AUTO_AGENT mode
 * 5. Agent bids on NOMINATION_STARTED (AUTO_AGENT team enqueues bid)
 * 6. Agent bids on leadership change (BID_ACCEPTED with different leader)
 * 7. Agent does NOT bid above willingness ceiling
 * 8. Agent does NOT bid when max_legal_bid <= current_bid
 * 9. Willingness config update via REST PUT
 * 10. Explicit AUTO_AGENT transition via PATCH
 * 11. RESUME_MANUAL via PATCH → control_mode = MANUAL
 * 12. DraftEvent atomicity (control_mode update + DraftEvent in same transaction)
 * 13. Multi-draft isolation (wrong league_id rejected)
 *
 * Tests run against real Postgres + real Fastify server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';

import {
  registerTeamSession,
  unregisterTeamSession,
} from '../auction/engine.js';
import {
  handleGraceExpiry,
  setControlMode,
  upsertAutoAgentConfig,
} from '../auction/auto-agent.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !DATABASE_URL;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface DraftSetup {
  leagueId: string;
  team1Id: string;
  team2Id: string;
  draftId: string;
  commToken: string;
  team1Token: string;
  team2Token: string;
  playerEntryId: string;
}

interface StateSnapshot {
  draft_id: string;
  status: string;
  teams: Array<{
    team_id: string;
    remaining_budget_minor: number;
    roster_filled_count: number;
    control_mode: string;
  }>;
  current_auction: null | {
    player_auction_id: string;
    current_bid_minor: number;
    leading_team_id: string | null;
    auction_version: number;
    rebid_deadline_ts: number;
  };
  missed_events_replayed: number;
  as_of_sequence: number;
}

async function connectAndAuth(
  port: number,
  draftId: string,
  token: string,
  lastSeenSeq?: number,
): Promise<{ ws: WebSocket; snapshot: StateSnapshot | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connectAndAuth timed out'));
    }, 8000);

    ws.on('open', () => {
      const authPayload: Record<string, unknown> = { token };
      if (lastSeenSeq !== undefined) {
        authPayload['last_seen_sequence'] = lastSeenSeq;
      }
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: authPayload }));
    });

    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString()) as { type: string; payload?: unknown };
      if (msg.type === 'STATE_SNAPSHOT') {
        clearTimeout(timer);
        resolve({ ws, snapshot: msg.payload as StateSnapshot });
      } else if (msg.type === 'AUTHENTICATED') {
        clearTimeout(timer);
        resolve({ ws, snapshot: null });
      } else if (msg.type === 'ERROR') {
        clearTimeout(timer);
        reject(new Error(`Auth error: ${JSON.stringify(msg.payload)}`));
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', (code) => {
      if (code >= 4400) {
        clearTimeout(timer);
        reject(new Error(`WS closed with auth error code ${code}`));
      }
    });
  });
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: { type: string; payload?: unknown }) => boolean,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    const handler = (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString()) as { type: string; payload?: unknown };
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  if (ws.readyState === ws.CLOSED) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForClose timed out')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-004 auto-agent mode', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let port: number;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  }, 20000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  // ─── Draft setup helper (same pattern as F-MOD-003) ────────────────────────

  async function setupDraft(opts: { start?: boolean } = {}): Promise<DraftSetup> {
    const start = opts.start ?? true;
    const tag = Date.now();

    const leagueRes = await server.inject({
      method: 'POST', url: '/leagues',
      payload: { name: `F004-Test-${tag}`, site_password: 'sp', commissioner_password: 'cp' },
    });
    const leagueId = leagueRes.json<{ id: string }>().id;
    const commToken = server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const t1Res = await server.inject({
      method: 'POST', url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Alpha', team_password: 'alpha', draft_order: 1 },
    });
    const team1Id = t1Res.json<{ id: string }>().id;

    const t2Res = await server.inject({
      method: 'POST', url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Beta', team_password: 'beta', draft_order: 2 },
    });
    const team2Id = t2Res.json<{ id: string }>().id;

    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const [e2] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team2Id}`;

    const team1Token = server.jwt.sign({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1.auth_epoch });
    const team2Token = server.jwt.sign({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2.auth_epoch });

    await server.inject({
      method: 'PUT', url: `/leagues/${leagueId}/config/roster`,
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
      method: 'PUT', url: `/leagues/${leagueId}/config/auction`,
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
      method: 'POST', url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    const playerName = `F004-Player-${tag}`;
    const [p] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team)
      VALUES (${playerName}, 'QB', 'TB') RETURNING id
    `;
    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p.id}, 1000, 'test')
    `;
    // Now equal to the player's own id (F-MOD-016): dataset_player_id FKs to players.id.
    const playerEntryId = p.id;
    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST', url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId, scheduled_at: new Date(Date.now() + 3600000).toISOString() },
    });
    const draftId = draftRes.json<{ id: string }>().id;

    if (start) {
      await server.inject({
        method: 'POST', url: `/drafts/${draftId}/start`,
        headers: { authorization: `Bearer ${commToken}` },
      });
    }

    return { leagueId, team1Id, team2Id, draftId, commToken, team1Token, team2Token, playerEntryId };
  }

  // ─── Test 1: Grace timer — partial disconnect doesn't trigger AUTO_AGENT ────

  it('test_F_MOD_004_grace_timer_no_early_transition_multi_window', async () => {
    const { draftId, team1Id } = await setupDraft();

    // Simulate two WebSocket connections for team1 in the runtime
    const fakeWs1 = { readyState: 1 } as unknown as WebSocket;
    const fakeWs2 = { readyState: 1 } as unknown as WebSocket;

    let graceFired = false;
    registerTeamSession(draftId, team1Id, fakeWs1, 50, () => { graceFired = true; });
    registerTeamSession(draftId, team1Id, fakeWs2, 50, () => { graceFired = true; });

    // Remove only one connection — team still has fakeWs2
    unregisterTeamSession(draftId, team1Id, fakeWs1, 50, () => { graceFired = true; });

    await sleep(100); // well past grace period

    // Grace should NOT have fired — team1 still has one connection
    expect(graceFired).toBe(false);

    // Verify control_mode is still MANUAL in DB
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('MANUAL');

    // Cleanup
    unregisterTeamSession(draftId, team1Id, fakeWs2, 50, () => { graceFired = true; });
  }, 10000);

  // ─── Test 2: Grace timer — cancelled by reconnect ────────────────────────────

  it('test_F_MOD_004_grace_timer_cancelled_by_reconnect', async () => {
    const { draftId, team1Id } = await setupDraft();

    const fakeWs1 = { readyState: 1 } as unknown as WebSocket;
    const fakeWs2 = { readyState: 1 } as unknown as WebSocket;

    let graceFired = false;
    registerTeamSession(draftId, team1Id, fakeWs1, 50, () => { graceFired = true; });

    // Disconnect — starts 50ms grace timer
    unregisterTeamSession(draftId, team1Id, fakeWs1, 50, () => { graceFired = true; });

    // Reconnect within grace period (immediately)
    registerTeamSession(draftId, team1Id, fakeWs2, 50, () => { graceFired = true; });

    await sleep(100); // past grace period

    // Grace should NOT have fired — reconnect cancelled the timer
    expect(graceFired).toBe(false);

    // control_mode should still be MANUAL
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('MANUAL');

    // Cleanup
    unregisterTeamSession(draftId, team1Id, fakeWs2, 50, () => { graceFired = true; });
  }, 10000);

  // ─── Test 3: Grace timer — fires → AUTO_AGENT + DraftEvent + broadcast ───────

  it('test_F_MOD_004_grace_timer_fires_auto_agent_transition', async () => {
    const { draftId, team1Id, team2Token } = await setupDraft();

    // Connect team2 to receive the broadcast
    const { ws: wsTeam2 } = await connectAndAuth(port, draftId, team2Token);

    const broadcastPromise = waitForMessage(
      wsTeam2,
      (msg) => msg.type === 'TEAM_AUTO_AGENT_ENABLED',
      3000,
    );

    // Directly call handleGraceExpiry (simulates timer firing after grace period)
    await handleGraceExpiry(draftId, team1Id, sql);

    const broadcastMsg = await broadcastPromise;
    wsTeam2.close();

    // Verify broadcast payload
    const payload = broadcastMsg.payload as { team_id: string; triggered_by: string };
    expect(payload.team_id).toBe(team1Id);
    expect(payload.triggered_by).toBe('disconnect_grace');

    // Verify DB: control_mode = AUTO_AGENT
    const stateRows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(stateRows[0]?.control_mode).toBe('AUTO_AGENT');

    // Verify DraftEvent row was inserted
    const eventRows = await sql<[{ event_type: string; team_id: string; payload: unknown }]>`
      SELECT event_type, team_id, payload
      FROM draft_events
      WHERE draft_id = ${draftId} AND event_type = 'TEAM_AUTO_AGENT_ENABLED' AND team_id = ${team1Id}
    `;
    expect(eventRows.length).toBeGreaterThan(0);
    expect(eventRows[0]?.event_type).toBe('TEAM_AUTO_AGENT_ENABLED');
    // postgres.js returns jsonb as a string; parse before asserting
    const rawPayload = eventRows[0]?.payload;
    const evPayload = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as { triggered_by: string };
    expect(evPayload.triggered_by).toBe('disconnect_grace');
  }, 15000);

  // ─── Test 4: No auto-resume on reconnect when in AUTO_AGENT mode ─────────────

  it('test_F_MOD_004_no_auto_resume_on_reconnect', async () => {
    const { draftId, team1Id, team1Token } = await setupDraft();

    // Set team1 to AUTO_AGENT via direct setControlMode
    await setControlMode(draftId, team1Id, 'AUTO_AGENT', 'disconnect_grace', sql);

    // Verify it's AUTO_AGENT
    const before = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(before[0]?.control_mode).toBe('AUTO_AGENT');

    // Connect team1 (simulating reconnect)
    const { ws, snapshot } = await connectAndAuth(port, draftId, team1Token);
    ws.close();
    await waitForClose(ws);

    // control_mode should still be AUTO_AGENT — reconnect does NOT restore MANUAL
    const after = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(after[0]?.control_mode).toBe('AUTO_AGENT');

    // Snapshot received should reflect AUTO_AGENT
    const team1State = snapshot?.teams.find((t) => t.team_id === team1Id);
    expect(team1State?.control_mode).toBe('AUTO_AGENT');
  }, 15000);

  // ─── Test 5: Agent bids on NOMINATION_STARTED ─────────────────────────────────

  it('test_F_MOD_004_agent_bids_on_nomination_started', async () => {
    const { draftId, team2Id, team1Token, team2Token, playerEntryId } = await setupDraft();

    // Set team2 to AUTO_AGENT with high willingness (100%)
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 1.0, sql);

    // Connect team1 and team2 WS
    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);
    const { ws: ws2 } = await connectAndAuth(port, draftId, team2Token);

    // Watch for BID_ACCEPTED on team2's auto-agent bid
    const team2BidPromise = waitForMessage(
      ws2,
      (msg) => {
        if (msg.type !== 'BID_ACCEPTED') return false;
        const p = msg.payload as { leading_team_id: string };
        return p.leading_team_id === team2Id;
      },
      8000,
    );

    // team1 nominates — this should trigger auto-agent bid from team2
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
    }));

    // Wait for team2's auto-agent to bid (it should outbid team1's opening of 100)
    const bidMsg = await team2BidPromise;
    ws1.close(); ws2.close();

    const bidPayload = bidMsg.payload as { leading_team_id: string; bid_amount_minor: number };
    expect(bidPayload.leading_team_id).toBe(team2Id);
    // Auto-agent bid = opening (100) + 100 = 200
    expect(bidPayload.bid_amount_minor).toBe(200);

    // Verify DB: bid_attempt row with accepted=true for team2
    const bidAttempts = await sql<[{ accepted: boolean; team_id: string }]>`
      SELECT accepted, team_id FROM bid_attempts
      WHERE draft_id = ${draftId} AND team_id = ${team2Id} AND accepted = true
    `;
    expect(bidAttempts.length).toBeGreaterThan(0);
  }, 20000);

  // ─── Test 6: Agent bids on leadership change ──────────────────────────────────

  it('test_F_MOD_004_agent_bids_on_leadership_change', async () => {
    const { draftId, team2Id, team1Token, team2Token, playerEntryId } = await setupDraft();

    // Set team2 to AUTO_AGENT, willingness = 50% (out of 20000 = 10000 ceiling)
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 0.5, sql);

    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);
    const { ws: ws2 } = await connectAndAuth(port, draftId, team2Token);

    // Watch for nomination first
    const nominationPromise = waitForMessage(ws2, (m) => m.type === 'NOMINATION_STARTED', 5000);

    // team2 nominates (as AUTO_AGENT team) — but since they're the nominator,
    // they won't get an auto-agent bid from themselves
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
    }));
    const nomMsg = await nominationPromise;
    const auctionId = (nomMsg.payload as { player_auction_id: string }).player_auction_id;

    // team2 should have auto-bid to 200 since it's AUTO_AGENT
    // Now team1 manually bids to take lead at 300
    const team2BidPromise = waitForMessage(
      ws2,
      (msg) => {
        if (msg.type !== 'BID_ACCEPTED') return false;
        const p = msg.payload as { leading_team_id: string };
        return p.leading_team_id === team2Id;
      },
      8000,
    );

    // team1 bids to 300 (takes lead from team2)
    ws1.send(JSON.stringify({
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 300, bid_type: 'ABSOLUTE' },
    }));

    // team2 auto-agent should respond by bidding 400
    const team2Bid = await team2BidPromise;
    ws1.close(); ws2.close();

    const p = team2Bid.payload as { leading_team_id: string; bid_amount_minor: number };
    expect(p.leading_team_id).toBe(team2Id);
    // team2's bid = 300 (current) + 100 = 400
    expect(p.bid_amount_minor).toBe(400);
  }, 25000);

  // ─── Test 7: Agent does NOT bid above willingness ceiling ─────────────────────

  it('test_F_MOD_004_agent_does_not_bid_above_willingness_ceiling', async () => {
    const { draftId, team2Id, team1Token, playerEntryId } = await setupDraft();

    // Set team2 willingness very low (0.01 of 20000 = 200 ceiling)
    // Agent will NOT bid when the bid would be > 200
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 0.01, sql); // ceiling = 200

    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);

    // Nominate with opening bid of 200 → agent would need to bid 300, but ceiling is 200
    // So agent should NOT bid
    const nominationPromise = waitForMessage(ws1, (m) => m.type === 'NOMINATION_STARTED', 5000);
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 200 },
    }));
    await nominationPromise;

    // Wait a bit to ensure auto-agent had time to respond
    await sleep(500);

    // Verify team2 made NO accepted bid attempts
    const bidAttempts = await sql<[{ accepted: boolean; team_id: string }]>`
      SELECT accepted, team_id FROM bid_attempts
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    // Should have 0 bid attempts from team2 (it was blocked by ceiling)
    expect(bidAttempts.length).toBe(0);

    ws1.close();
  }, 15000);

  // ─── Test 8: Willingness config REST endpoint ─────────────────────────────────

  it('test_F_MOD_004_willingness_config_put_endpoint', async () => {
    const { draftId, team1Id, team1Token } = await setupDraft();

    const res = await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/auto-agent`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { willingness_pct: 0.6 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ team_id: string; willingness_pct: number }>();
    expect(body.team_id).toBe(team1Id);
    expect(body.willingness_pct).toBe(0.6);

    // Verify persisted in DB
    const rows = await sql<[{ willingness_pct: string }]>`
      SELECT willingness_pct FROM auto_agent_configs
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(parseFloat(rows[0]!.willingness_pct)).toBeCloseTo(0.6, 3);

    // Update again — should update existing row
    const res2 = await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/auto-agent`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { willingness_pct: 0.75 },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ willingness_pct: number }>().willingness_pct).toBe(0.75);

    // Verify only one row (upsert, not duplicate)
    const rows2 = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM auto_agent_configs
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(Number(rows2[0]?.count)).toBe(1);
  }, 10000);

  // ─── Test 9: Explicit AUTO_AGENT transition via PATCH ─────────────────────────

  it('test_F_MOD_004_explicit_auto_agent_patch', async () => {
    const { draftId, team1Id, team1Token, team2Token } = await setupDraft();

    // Connect team2 to receive broadcast
    const { ws: ws2 } = await connectAndAuth(port, draftId, team2Token);
    const broadcastPromise = waitForMessage(
      ws2,
      (m) => m.type === 'TEAM_AUTO_AGENT_ENABLED',
      5000,
    );

    const res = await server.inject({
      method: 'PATCH',
      url: `/drafts/${draftId}/teams/${team1Id}/control-mode`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { mode: 'AUTO_AGENT' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ team_id: string; control_mode: string }>();
    expect(body.team_id).toBe(team1Id);
    expect(body.control_mode).toBe('AUTO_AGENT');

    // Verify broadcast received
    const broadcastMsg = await broadcastPromise;
    ws2.close();
    const bp = broadcastMsg.payload as { team_id: string; triggered_by: string };
    expect(bp.team_id).toBe(team1Id);
    expect(bp.triggered_by).toBe('manual');

    // Verify DB
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('AUTO_AGENT');
  }, 10000);

  // ─── Test 10: RESUME_MANUAL via PATCH ────────────────────────────────────────

  it('test_F_MOD_004_resume_manual_patch', async () => {
    const { draftId, team1Id, team1Token, team2Token } = await setupDraft();

    // First set to AUTO_AGENT
    await setControlMode(draftId, team1Id, 'AUTO_AGENT', 'test', sql);

    // Connect team2 to receive broadcast
    const { ws: ws2 } = await connectAndAuth(port, draftId, team2Token);
    const broadcastPromise = waitForMessage(
      ws2,
      (m) => m.type === 'TEAM_AUTO_AGENT_DISABLED',
      5000,
    );

    const res = await server.inject({
      method: 'PATCH',
      url: `/drafts/${draftId}/teams/${team1Id}/control-mode`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { mode: 'MANUAL' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ team_id: string; control_mode: string }>();
    expect(body.control_mode).toBe('MANUAL');

    // Verify broadcast
    const broadcastMsg = await broadcastPromise;
    ws2.close();
    const bp = broadcastMsg.payload as { team_id: string; triggered_by: string };
    expect(bp.team_id).toBe(team1Id);

    // Verify DB
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('MANUAL');

    // Verify DraftEvent inserted
    const evRows = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events
      WHERE draft_id = ${draftId} AND event_type = 'TEAM_AUTO_AGENT_DISABLED' AND team_id = ${team1Id}
    `;
    expect(evRows.length).toBeGreaterThan(0);
  }, 10000);

  // ─── Test 11: DraftEvent atomicity ───────────────────────────────────────────

  it('test_F_MOD_004_draft_event_atomicity', async () => {
    const { draftId, team1Id } = await setupDraft();

    // Get sequence before
    const [seqBefore] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
    `;

    await setControlMode(draftId, team1Id, 'AUTO_AGENT', 'disconnect_grace', sql);

    // Verify both updates happened together
    const [stateRow] = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(stateRow?.control_mode).toBe('AUTO_AGENT');

    const [seqAfter] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
    `;
    // Sequence must have advanced (DraftEvent was inserted)
    expect((seqAfter?.max ?? -1)).toBeGreaterThan(seqBefore?.max ?? -1);

    // The new event should be TEAM_AUTO_AGENT_ENABLED with correct sequence
    const eventRows = await sql<[{ event_type: string; sequence: number }]>`
      SELECT event_type, sequence FROM draft_events
      WHERE draft_id = ${draftId} AND sequence = ${seqAfter!.max!}
    `;
    expect(eventRows[0]?.event_type).toBe('TEAM_AUTO_AGENT_ENABLED');
  }, 10000);

  // ─── Test 12: Multi-draft isolation — wrong league rejected ──────────────────

  it('test_F_MOD_004_multi_draft_isolation_wrong_league', async () => {
    const setup1 = await setupDraft();
    const setup2 = await setupDraft();

    // Team from league 1 tries to set AUTO_AGENT on league 2's team
    const res = await server.inject({
      method: 'PATCH',
      url: `/drafts/${setup2.draftId}/teams/${setup2.team1Id}/control-mode`,
      headers: { authorization: `Bearer ${setup1.team1Token}` }, // wrong league token
      payload: { mode: 'AUTO_AGENT' },
    });

    // Should be rejected due to league mismatch
    expect([403, 401]).toContain(res.statusCode);

    // Verify team in league 2 is still MANUAL
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${setup2.draftId} AND team_id = ${setup2.team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('MANUAL');
  }, 15000);

  // ─── Test 13: RESUME_MANUAL via WS command ────────────────────────────────────

  it('test_F_MOD_004_resume_manual_ws_command', async () => {
    const { draftId, team1Id, team1Token } = await setupDraft();

    // Set to AUTO_AGENT first
    await setControlMode(draftId, team1Id, 'AUTO_AGENT', 'test', sql);

    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);

    // Send RESUME_MANUAL via WS
    const disabledPromise = waitForMessage(
      ws1,
      (m) => m.type === 'TEAM_AUTO_AGENT_DISABLED',
      5000,
    );
    ws1.send(JSON.stringify({ type: 'RESUME_MANUAL', payload: {} }));
    await disabledPromise;
    ws1.close();

    // Verify DB
    const rows = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(rows[0]?.control_mode).toBe('MANUAL');
  }, 10000);

  // ─── Test 14: SET_AUTO_AGENT_CONFIG via WS command ───────────────────────────

  it('test_F_MOD_004_set_auto_agent_config_ws_command', async () => {
    const { draftId, team1Id, team1Token } = await setupDraft();

    const { ws } = await connectAndAuth(port, draftId, team1Token);

    const configUpdatedPromise = waitForMessage(
      ws,
      (m) => m.type === 'AUTO_AGENT_CONFIG_UPDATED',
      5000,
    );
    ws.send(JSON.stringify({
      type: 'SET_AUTO_AGENT_CONFIG',
      payload: { willingness_pct: 0.55 },
    }));
    const updateMsg = await configUpdatedPromise;
    ws.close();

    const p = updateMsg.payload as { team_id: string; willingness_pct: number };
    expect(p.team_id).toBe(team1Id);
    expect(p.willingness_pct).toBeCloseTo(0.55);

    // Verify DB
    const rows = await sql<[{ willingness_pct: string }]>`
      SELECT willingness_pct FROM auto_agent_configs
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(parseFloat(rows[0]?.willingness_pct ?? '0')).toBeCloseTo(0.55, 2);
  }, 10000);

  // ─── Test 15: Agent does NOT bid when PLAYER_AWARDED ─────────────────────────

  it('test_F_MOD_004_agent_does_not_bid_on_player_awarded', async () => {
    const { draftId, team2Id, team1Token, playerEntryId } = await setupDraft();

    // Set team2 AUTO_AGENT
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 1.0, sql);

    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);

    // Nominate and let team2 auto-bid to win
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
    }));

    // Wait for team2's auto-bid (should become leader)
    await waitForMessage(
      ws1,
      (m) => {
        if (m.type !== 'BID_ACCEPTED') return false;
        return (m.payload as { leading_team_id: string }).leading_team_id === team2Id;
      },
      8000,
    );

    // Count bid attempts BEFORE award
    const bidsBefore = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM bid_attempts WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    const countBefore = Number(bidsBefore[0]?.count ?? 0);

    // Force auction award by setting rebid_deadline in the past
    await sql`
      UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second'
      WHERE draft_id = ${draftId} AND status = 'OPEN'
    `;

    // Wait for PLAYER_AWARDED
    await waitForMessage(ws1, (m) => m.type === 'PLAYER_AWARDED', 5000);
    ws1.close();

    // Give agent time to (not) bid
    await sleep(200);

    // No additional bids from team2 after award
    const bidsAfter = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM bid_attempts WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    // bid count should not have increased after PLAYER_AWARDED
    expect(Number(bidsAfter[0]?.count ?? 0)).toBe(countBefore);
  }, 25000);

  // ─── Test 16 (F-MOD-004-rework-01): control mode set before draft start persists ─

  it('test_F_MOD_004_rework_01_control_mode_set_before_draft_start_persists', async () => {
    const { draftId, team1Id, team1Token, commToken } = await setupDraft({ start: false });

    // Draft is still CREATED — no DraftTeamState row exists for team1 yet.
    const before = await sql<[{ control_mode: string } | undefined]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(before[0]).toBeUndefined();

    // Owner sets AUTO_AGENT before the draft has started.
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/drafts/${draftId}/teams/${team1Id}/control-mode`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { mode: 'AUTO_AGENT' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json<{ control_mode: string }>().control_mode).toBe('AUTO_AGENT');

    // A DraftTeamState row must now exist, seeded from auction/roster config, with
    // control_mode = AUTO_AGENT — not a silent no-op.
    const afterPatch = await sql<[{ control_mode: string; remaining_budget_minor: number }]>`
      SELECT control_mode, remaining_budget_minor FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(afterPatch[0]?.control_mode).toBe('AUTO_AGENT');
    expect(afterPatch[0]?.remaining_budget_minor).toBe(20000);

    // A TEAM_AUTO_AGENT_ENABLED DraftEvent was appended.
    const evRows = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events
      WHERE draft_id = ${draftId} AND event_type = 'TEAM_AUTO_AGENT_ENABLED' AND team_id = ${team1Id}
    `;
    expect(evRows.length).toBeGreaterThan(0);

    // GET /roster-grid reflects AUTO_AGENT, not the no-row MANUAL default.
    const gridRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/roster-grid`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(gridRes.statusCode).toBe(200);
    const grid = gridRes.json<{ teams: Array<{ team_id: string; control_mode: string }> }>();
    const team1Grid = grid.teams.find((t) => t.team_id === team1Id);
    expect(team1Grid?.control_mode).toBe('AUTO_AGENT');

    // Starting the draft afterward must NOT reset control_mode back to MANUAL.
    const startRes = await server.inject({
      method: 'POST', url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(startRes.statusCode).toBe(200);

    const afterStart = await sql<[{ control_mode: string }]>`
      SELECT control_mode FROM draft_team_states
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(afterStart[0]?.control_mode).toBe('AUTO_AGENT');
  }, 15000);
});
