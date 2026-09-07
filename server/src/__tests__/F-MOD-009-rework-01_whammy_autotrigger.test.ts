/**
 * F-MOD-009-rework-01: Whammy definitions CRUD + auto-trigger at pick resolution.
 *
 * Tests run against real Postgres + real Fastify server. No mocks.
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

const SKIP_DB = !DATABASE_URL;

async function connectAndAuth(port: number, draftId: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token } })));
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'AUTHENTICATED' || msg.type === 'STATE_SNAPSHOT') resolve();
      else reject(new Error(`Expected AUTHENTICATED or STATE_SNAPSHOT, got ${msg.type}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connectAndAuth timed out')), 5000);
  });
  return ws;
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: { type: string; payload?: Record<string, unknown> }) => boolean,
  timeoutMs = 6000,
): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    const handler = (data: Buffer | string): void => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe.skipIf(SKIP_DB)('F-MOD-009-rework-01 whammy definitions + auto-trigger', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  let leagueId = '';
  let team1Id = '';
  let team1Token = '';
  let commToken = '';
  let draftId = '';
  let datasetId = '';
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
      payload: { name: `F009rw01 Test ${Date.now()}`, site_password: 's', commissioner_password: 'c' },
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
    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { bench_slots: 5, slots: [{ position: 'QB', priority: 1, is_starter: true, slot_count: 1 }] },
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
    await sql`
      INSERT INTO whammy_configs
        (league_id, enabled, max_amount_minor, allowed_event_types, allow_positive, allow_negative, max_per_team, max_per_draft, commissioner_approval_required)
      VALUES (${leagueId}, true, 100000, '{}', true, true, null, null, false)
    `;

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F009rw01-QB', 'QB', 'BUF') RETURNING id
    `;
    playerIds = [p1!.id];
    await sql`INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source) VALUES (${datasetId}, ${p1!.id}, 5000, 'CSV')`;
    player1EntryId = p1!.id;
    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });
  }

  afterEach(async () => {
    if (draftId) {
      await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM whammy_events WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM drafts WHERE id = ${draftId}`;
      draftId = '';
    }
    if (leagueId) {
      await sql`DELETE FROM whammy_definitions WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM whammy_configs WHERE league_id = ${leagueId}`;
      if (playerIds.length > 0) {
        await sql`DELETE FROM player_aav_sources WHERE player_id = ANY(${playerIds})`;
        await sql`DELETE FROM players WHERE id = ANY(${playerIds})`;
        playerIds = [];
      }
      await sql`DELETE FROM draft_datasets WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (SELECT id FROM roster_configurations WHERE league_id = ${leagueId})`;
      await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
      leagueId = '';
    }
  });

  // ── WhammyDefinition CRUD ────────────────────────────────────────────────

  it('test_F_MOD_009_rw01_create_list_update_whammy_definition', async () => {
    await setupDraft();

    const createRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/whammy-definitions`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        name: 'Budget Bonus', type: 'BUDGET_BONUS', budget_delta_minor: 500,
        trigger_rule_json: { probability: 0.1 }, weight: 2, display_message: 'You got a bonus!',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<{ id: string; name: string }>();
    expect(created.name).toBe('Budget Bonus');

    const listRes = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/whammy-definitions`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<Array<{ id: string }>>();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((d) => d.id === created.id)).toBe(true);

    const updateRes = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/whammy-definitions/${created.id}`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        name: 'Budget Bonus v2', type: 'BUDGET_BONUS', budget_delta_minor: 750,
        trigger_rule_json: { probability: 0.2 }, weight: 3, display_message: 'Bigger bonus!', active: false,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json<{ name: string; budget_delta_minor: number; active: boolean }>().name).toBe('Budget Bonus v2');
    expect(updateRes.json<{ budget_delta_minor: number }>().budget_delta_minor).toBe(750);
    expect(updateRes.json<{ active: boolean }>().active).toBe(false);
  });

  it('test_F_MOD_009_rw01_whammy_definitions_non_commissioner_403', async () => {
    await setupDraft();

    const post = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/whammy-definitions`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { name: 'X', type: 'X', trigger_rule_json: {}, display_message: 'x' },
    });
    expect(post.statusCode).toBe(403);

    const get = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/whammy-definitions`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(get.statusCode).toBe(403);
  });

  // ── Auto-trigger at pick resolution ──────────────────────────────────────

  async function nominateAndAward(ws: WebSocket): Promise<void> {
    const nomPromise = waitForMessage(ws, (m) => m.type === 'NOMINATION_STARTED');
    ws.send(JSON.stringify({ type: 'NOMINATE_COMMAND', payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 100 } }));
    const nom = await nomPromise;
    const auctionId = String(nom.payload?.['player_auction_id'] ?? '');
    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '2 seconds' WHERE id = ${auctionId}`;
    await waitForMessage(ws, (m) => m.type === 'PLAYER_AWARDED');
  }

  it('test_F_MOD_009_rw01_auto_trigger_fires_and_applies_budget_change_on_pick_resolution', async () => {
    await setupDraft();
    await sql`
      INSERT INTO whammy_definitions (league_id, name, type, budget_delta_minor, trigger_rule_json, display_message, weight, active)
      VALUES (${leagueId}, 'Always Fires', 'BUDGET_PENALTY', -500, ${JSON.stringify({ probability: 1 })}::jsonb, 'Auto whammy!', 1, true)
    `;

    const ws = await connectAndAuth(serverPort, draftId, team1Token);
    await nominateAndAward(ws);

    const whammyMsg = await waitForMessage(ws, (m) => m.type === 'WHAMMY_APPLIED');
    expect(whammyMsg.payload?.['team_id']).toBe(team1Id);
    expect(whammyMsg.payload?.['amount_minor']).toBe(-500);

    const [we] = await sql<[{ definition_id: string | null; trigger_event_sequence: number | null; status: string } | undefined]>`
      SELECT definition_id, trigger_event_sequence, status FROM whammy_events WHERE draft_id = ${draftId}
    `;
    expect(we).toBeTruthy();
    expect(we!.status).toBe('APPLIED');
    expect(we!.definition_id).not.toBeNull();
    expect(we!.trigger_event_sequence).not.toBeNull();

    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    // 20000 - 100 (award price) - 500 (whammy) = 19400
    expect(state!.remaining_budget_minor).toBe(19400);

    ws.close();
  }, 15000);

  it('test_F_MOD_009_rw01_no_active_definitions_no_op_manual_trigger_still_works', async () => {
    await setupDraft();
    // No whammy_definitions rows inserted at all.

    const ws = await connectAndAuth(serverPort, draftId, team1Token);
    await nominateAndAward(ws);

    // Give any (absent) auto-trigger a moment, then confirm nothing was created.
    await new Promise((r) => setTimeout(r, 300));
    const events = await sql<Array<{ id: string }>>`SELECT id FROM whammy_events WHERE draft_id = ${draftId}`;
    expect(events).toHaveLength(0);

    // Manual trigger still works exactly as before.
    const manualRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -100, description: 'Manual' },
    });
    expect(manualRes.statusCode).toBe(200);

    ws.close();
  }, 15000);

  it('test_F_MOD_009_rw01_message_only_definition_has_null_team_and_no_ledger_entry', async () => {
    await setupDraft();
    await sql`
      INSERT INTO whammy_definitions (league_id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active)
      VALUES (${leagueId}, 'Message Only', 'OFFLINE_ACTION', NULL, ${JSON.stringify({ probability: 1 })}::jsonb, 'Do a dance!', 'Stand up and dance', 1, true)
    `;

    const ws = await connectAndAuth(serverPort, draftId, team1Token);
    await nominateAndAward(ws);

    const whammyMsg = await waitForMessage(ws, (m) => m.type === 'WHAMMY_APPLIED');
    expect(whammyMsg.payload?.['team_id']).toBeNull();
    expect(whammyMsg.payload?.['amount_minor']).toBe(0);

    const ledgerRows = await sql<Array<{ id: string }>>`
      SELECT id FROM budget_ledger_entries WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'
    `;
    expect(ledgerRows).toHaveLength(0);

    ws.close();
  }, 15000);
});
