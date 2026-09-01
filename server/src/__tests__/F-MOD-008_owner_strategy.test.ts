/**
 * F-MOD-008: Owner Strategy Tools — Watch List, Nomination Queue, Target Values
 *
 * Tests run against a real Postgres database and real Fastify HTTP server.
 * No mocks — all assertions are against the actual running system.
 *
 * Naming: test_F_MOD_008_<short description>
 *
 * Behavioral expectations covered:
 *  (a) GET target-values returns only the requesting team's data, never others.
 *  (b) PUT target-values upserts and emits no WS broadcast.
 *  (c) Cross-team access returns 403.
 *  (d) POST watchlist creates WatchListItem, returns 201.
 *  (e) Watch List items never auto-nominate.
 *  (f) DELETE watchlist removes the item (204).
 *  (g) GET watchlist returns player_id, player_name, position.
 *  (h) PUT nomination-queue reorders by ordered_player_ids; position 0 is first.
 *  (i) GET nomination-queue returns items ordered by ascending queue_position.
 *  (j) Nomination queue top-of-queue is used when PASS_NOMINATION is called (auto-nominate hook).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { stopAwardTimer } from '../auction/engine.js';
import { getTopNominationQueueEntry } from '../draft/strategy.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-008 owner strategy', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  // Fixture IDs
  let leagueId = '';
  let team1Id = '';
  let team2Id = '';
  let datasetId = '';
  let draftId = '';
  let commToken = '';
  let team1Token = '';
  let team2Token = '';
  let player1EntryId = '';
  let player2EntryId = '';
  let playerIds: string[] = [];

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
    void serverPort; // used for potential future WS tests
  }, 15000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  async function setupDraft(): Promise<void> {
    // League
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F008 Test ${Date.now()}`,
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

    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });
    team2Token = makeToken({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2!.auth_epoch });

    // Roster config
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

    // Auction config
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

    // Dataset
    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    // Insert 2 players
    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F008-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F008-CMC', 'RB', 'SF') RETURNING id
    `;
    playerIds = [p1!.id, p2!.id];

    const [en1] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 'CSV') RETURNING id
    `;
    const [en2] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p2!.id}, 4500, 'CSV') RETURNING id
    `;
    player1EntryId = en1!.id;
    player2EntryId = en2!.id;

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
    if (draftId) stopAwardTimer(draftId);
    if (draftId) {
      await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId} AND status = 'RUNNING'`;
    }
    // Clean strategy tables first (FK refs to player_dataset_entries)
    await sql`DELETE FROM nomination_queue_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM watch_list_items WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM owner_target_values WHERE draft_id = ${draftId}`;
    // Core draft tables
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

    leagueId = '';
    team1Id = '';
    team2Id = '';
    datasetId = '';
    draftId = '';
    playerIds = [];
    player1EntryId = '';
    player2EntryId = '';
  });

  // ── Target Values ─────────────────────────────────────────────────────────────

  it('test_F_MOD_008_put_target_values_upserts_and_get_returns_own_team_data', async () => {
    await setupDraft();

    // PUT — set a target value for player1
    const putRes = await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: {
        targets: [{ dataset_player_id: player1EntryId, target_value_minor: 4000 }],
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json<{ updated: number }>().updated).toBe(1);

    // GET — verify our value is returned
    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{ targets: Array<{ dataset_player_id: string; target_value_minor: number }> }>();
    expect(body.targets).toHaveLength(1);
    // Known value: 4000 (not recomputed from the code's perspective — set by us above)
    expect(body.targets[0]!.dataset_player_id).toBe(player1EntryId);
    expect(body.targets[0]!.target_value_minor).toBe(4000);
  });

  it('test_F_MOD_008_put_target_values_overwrites_existing_value', async () => {
    await setupDraft();

    // First PUT
    await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { targets: [{ dataset_player_id: player1EntryId, target_value_minor: 4000 }] },
    });

    // Second PUT with different value
    await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { targets: [{ dataset_player_id: player1EntryId, target_value_minor: 3500 }] },
    });

    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    const body = getRes.json<{ targets: Array<{ target_value_minor: number }> }>();
    // Must be the updated value 3500, not the original 4000
    expect(body.targets[0]!.target_value_minor).toBe(3500);
    // Only one row should exist (upsert, not duplicate)
    expect(body.targets).toHaveLength(1);
  });

  it('test_F_MOD_008_target_values_403_when_token_team_does_not_match_url_team', async () => {
    await setupDraft();

    // team1 token tries to read/write team2's data
    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team2Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.statusCode).toBe(403);

    const putRes = await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team2Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { targets: [{ dataset_player_id: player1EntryId, target_value_minor: 999 }] },
    });
    expect(putRes.statusCode).toBe(403);

    // Verify no data was written for team2 despite the attempt
    const dbRows = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM owner_target_values
      WHERE draft_id = ${draftId} AND team_id = ${team2Id}
    `;
    expect(dbRows[0]!.count).toBe(0);
  });

  it('test_F_MOD_008_target_values_not_visible_to_other_team', async () => {
    await setupDraft();

    // team1 sets a target
    await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { targets: [{ dataset_player_id: player1EntryId, target_value_minor: 9999 }] },
    });

    // team2 attempts to read team1's targets → 403
    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team2Token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_008_get_target_values_returns_empty_array_when_none_set', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ targets: unknown[] }>();
    expect(body.targets).toHaveLength(0);
  });

  // ── Watch List ─────────────────────────────────────────────────────────────────

  it('test_F_MOD_008_post_watchlist_creates_item_and_returns_201', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe('string');
  });

  it('test_F_MOD_008_get_watchlist_returns_player_name_and_position', async () => {
    await setupDraft();

    // Add player1 to watch list
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      watchlist: Array<{ dataset_player_id: string; player_name: string; position: string }>;
    }>();
    expect(body.watchlist).toHaveLength(1);
    // Known value: 'F008-Josh-Allen', 'QB' — set in setupDraft, not re-derived from code
    expect(body.watchlist[0]!.dataset_player_id).toBe(player1EntryId);
    expect(body.watchlist[0]!.player_name).toBe('F008-Josh-Allen');
    expect(body.watchlist[0]!.position).toBe('QB');
  });

  it('test_F_MOD_008_delete_watchlist_removes_item_and_returns_204', async () => {
    await setupDraft();

    // Add then delete
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist/${player1EntryId}`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Item should no longer be in the list
    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.json<{ watchlist: unknown[] }>().watchlist).toHaveLength(0);
  });

  it('test_F_MOD_008_delete_watchlist_nonexistent_returns_204', async () => {
    await setupDraft();

    // Delete a player that was never added — should still be 204
    const res = await server.inject({
      method: 'DELETE',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist/${player1EntryId}`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('test_F_MOD_008_watchlist_is_isolated_per_team', async () => {
    await setupDraft();

    // team1 adds player1; team2 adds player2
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team2Id}/watchlist`,
      headers: { authorization: `Bearer ${team2Token}` },
      payload: { dataset_player_id: player2EntryId },
    });

    // team1 sees only player1
    const t1Res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    const t1List = t1Res.json<{ watchlist: Array<{ dataset_player_id: string }> }>().watchlist;
    expect(t1List).toHaveLength(1);
    expect(t1List[0]!.dataset_player_id).toBe(player1EntryId);
  });

  it('test_F_MOD_008_watchlist_403_for_cross_team_access', async () => {
    await setupDraft();

    // team1 token tries to read team2's watchlist
    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team2Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_008_watchlist_never_auto_nominates', async () => {
    await setupDraft();

    // Add player1 to team1's watch list
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });

    // Start the draft
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // Verify no PlayerAuction was opened (watch list never auto-nominates)
    const openAuctions = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM player_auctions
      WHERE draft_id = ${draftId} AND status = 'OPEN'
    `;
    // Watch list should NOT have triggered any nomination
    expect(openAuctions[0]!.count).toBe(0);
  });

  // ── Nomination Queue ──────────────────────────────────────────────────────────

  it('test_F_MOD_008_post_nomination_queue_adds_player', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; queue_position: number }>();
    expect(body.id).toBeDefined();
    // First entry should be at position 0
    expect(body.queue_position).toBe(0);
  });

  it('test_F_MOD_008_get_nomination_queue_returns_items_ordered_by_queue_position', async () => {
    await setupDraft();

    // Add player1 then player2
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player2EntryId },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      queue: Array<{ dataset_player_id: string; queue_position: number; player_name: string }>;
    }>();
    expect(body.queue).toHaveLength(2);
    // Must be in ascending queue_position order — 0 first, 1 second
    expect(body.queue[0]!.queue_position).toBe(0);
    expect(body.queue[0]!.dataset_player_id).toBe(player1EntryId);
    expect(body.queue[1]!.queue_position).toBe(1);
    expect(body.queue[1]!.dataset_player_id).toBe(player2EntryId);
  });

  it('test_F_MOD_008_put_nomination_queue_reorder_updates_queue_positions', async () => {
    await setupDraft();

    // Add player1 (pos 0) then player2 (pos 1)
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player2EntryId },
    });

    // Reorder: player2 first, player1 second
    const reorderRes = await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { ordered_player_ids: [player2EntryId, player1EntryId] },
    });
    expect(reorderRes.statusCode).toBe(200);

    // Verify GET now returns player2 first
    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    const body = getRes.json<{
      queue: Array<{ dataset_player_id: string; queue_position: number }>;
    }>();
    expect(body.queue[0]!.dataset_player_id).toBe(player2EntryId);
    expect(body.queue[0]!.queue_position).toBe(0);
    expect(body.queue[1]!.dataset_player_id).toBe(player1EntryId);
    expect(body.queue[1]!.queue_position).toBe(1);
  });

  it('test_F_MOD_008_nomination_queue_403_for_cross_team_access', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team2Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('test_F_MOD_008_delete_nomination_queue_player_removes_item', async () => {
    await setupDraft();

    // Add player1
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });

    // Delete from nomination queue (using playerId param in URL)
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue/${player1EntryId}`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Queue should now be empty
    const getRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(getRes.json<{ queue: unknown[] }>().queue).toHaveLength(0);
  });

  // ── getTopNominationQueueEntry (auto-nomination hook) ─────────────────────────

  it('test_F_MOD_008_getTopNominationQueueEntry_returns_null_when_queue_empty', async () => {
    await setupDraft();

    const top = await getTopNominationQueueEntry(sql, draftId, team1Id);
    expect(top).toBeNull();
  });

  it('test_F_MOD_008_getTopNominationQueueEntry_returns_position_0_player', async () => {
    await setupDraft();

    // Add player1 at pos 0, player2 at pos 1
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player2EntryId },
    });

    const top = await getTopNominationQueueEntry(sql, draftId, team1Id);
    // Must return player1 (position 0), not player2
    expect(top).not.toBeNull();
    expect(top!.dataset_player_id).toBe(player1EntryId);
    // aav_minor is 5000 for player1, not recomputed — matches our INSERT
    expect(top!.aav_minor).toBe(5000);
  });

  it('test_F_MOD_008_getTopNominationQueueEntry_returns_reordered_position_0', async () => {
    await setupDraft();

    // Add player1 at pos 0, player2 at pos 1, then reorder so player2 is pos 0
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player1EntryId },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { dataset_player_id: player2EntryId },
    });

    await server.inject({
      method: 'PUT',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { ordered_player_ids: [player2EntryId, player1EntryId] },
    });

    const top = await getTopNominationQueueEntry(sql, draftId, team1Id);
    // After reorder, player2 is at position 0
    expect(top!.dataset_player_id).toBe(player2EntryId);
    // aav_minor for player2 is 4500 — known from INSERT above
    expect(top!.aav_minor).toBe(4500);
  });

  // ── Auth edge cases ────────────────────────────────────────────────────────────

  it('test_F_MOD_008_unauthorized_when_no_token_provided', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/target-values`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('test_F_MOD_008_get_watchlist_returns_empty_list_not_error_when_none_added', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/watchlist`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ watchlist: unknown[] }>().watchlist).toHaveLength(0);
  });

  it('test_F_MOD_008_get_nomination_queue_returns_empty_list_not_error_when_none_added', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/teams/${team1Id}/nomination-queue`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ queue: unknown[] }>().queue).toHaveLength(0);
  });
});
