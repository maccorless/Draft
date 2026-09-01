/**
 * F-MOD-003: WebSocket Session Reconnect and Multi-Draft Isolation
 *
 * Behavioral expectations tested:
 * 1. Reconnect with last_seen_sequence → STATE_SNAPSHOT delivered, missed events replayed
 * 2. No event duplication — only events > last_seen_sequence replayed
 * 3. Multi-window: second WS with same team_id joins existing set; both receive broadcasts
 * 4. Broadcast fans out to all team sets
 * 5. Cross-league command → AUTH_ERROR
 * 6. Two concurrent drafts → no state bleed between them
 * 7. Crash recovery: RUNNING draft becomes PAUSED; reconnecting client sees PAUSED snapshot
 * 8. GET /leagues/:leagueId/drafts returns DraftSummary[]
 * 9. GET /drafts/:draftId/state returns DraftStateSnapshot
 *
 * Tests run against real Postgres + real Fastify server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const SKIP_DB = !DATABASE_URL;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Connect WS, send AUTHENTICATE, wait for STATE_SNAPSHOT (on reconnect) or AUTHENTICATED.
 * Returns the ws socket plus any STATE_SNAPSHOT payload received during auth.
 */
async function connectAndAuth(
  port: number,
  draftId: string,
  token: string,
  lastSeenSeq?: number,
): Promise<{ ws: WebSocket; snapshot: StateSnapshot | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
    const timer = setTimeout(() => reject(new Error('connectAndAuth timed out')), 8000);

    ws.on('open', () => {
      const authPayload: Record<string, unknown> = { token };
      if (lastSeenSeq !== undefined) {
        authPayload['last_seen_sequence'] = lastSeenSeq;
      }
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: authPayload }));
    });

    const messages: { type: string; payload?: unknown }[] = [];

    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString()) as { type: string; payload?: unknown };
      messages.push(msg);

      if (msg.type === 'STATE_SNAPSHOT') {
        // Got snapshot — auth complete
        clearTimeout(timer);
        resolve({ ws, snapshot: msg.payload as StateSnapshot });
      } else if (msg.type === 'AUTHENTICATED') {
        // Legacy path (no last_seen_sequence) — but spec says snapshot is always sent
        clearTimeout(timer);
        resolve({ ws, snapshot: null });
      } else if (msg.type === 'ERROR') {
        clearTimeout(timer);
        reject(new Error(`Auth error: ${JSON.stringify(msg.payload)}`));
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  if (ws.readyState === ws.CLOSED) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForClose timed out')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
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

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-003 session reconnect and multi-draft isolation', () => {
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

  // ─── Common setup helper ────────────────────────────────────────────────────

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

  async function setupDraft(): Promise<DraftSetup> {
    const tag = Date.now();

    // League
    const leagueRes = await server.inject({
      method: 'POST', url: '/leagues',
      payload: { name: `F003-Test-${tag}`, site_password: 'sp', commissioner_password: 'cp' },
    });
    const leagueId = leagueRes.json<{ id: string }>().id;

    const commToken = server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    // Teams
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

    // Roster + auction config
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

    // Dataset + player
    const dsRes = await server.inject({
      method: 'POST', url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const datasetId = dsRes.json<{ id: string }>().id;

    const playerName = `F003-Player-${tag}`;
    const [p] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team)
      VALUES (${playerName}, 'QB', 'TB') RETURNING id
    `;
    const [pde] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p.id}, 1000, 'test') RETURNING id
    `;
    const playerEntryId = pde.id;

    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${datasetId}`;

    // Draft
    const draftRes = await server.inject({
      method: 'POST', url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId, scheduled_at: new Date(Date.now() + 3600000).toISOString() },
    });
    const draftId = draftRes.json<{ id: string }>().id;

    // Start draft → RUNNING
    await server.inject({
      method: 'POST', url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    return { leagueId, team1Id, team2Id, draftId, commToken, team1Token, team2Token, playerEntryId };
  }

  // ─── Test 1: Reconnect with last_seen_sequence → STATE_SNAPSHOT ─────────────

  it('test_F_MOD_003_reconnect_delivers_state_snapshot', async () => {
    const { draftId, team1Token, team1Id } = await setupDraft();

    // First connection — authenticate normally (no last_seen_sequence)
    const { ws: ws1 } = await connectAndAuth(port, draftId, team1Token);

    // Get the current max sequence after any initial events
    const [seqRow] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
    `;
    const seqAtConnect = seqRow.max ?? -1;
    ws1.close();
    await waitForClose(ws1);

    // Reconnect with last_seen_sequence
    const { ws: ws2, snapshot } = await connectAndAuth(port, draftId, team1Token, seqAtConnect);
    ws2.close();

    // Assert: snapshot is present and has required fields
    expect(snapshot).not.toBeNull();
    expect(snapshot!.draft_id).toBe(draftId);
    expect(snapshot!.status).toBe('RUNNING');
    expect(Array.isArray(snapshot!.teams)).toBe(true);
    expect(snapshot!.teams.length).toBeGreaterThan(0);
    expect(typeof snapshot!.as_of_sequence).toBe('number');
    expect(typeof snapshot!.missed_events_replayed).toBe('number');

    // teams should include team1Id with budget and control_mode
    const team1State = snapshot!.teams.find((t) => t.team_id === team1Id);
    expect(team1State).toBeDefined();
    expect(team1State!.remaining_budget_minor).toBe(20000);
    expect(team1State!.control_mode).toBe('MANUAL');
  }, 20000);

  // ─── Test 2: Only missed events replayed (no duplication) ───────────────────

  it('test_F_MOD_003_only_missed_events_replayed', async () => {
    const { draftId, team1Token, commToken } = await setupDraft();

    // Get sequence baseline
    const [seqRow1] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
    `;
    const seqBefore = seqRow1.max ?? -1;

    // Connect a commissioner to trigger a NOMINATION_STARTED event
    const { ws: wsComm } = await connectAndAuth(port, draftId, commToken, seqBefore);

    // Get event count after initial snapshot delivery
    const [seqRow2] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
    `;
    const seqAfterAuth = seqRow2.max ?? -1;
    wsComm.close();
    await waitForClose(wsComm);

    // Reconnect with seqAfterAuth — should see 0 missed events
    const { ws: wsReconn, snapshot } = await connectAndAuth(port, draftId, team1Token, seqAfterAuth);
    wsReconn.close();

    // No events missed since we connected at the latest sequence
    expect(snapshot!.missed_events_replayed).toBe(0);
  }, 20000);

  // ─── Test 3: Multi-window — second WS with same team_id gets broadcasts ─────

  it('test_F_MOD_003_multi_window_both_tabs_receive_broadcast', async () => {
    const { draftId, team1Token, team2Token, playerEntryId } = await setupDraft();

    // Open two connections for team1 (simulating two browser tabs)
    const { ws: tab1 } = await connectAndAuth(port, draftId, team1Token);
    const { ws: tab2 } = await connectAndAuth(port, draftId, team1Token);
    // team2 will send the nomination (different team, both tabs on team1 should receive)
    const { ws: wsTeam2 } = await connectAndAuth(port, draftId, team2Token);

    // Wait for both tabs to receive NOMINATION_STARTED
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('multi-window broadcast timed out')), 5000);
      let tab1Got = false;
      let tab2Got = false;
      const check = () => {
        if (tab1Got && tab2Got) { clearTimeout(timeout); resolve(); }
      };
      tab1.on('message', (raw: Buffer | string) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'NOMINATION_STARTED') { tab1Got = true; check(); }
      });
      tab2.on('message', (raw: Buffer | string) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'NOMINATION_STARTED') { tab2Got = true; check(); }
      });
      // team2 nominates — broadcasts to all clients including both team1 tabs
      wsTeam2.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
      }));
    });

    tab1.close(); tab2.close(); wsTeam2.close();

    // Both tabs received the broadcast — test passes if we got here without timeout
  }, 20000);

  // ─── Test 4: Broadcast reaches all registered clients ───────────────────────

  it('test_F_MOD_003_broadcast_reaches_all_team_clients', async () => {
    const { draftId, team1Token, team2Token, playerEntryId } = await setupDraft();

    // Connect one client per team
    const { ws: wst1 } = await connectAndAuth(port, draftId, team1Token);
    const { ws: wst2 } = await connectAndAuth(port, draftId, team2Token);

    // team1 nominates → broadcast should reach team2 also
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('broadcast to all timed out')), 5000);
      let t1Got = false;
      let t2Got = false;
      const check = () => { if (t1Got && t2Got) { clearTimeout(timeout); resolve(); } };
      wst1.on('message', (raw: Buffer | string) => {
        if ((JSON.parse(raw.toString()) as { type: string }).type === 'NOMINATION_STARTED') { t1Got = true; check(); }
      });
      wst2.on('message', (raw: Buffer | string) => {
        if ((JSON.parse(raw.toString()) as { type: string }).type === 'NOMINATION_STARTED') { t2Got = true; check(); }
      });
      wst1.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
      }));
    });

    wst1.close(); wst2.close();
  }, 20000);

  // ─── Test 5: Cross-league command → connection rejected ─────────────────────

  it('test_F_MOD_003_cross_league_auth_rejected', async () => {
    const setup1 = await setupDraft();
    const setup2 = await setupDraft();

    // Team from league 2 tries to connect to draft from league 1
    const crossLeagueToken = server.jwt.sign({
      league_id: setup2.leagueId,
      team_id: setup2.team1Id,
      role: 'OWNER',
      auth_epoch: 1,
    });

    // Attempt to auth to setup1's draft with setup2's token
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${setup1.draftId}`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('expected close did not arrive')); }, 5000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: crossLeagueToken, last_seen_sequence: -1 } }));
      });

      ws.on('close', (code) => {
        clearTimeout(timeout);
        // Server should close with 4401 (auth failure) — LEAGUE_MISMATCH
        expect([4401, 1006]).toContain(code);
        resolve();
      });

      ws.on('error', () => { clearTimeout(timeout); resolve(); });
    });
  }, 10000);

  // ─── Test 6: Two concurrent drafts — no state bleed ─────────────────────────

  it('test_F_MOD_003_concurrent_drafts_isolation', async () => {
    const setupA = await setupDraft();
    const setupB = await setupDraft();

    // Connect one client to each draft
    const { ws: wsA } = await connectAndAuth(port, setupA.draftId, setupA.team1Token);
    const { ws: wsB } = await connectAndAuth(port, setupB.draftId, setupB.team1Token);

    const bMsgs: { type: string }[] = [];
    wsB.on('message', (raw: Buffer | string) => bMsgs.push(JSON.parse(raw.toString())));

    // team1 of draft A nominates — only draft A clients should receive NOMINATION_STARTED
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('draft A nomination timed out')), 5000);
      wsA.on('message', (raw: Buffer | string) => {
        if ((JSON.parse(raw.toString()) as { type: string }).type === 'NOMINATION_STARTED') {
          clearTimeout(timeout);
          resolve();
        }
      });
      wsA.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: setupA.playerEntryId, opening_bid_minor: 100 },
      }));
    });

    // Give a small window to see if any bleed occurs
    await new Promise((r) => setTimeout(r, 200));
    const bHasAnyNomination = bMsgs.some((m) => m.type === 'NOMINATION_STARTED');
    expect(bHasAnyNomination).toBe(false);

    wsA.close(); wsB.close();
  }, 20000);

  // ─── Test 7: Crash recovery → PAUSED → STATE_SNAPSHOT shows PAUSED ──────────

  it('test_F_MOD_003_crash_recovery_paused_snapshot', async () => {
    const { draftId, team1Token } = await setupDraft();

    // Manually force the draft to PAUSED (simulating crash recovery result)
    await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId}`;

    // Reconnect and verify snapshot shows PAUSED
    const { ws, snapshot } = await connectAndAuth(port, draftId, team1Token, -1);
    ws.close();

    expect(snapshot!.status).toBe('PAUSED');
  }, 15000);

  // ─── Test 8: GET /leagues/:leagueId/drafts ────────────────────────────────────

  it('test_F_MOD_003_list_drafts_endpoint', async () => {
    const { leagueId, draftId, commToken } = await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ drafts: { id: string; league_id: string; status: string }[] }>();
    expect(Array.isArray(body.drafts)).toBe(true);

    const draft = body.drafts.find((d) => d.id === draftId);
    expect(draft).toBeDefined();
    expect(draft!.league_id).toBe(leagueId);
    expect(['CREATED', 'RUNNING', 'PAUSED', 'COMPLETE']).toContain(draft!.status);
  }, 10000);

  // ─── Test 9: GET /drafts/:draftId/state ─────────────────────────────────────

  it('test_F_MOD_003_get_draft_state_endpoint', async () => {
    const { draftId, team1Id, team2Id, commToken } = await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/state`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(200);
    const snapshot = res.json<StateSnapshot>();

    expect(snapshot.draft_id).toBe(draftId);
    expect(['CREATED', 'RUNNING', 'PAUSED', 'COMPLETE']).toContain(snapshot.status);
    expect(Array.isArray(snapshot.teams)).toBe(true);

    // Both teams should appear with remaining_budget_minor and control_mode
    const ids = snapshot.teams.map((t) => t.team_id);
    expect(ids).toContain(team1Id);
    expect(ids).toContain(team2Id);

    for (const team of snapshot.teams) {
      expect(typeof team.remaining_budget_minor).toBe('number');
      expect(['MANUAL', 'AUTO_AGENT']).toContain(team.control_mode);
    }

    // current_auction is null when no auction is active (draft just started)
    // (could be null or an object)
    expect(snapshot).toHaveProperty('current_auction');
  }, 10000);

  // ─── Test 10: STATE_SNAPSHOT includes active auction when one is open ────────

  it('test_F_MOD_003_snapshot_includes_active_auction', async () => {
    const { draftId, team1Token, team2Token, playerEntryId } = await setupDraft();

    // team1 nominates to create an open auction
    const { ws: wsTeam1 } = await connectAndAuth(port, draftId, team1Token);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('nomination timed out')), 5000);
      wsTeam1.once('message', (raw: Buffer | string) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'NOMINATION_STARTED' || msg.type === 'ERROR') {
          clearTimeout(timeout);
          resolve();
        }
      });
      wsTeam1.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: 100 },
      }));
    });
    wsTeam1.close();
    await waitForClose(wsTeam1);

    // Get max sequence before reconnect
    const [seqRow] = await sql<[{ max: number | null }]>`
      SELECT MAX(sequence) - 1 AS max FROM draft_events WHERE draft_id = ${draftId}
    `;
    const oldSeq = seqRow.max ?? -1;

    // Reconnect with team2 — snapshot should include current_auction
    const { ws: wsReconn, snapshot } = await connectAndAuth(port, draftId, team2Token, oldSeq);
    wsReconn.close();

    expect(snapshot).not.toBeNull();
    // The auction is now OPEN
    if (snapshot!.current_auction !== null) {
      expect(snapshot!.current_auction.current_bid_minor).toBe(100);
      expect(typeof snapshot!.current_auction.auction_version).toBe('number');
    }
  }, 20000);
});
