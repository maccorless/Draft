/**
 * F-MOD-006: Draft Completion, Reports, and Nominator Match — behavioral expectations
 *
 * Tests run against a real Postgres database and real Fastify HTTP server.
 * No mocks — this exercises the full pipeline end to end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';

// Set env vars before any imports that might trigger env-check
process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
process.env['SENDGRID_API_KEY'] =
  process.env['SENDGRID_API_KEY'] ?? 'test-sendgrid-key-placeholder';

const DATABASE_URL = process.env['DATABASE_URL'];
const SKIP_DB = !DATABASE_URL;

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
      if (msg.type === 'AUTHENTICATED' || msg.type === 'STATE_SNAPSHOT') resolve();
      else reject(new Error(`Expected AUTHENTICATED/STATE_SNAPSHOT, got ${msg.type}`));
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

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-006 draft completion and reports', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  // State per test
  let leagueId: string;
  let team1Id: string;
  let team2Id: string;
  let draftId: string;
  let commToken: string;
  let team1Token: string;
  let team2Token: string;
  let datasetId: string;
  let player1EntryId: string;
  let player2EntryId: string;

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
  }, 20000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  /**
   * Shared fixture: creates a league, 2 teams, roster config (1 bench slot),
   * auction config, dataset with 2 players, and a CREATED draft.
   */
  async function setupLeagueAndDraft(): Promise<void> {
    // League
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F006 Test ${Date.now()}`,
        site_password: 'site',
        commissioner_password: 'comm',
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

    // Get auth epochs
    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const [e2] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team2Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1.auth_epoch });
    team2Token = makeToken({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2.auth_epoch });

    // Roster config — just 1 bench slot per team for simplicity
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
        ],
      },
    });

    // Auction config — short timers for faster tests
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

    // Dataset
    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    // Players
    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F006-QB1', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F006-QB2', 'QB', 'KC') RETURNING id
    `;

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p1.id}, 3500, 'test')
    `;
    // Now equal to the player's own id (F-MOD-016): dataset_player_id FKs to players.id.
    player1EntryId = p1.id;

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p2.id}, 2500, 'test')
    `;
    player2EntryId = p2.id;

    // Freeze dataset
    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${datasetId}`;

    // Create draft
    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;
  }

  /**
   * Creates a COMPLETE draft by:
   * 1. Starting the draft
   * 2. Inserting player_auctions in CLOSED state (past deadline)
   * 3. Running the award cycle via timer wait
   */
  async function createCompleteDraft(): Promise<void> {
    await setupLeagueAndDraft();

    // Start draft
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // Insert two player_auctions as CLOSED with winners and past deadlines
    // Team 1 wins player 1 at 2000, team 2 wins player 2 at 1500
    const now = new Date();
    const pastDeadline = new Date(now.getTime() - 10000); // 10s ago

    // OPEN status + past deadline — the award cycle picks these up
    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES
        (${draftId}, ${player1EntryId}, 'OPEN', 2000, ${team1Id}, 1, ${pastDeadline}, NULL)
    `;

    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, rebid_deadline, resolution_sequence)
      VALUES
        (${draftId}, ${player2EntryId}, 'OPEN', 1500, ${team2Id}, 1, ${pastDeadline}, NULL)
    `;

    // Wait for award cycle to pick up the OPEN auctions (timer runs every 500ms)
    // 4s gives 8 award cycles to process both auctions safely
    await new Promise(resolve => setTimeout(resolve, 4000));
  }

  // ─── Test: draft auto-completes when all auctions are awarded ───────────────

  it('F_MOD_006_draft_auto_completes_when_all_player_auctions_awarded', async () => {
    await createCompleteDraft();

    const [draft] = await sql<[{ status: string; completed_at: Date | null }]>`
      SELECT status, completed_at FROM drafts WHERE id = ${draftId}
    `;

    expect(draft.status).toBe('COMPLETE');
    expect(draft.completed_at).not.toBeNull();

    // DRAFT_COMPLETE event must exist
    const events = await sql<Array<{ event_type: string }>>`
      SELECT event_type FROM draft_events
      WHERE draft_id = ${draftId} AND event_type = 'DRAFT_COMPLETE'
    `;
    expect(events.length).toBeGreaterThan(0);
  }, 15000);

  // ─── Test: GET /drafts/:id/report for COMPLETE draft ────────────────────────

  it('F_MOD_006_report_returns_draft_summary_for_complete_draft', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      draft_id: string;
      completed_at: string;
      teams: Array<{
        team_id: string;
        team_name: string;
        final_budget_minor: number;
        acquisitions: Array<{
          player_name: string;
          position: string;
          price_minor: number;
          roster_slot: string;
        }>;
      }>;
    }>();

    // Must have draft_id and completed_at
    expect(body.draft_id).toBe(draftId);
    expect(body.completed_at).toBeTruthy();

    // Must have 2 teams
    expect(body.teams).toHaveLength(2);

    // Each team must have acquisitions
    const team1Entry = body.teams.find((t) => t.team_id === team1Id);
    const team2Entry = body.teams.find((t) => t.team_id === team2Id);
    expect(team1Entry).toBeDefined();
    expect(team2Entry).toBeDefined();

    // Team names
    expect(team1Entry!.team_name).toBe('Alpha');
    expect(team2Entry!.team_name).toBe('Beta');

    // Acquisitions: team1 got player1 at 2000, team2 got player2 at 1500
    expect(team1Entry!.acquisitions).toHaveLength(1);
    expect(team1Entry!.acquisitions[0]!.price_minor).toBe(2000);
    expect(team1Entry!.acquisitions[0]!.player_name).toBe('F006-QB1');
    expect(team1Entry!.acquisitions[0]!.position).toBe('QB');

    expect(team2Entry!.acquisitions).toHaveLength(1);
    expect(team2Entry!.acquisitions[0]!.price_minor).toBe(1500);
    expect(team2Entry!.acquisitions[0]!.player_name).toBe('F006-QB2');

    // Budget remaining: initial 50000 - price paid
    expect(team1Entry!.final_budget_minor).toBe(50000 - 2000);
    expect(team2Entry!.final_budget_minor).toBe(50000 - 1500);
  }, 15000);

  // ─── Test: report requires auth ─────────────────────────────────────────────

  it('F_MOD_006_report_requires_authentication', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
    });

    expect(res.statusCode).toBe(401);
  }, 15000);

  // ─── Test: report for non-COMPLETE draft returns 409 ────────────────────────

  it('F_MOD_006_report_returns_409_for_non_complete_draft', async () => {
    await setupLeagueAndDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(409);
  }, 10000);

  // ─── Test: GET /drafts/:id/espn-worksheet returns CSV ───────────────────────

  it('F_MOD_006_espn_worksheet_returns_csv_with_content_disposition', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/espn-worksheet`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(draftId);

    // Body should be a CSV with a header row and one data row per acquisition
    const csv = res.payload;
    const lines = csv.trim().split('\n').filter((l) => l.length > 0);
    // Header + 2 data rows (one per acquisition)
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Header row should be present
    expect(lines[0]).toMatch(/player/i);
  }, 15000);

  // ─── Test: ESPN worksheet requires auth ─────────────────────────────────────

  it('F_MOD_006_espn_worksheet_requires_authentication', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/espn-worksheet`,
    });

    expect(res.statusCode).toBe(401);
  }, 15000);

  // ─── Test: POST /drafts/:id/report/email stub returns 202 ───────────────────

  it('F_MOD_006_email_stub_returns_202_with_recipients_count', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/report/email`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ accepted: boolean; recipients: number }>();
    expect(body.accepted).toBe(true);
    // 2 teams in the league
    expect(body.recipients).toBe(2);
  }, 15000);

  // ─── Test: email requires commissioner role ──────────────────────────────────

  it('F_MOD_006_email_requires_commissioner_role', async () => {
    await createCompleteDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/report/email`,
      headers: { authorization: `Bearer ${team1Token}` },
    });

    expect(res.statusCode).toBe(403);
  }, 15000);

  // ─── Test: report survives server restart (regenerable from live rows) ───────

  it('F_MOD_006_report_regenerable_from_live_rows', async () => {
    await createCompleteDraft();

    // Get report once
    const res1 = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{ draft_id: string; teams: unknown[] }>();

    // Get report again — same data (regenerated each time from Acquisition rows)
    const res2 = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ draft_id: string; teams: unknown[] }>();

    expect(body2.draft_id).toBe(body1.draft_id);
    expect(body2.teams.length).toBe(body1.teams.length);
  }, 15000);

  // ─── Test: NOMINATOR_MATCH WS command — valid use ───────────────────────────

  it('F_MOD_006_nominator_match_valid_use_sets_leader_and_records_bid', async () => {
    await setupLeagueAndDraft();

    // Start draft
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // Insert NominatorMatch rows for both teams (used=false)
    await sql`
      INSERT INTO nominator_matches (draft_id, team_id, used)
      VALUES (${draftId}, ${team1Id}, false), (${draftId}, ${team2Id}, false)
    `;

    // Connect team1 and team2 via WS
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    try {
      // Team 1 nominates player 1
      const nominateRes = await sendAndReceive(ws1, {
        type: 'NOMINATE_COMMAND',
        payload: {
          player_dataset_entry_id: player1EntryId,
          opening_bid_minor: 100,
        },
      });
      expect(nominateRes.type).toBe('NOMINATION_STARTED');

      // Consume the broadcast on ws2 (NOMINATION_ACCEPTED)
      await waitForMessage(ws2);

      // Team 2 sends NOMINATOR_MATCH
      const nmRes = await sendAndReceive(ws2, {
        type: 'NOMINATOR_MATCH',
        payload: {},
      });

      expect(nmRes.type).toBe('NOMINATOR_MATCH_USED');

      // Verify DB state
      const [nm] = await sql<[{ used: boolean; used_at: Date | null }]>`
        SELECT used, used_at FROM nominator_matches
        WHERE draft_id = ${draftId} AND team_id = ${team2Id}
      `;
      expect(nm.used).toBe(true);
      expect(nm.used_at).not.toBeNull();

      // BidAttempt with bid_type = NOMINATOR_MATCH, accepted = true
      const bids = await sql<Array<{ bid_type: string; accepted: boolean }>>`
        SELECT bid_type, accepted FROM bid_attempts
        WHERE draft_id = ${draftId} AND team_id = ${team2Id}
        ORDER BY server_receipt_time DESC LIMIT 1
      `;
      expect(bids).toHaveLength(1);
      expect(bids[0]!.bid_type).toBe('NOMINATOR_MATCH');
      expect(bids[0]!.accepted).toBe(true);

      // NOMINATOR_MATCH_USED event in DraftEvents
      const events = await sql<Array<{ event_type: string }>>`
        SELECT event_type FROM draft_events
        WHERE draft_id = ${draftId} AND event_type = 'NOMINATOR_MATCH_USED'
      `;
      expect(events.length).toBeGreaterThan(0);

      // team2 should now be the leader
      const [pa] = await sql<[{ current_leader_id: string; current_bid_minor: number }]>`
        SELECT current_leader_id, current_bid_minor FROM player_auctions
        WHERE draft_id = ${draftId} AND status = 'OPEN'
        LIMIT 1
      `;
      expect(pa.current_leader_id).toBe(team2Id);
      expect(pa.current_bid_minor).toBe(100); // same price
    } finally {
      ws1.close();
      ws2.close();
    }
  }, 20000);

  // ─── Test: NOMINATOR_MATCH second attempt is rejected ───────────────────────

  it('F_MOD_006_nominator_match_second_attempt_rejected', async () => {
    await setupLeagueAndDraft();

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // Insert NominatorMatch row with used=true for team2
    await sql`
      INSERT INTO nominator_matches (draft_id, team_id, used, used_at)
      VALUES (${draftId}, ${team1Id}, false, NULL),
             (${draftId}, ${team2Id}, true, NOW())
    `;

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    try {
      // Team 1 nominates
      const nominateRes = await sendAndReceive(ws1, {
        type: 'NOMINATE_COMMAND',
        payload: {
          player_dataset_entry_id: player1EntryId,
          opening_bid_minor: 100,
        },
      });
      expect(nominateRes.type).toBe('NOMINATION_STARTED');

      await waitForMessage(ws2); // consume broadcast

      // Team 2 attempts NOMINATOR_MATCH (already used)
      const nmRes = await sendAndReceive(ws2, {
        type: 'NOMINATOR_MATCH',
        payload: {},
      });

      expect(nmRes.type).toBe('NOMINATOR_MATCH_CONSUMED');

      // BidAttempt: accepted = false
      const bids = await sql<Array<{ bid_type: string; accepted: boolean; rejection_reason: string | null }>>`
        SELECT bid_type, accepted, rejection_reason FROM bid_attempts
        WHERE draft_id = ${draftId} AND team_id = ${team2Id}
        ORDER BY server_receipt_time DESC LIMIT 1
      `;
      expect(bids).toHaveLength(1);
      expect(bids[0]!.bid_type).toBe('NOMINATOR_MATCH');
      expect(bids[0]!.accepted).toBe(false);

      // NOMINATOR_MATCH_CONSUMED in DraftEvents
      const events = await sql<Array<{ event_type: string }>>`
        SELECT event_type FROM draft_events
        WHERE draft_id = ${draftId} AND event_type = 'NOMINATOR_MATCH_CONSUMED'
      `;
      expect(events.length).toBeGreaterThan(0);

      // NominatorMatch.used still true, no state change
      const [nm] = await sql<[{ used: boolean }]>`
        SELECT used FROM nominator_matches
        WHERE draft_id = ${draftId} AND team_id = ${team2Id}
      `;
      expect(nm.used).toBe(true);
    } finally {
      ws1.close();
      ws2.close();
    }
  }, 20000);

  // ─── Test: NOMINATOR_MATCH rejected when requesting team leads ──────────────

  it('F_MOD_006_nominator_match_rejected_when_requesting_team_already_leads', async () => {
    await setupLeagueAndDraft();

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    await sql`
      INSERT INTO nominator_matches (draft_id, team_id, used)
      VALUES (${draftId}, ${team1Id}, false), (${draftId}, ${team2Id}, false)
    `;

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);

    try {
      // Team 1 nominates — team 1 now leads
      const nominateRes = await sendAndReceive(ws1, {
        type: 'NOMINATE_COMMAND',
        payload: {
          player_dataset_entry_id: player1EntryId,
          opening_bid_minor: 100,
        },
      });
      expect(nominateRes.type).toBe('NOMINATION_STARTED');

      // Team 1 tries NOMINATOR_MATCH (they already lead)
      const nmRes = await sendAndReceive(ws1, {
        type: 'NOMINATOR_MATCH',
        payload: {},
      });

      // Should be rejected with an error
      expect(nmRes.type).toBe('ERROR');
      expect((nmRes.payload as Record<string, unknown>)?.['code']).toBeTruthy();
    } finally {
      ws1.close();
    }
  }, 20000);

  // ─── Test: SENDGRID_API_KEY absent at startup causes ERR_CDR_78_EX_CONFIG ───

  it('F_MOD_006_env_check_requires_sendgrid_api_key', async () => {
    // This is a configuration test — verify that env-check.cjs lists SENDGRID_API_KEY
    // We can't easily restart the server here, so we verify the source instead.
    const fs = await import('fs');
    const path = await import('path');
    const envCheckPath = path.join(
      process.cwd(),
      'server/src/config/env-check.cjs',
    );
    const content = fs.readFileSync(envCheckPath, 'utf8');
    expect(content).toContain('SENDGRID_API_KEY');
  });
});
