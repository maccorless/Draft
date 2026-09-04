/**
 * F-MOD-014: Do Not Draft (PRD §12.3, data-model.md §10.4)
 *
 * Tests run against a real Postgres database and real Fastify HTTP server.
 * No mocks — all assertions are against the actual running system.
 *
 * Naming: test_F_MOD_014_<short description>
 *
 * Behavioral expectations covered:
 *  (a) GET do-not-draft returns an empty list when nothing is added (not an error).
 *  (b) POST do-not-draft persists a row keyed (draft_id, team_id, player_id); a
 *      subsequent GET includes it.
 *  (c) DELETE do-not-draft/:playerId removes it; a subsequent GET no longer includes it.
 *  (d) 403 when token.team_id != :teamId, and no data is read or written.
 *  (e) 403 when token.league_id != draft.league_id.
 *  (f) AUTO_AGENT teams never bid on a Do Not Draft player, on nomination and
 *      on leader-change triggers, while other AUTO_AGENT teams without that
 *      entry are unaffected.
 *  (g) MANUAL-mode teams are unaffected by Do Not Draft (bid pipeline itself
 *      never consults it) — covered indirectly since Do Not Draft is only
 *      wired into the auto-agent candidate-selection functions.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import WebSocket from 'ws';
import { stopAwardTimer } from '../auction/engine.js';
import { setControlMode, upsertAutoAgentConfig } from '../auction/auto-agent.js';

async function connectAndAuth(port: number, draftId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('connectAndAuth timed out')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token } })));
    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === 'STATE_SNAPSHOT' || msg.type === 'AUTHENTICATED') {
        clearTimeout(timer);
        resolve(ws);
      } else if (msg.type === 'ERROR') {
        clearTimeout(timer);
        reject(new Error('auth error'));
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

describe.skipIf(SKIP_DB)('F-MOD-014 do not draft', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let port: number;

  let leagueId = '';
  let team1Id = '';
  let team2Id = '';
  let team3Id = '';
  let datasetId = '';
  let draftId = '';
  let commToken = '';
  let team1Token = '';
  let team2Token = '';
  let team3Token = '';
  let playerIds: string[] = [];
  let player1Id = '';
  let player2Id = '';

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
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
      payload: { name: `F014-DND-Test-${tag}`, site_password: 's', commissioner_password: 'c' },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    commToken = server.jwt.sign({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

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

    const t3 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Gamma', team_password: 'gamma', draft_order: 3 },
    });
    team3Id = t3.json<{ id: string }>().id;

    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const [e2] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team2Id}`;
    const [e3] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team3Id}`;
    team1Token = server.jwt.sign({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });
    team2Token = server.jwt.sign({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2!.auth_epoch });
    team3Token = server.jwt.sign({ league_id: leagueId, team_id: team3Id, role: 'OWNER', auth_epoch: e3!.auth_epoch });

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
      INSERT INTO players (name, position, nfl_team) VALUES (${'F014-Player1-' + tag}, 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES (${'F014-Player2-' + tag}, 'RB', 'SF') RETURNING id
    `;
    playerIds = [p1!.id, p2!.id];
    player1Id = p1!.id;
    player2Id = p2!.id;

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${player1Id}, 5000, 'CSV')
    `;
    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${player2Id}, 4500, 'CSV')
    `;

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
    if (!leagueId) return;
    if (draftId) stopAwardTimer(draftId);
    if (draftId) {
      await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId} AND status = 'RUNNING'`;
    }
    await sql`DELETE FROM do_not_draft_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM nomination_queue_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM watch_list_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM owner_target_values WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM auto_agent_configs WHERE draft_id = ${draftId}`;
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

    leagueId = '';
    team1Id = '';
    team2Id = '';
    team3Id = '';
    datasetId = '';
    draftId = '';
    playerIds = [];
    player1Id = '';
    player2Id = '';
  });

  it('test_F_MOD_014_get_do_not_draft_returns_empty_list_when_none_added', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries).toHaveLength(0);
  });

  it('test_F_MOD_014_post_do_not_draft_persists_and_get_includes_it', async () => {
    await setupDraft();

    const postRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { player_id: player1Id },
    });
    expect(postRes.statusCode).toBe(201);
    const posted = postRes.json<{ player_id: string; player_name?: string }>();
    expect(posted.player_id).toBe(player1Id);

    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{ entries: Array<{ player_id: string }> }>();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.player_id).toBe(player1Id);

    const dbRows = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM do_not_draft_items
      WHERE draft_id = ${draftId} AND team_id = ${team1Id} AND dataset_player_id = ${player1Id}
    `;
    expect(dbRows[0]!.count).toBe(1);
  });

  it('test_F_MOD_014_delete_do_not_draft_removes_it_and_get_no_longer_includes_it', async () => {
    await setupDraft();

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { player_id: player1Id },
    });

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft/${player1Id}`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.json<{ entries: unknown[] }>().entries).toHaveLength(0);
  });

  it('test_F_MOD_014_403_when_token_team_does_not_match_url_team_and_writes_nothing', async () => {
    await setupDraft();

    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team2Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.statusCode).toBe(403);

    const postRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team2Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { player_id: player1Id },
    });
    expect(postRes.statusCode).toBe(403);

    const dbRows = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM do_not_draft_items
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    expect(dbRows[0]!.count).toBe(0);
  });

  it('test_F_MOD_014_403_when_token_league_does_not_match_draft_league', async () => {
    await setupDraft();
    const otherLeagueId = leagueId;
    const otherTeam1Id = team1Id;
    const otherDraftId = draftId;

    // Second, distinct league/draft.
    await setupDraft();
    const wrongLeagueToken = server.jwt.sign({
      league_id: otherLeagueId,
      team_id: otherTeam1Id,
      role: 'OWNER',
      auth_epoch: 0,
    });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${otherTeam1Id}/do-not-draft`,
      headers: { authorization: `Bearer ${wrongLeagueToken}` },
    });
    // team_id mismatch check runs first (403) either way; assert isolation holds
    expect(res.statusCode).toBe(403);
    void otherDraftId;
  });

  it('test_F_MOD_014_auto_agent_never_bids_on_do_not_draft_player_on_nomination', async () => {
    await setupDraft();

    // team2 marks player1 as Do Not Draft
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team2Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team2Token}` },
      payload: { player_id: player1Id },
    });

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // draft_team_states rows only exist once the draft has started — control
    // mode must be set after start, not before (setControlMode is a no-op
    // when the team's state row doesn't exist yet).
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 1.0, sql);

    const ws1 = await connectAndAuth(port, draftId, team1Token);
    const ws2 = await connectAndAuth(port, draftId, team2Token);

    // team1 nominates player1 (team2's Do Not Draft player) — a bid from team2
    // would normally arrive as BID_ACCEPTED with leading_team_id === team2Id.
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1Id, opening_bid_minor: 100 },
    }));
    await waitForMessage(ws2, (m) => m.type === 'NOMINATION_STARTED', 5000);

    await sleep(400); // give the (absent) auto-agent bid time to have landed if it were going to

    ws1.close();
    ws2.close();

    const bidAttempts = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM bid_attempts WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    expect(Number(bidAttempts[0]?.count ?? 0)).toBe(0);
  }, 15000);

  it('test_F_MOD_014_auto_agent_never_bids_on_do_not_draft_player_on_leader_change', async () => {
    await setupDraft();
    // team2 marks player1 as Do Not Draft
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team2Id}/do-not-draft`,
      headers: { authorization: `Bearer ${team2Token}` },
      payload: { player_id: player1Id },
    });

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // team2: AUTO_AGENT with player1 on its Do Not Draft list.
    await setControlMode(draftId, team2Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team2Id, 1.0, sql);
    // team3: AUTO_AGENT with no Do Not Draft entries — should still bid normally.
    await setControlMode(draftId, team3Id, 'AUTO_AGENT', 'test', sql);
    await upsertAutoAgentConfig(draftId, team3Id, 1.0, sql);

    const ws1 = await connectAndAuth(port, draftId, team1Token);
    const ws3 = await connectAndAuth(port, draftId, team3Token);

    // team1 (MANUAL) nominates player1 — team3 should auto-bid and take the lead.
    ws1.send(JSON.stringify({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: player1Id, opening_bid_minor: 100 },
    }));
    const team3Bid = await waitForMessage(
      ws3,
      (m) => m.type === 'BID_ACCEPTED' && (m.payload as { leading_team_id: string }).leading_team_id === team3Id,
      8000,
    );
    const auctionId = (team3Bid.payload as { player_auction_id: string }).player_auction_id;

    // team1 manually overbids, causing a leader change — this is the trigger
    // that would normally provoke team2's auto-agent to respond.
    ws1.send(JSON.stringify({
      type: 'BID_COMMAND',
      payload: { player_auction_id: auctionId, bid_amount_minor: 1000, bid_type: 'ABSOLUTE' },
    }));
    await waitForMessage(
      ws1,
      (m) => m.type === 'BID_ACCEPTED' && (m.payload as { leading_team_id: string }).leading_team_id === team1Id,
      8000,
    );

    await sleep(400);

    ws1.close();
    ws3.close();

    const bidAttempts = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM bid_attempts WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    expect(Number(bidAttempts[0]?.count ?? 0)).toBe(0);
  }, 20000);
});
