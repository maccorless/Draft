/**
 * F-MOD-005: Commissioner Price Correction and Bounded Rollback
 *
 * Behavioral expectations tested:
 * 1. Price correction — valid: updates price, ledger, budget, appends DraftEvent, returns response
 * 2. Price correction — rejected when correction would make a later pick illegal (409)
 * 3. Price correction — non-commissioner returns 403, no DB changes
 * 4. Rollback — draft PAUSED: reverses N picks in reverse resolution_sequence order
 * 5. Rollback — draft not PAUSED returns 409, no DB changes
 * 6. Rollback — partial: rolls back only available picks when count exceeds available
 * 7. Rollback — WS broadcast sent to subscribers after commit
 * 8. Price correction — WS broadcast sent to subscribers after commit
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: { type: string; payload?: unknown }) => boolean,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('waitForWsMessage timed out')),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string; payload?: unknown };
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DB)('F-MOD-005 corrections and rollback', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  // Per-test state (reset in afterEach)
  let leagueId = '';
  let team1Id = '';
  let datasetId = '';
  let draftId = '';
  let player1Id = '';
  let commToken = '';
  let team1Token = '';

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

  /**
   * Set up a league + team + config + dataset + draft in the given status.
   * Inserts draft_team_states with initial_budget_minor.
   * Returns player dataset entry ids.
   */
  async function setupDraft(opts: {
    draftStatus?: 'RUNNING' | 'PAUSED' | 'CREATED';
    initialBudgetMinor?: number;
    totalRosterSize?: number;
  } = {}): Promise<{ playerEntryIds: string[] }> {
    const {
      draftStatus = 'PAUSED',
      initialBudgetMinor = 20000,
      totalRosterSize = 6,
    } = opts;

    // League
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F005 Test ${Date.now()}`,
        site_password: 's',
        commissioner_password: 'c',
      },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    commToken = makeToken({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    // Team
    const t1Res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Alpha', team_password: 'alpha', draft_order: 1 },
    });
    team1Id = t1Res.json<{ id: string }>().id;
    const [t1Row] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: t1Row!.auth_epoch });

    // Roster config
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
          { position: 'BN', priority: 99, is_starter: false, slot_count: totalRosterSize - 5 < 1 ? 1 : totalRosterSize - 5 },
        ],
      },
    });

    // Auction config
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: initialBudgetMinor,
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

    // Insert players + entries
    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F005-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F005-CMC', 'RB', 'SF') RETURNING id
    `;
    player1Id = p1!.id;

    const [en1] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 'CSV') RETURNING id
    `;
    const [en2] = await sql<[{ id: string }]>`
      INSERT INTO player_dataset_entries (dataset_id, player_id, aav_minor, source)
      VALUES (${datasetId}, ${p2!.id}, 4500, 'CSV') RETURNING id
    `;

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

    // Start draft to create draft_team_states, then set to desired status
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    // Pause if needed (start always → RUNNING)
    if (draftStatus === 'PAUSED') {
      await server.inject({
        method: 'POST',
        url: `/drafts/${draftId}/pause`,
        headers: { authorization: `Bearer ${commToken}` },
      });
    } else if (draftStatus === 'RUNNING') {
      // already RUNNING from start
    }

    return { playerEntryIds: [en1!.id, en2!.id] };
  }

  /**
   * Insert a fully resolved pick (player_auction AWARDED + acquisition + ledger + roster_entry).
   * Returns acquisition id.
   */
  async function insertAwardedPick(opts: {
    playerEntryId: string;
    teamId: string;
    priceMinor: number;
    resolutionSequence: number;
  }): Promise<string> {
    const { playerEntryId, teamId, priceMinor, resolutionSequence } = opts;

    // Insert player_auction (AWARDED)
    const [pa] = await sql<[{ id: string }]>`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
         auction_version, resolution_sequence)
      VALUES
        (${draftId}, ${playerEntryId}, 'AWARDED', ${priceMinor}, ${teamId}, 1, ${resolutionSequence})
      RETURNING id
    `;
    const playerAuctionId = pa!.id;

    // Insert acquisition
    const [acq] = await sql<[{ id: string }]>`
      INSERT INTO acquisitions
        (draft_id, team_id, player_auction_id, price_minor, resolution_sequence, active)
      VALUES
        (${draftId}, ${teamId}, ${playerAuctionId}, ${priceMinor}, ${resolutionSequence}, true)
      RETURNING id
    `;
    const acquisitionId = acq!.id;

    // Insert budget_ledger_entry (AWARD, negative amount = debit)
    await sql`
      INSERT INTO budget_ledger_entries
        (draft_id, team_id, acquisition_id, amount_minor, entry_type, active)
      VALUES
        (${draftId}, ${teamId}, ${acquisitionId}, ${-priceMinor}, 'AWARD', true)
    `;

    // Get a roster slot
    const [slotRow] = await sql<[{ id: string }]>`
      SELECT rsd.id FROM roster_slot_definitions rsd
      JOIN roster_configurations rc ON rc.id = rsd.config_id
      WHERE rc.league_id = ${leagueId}
      ORDER BY rsd.priority ASC
      LIMIT 1
    `;

    // Insert roster_entry
    await sql`
      INSERT INTO roster_entries
        (acquisition_id, draft_id, team_id, roster_slot_id, active)
      VALUES
        (${acquisitionId}, ${draftId}, ${teamId}, ${slotRow!.id}, true)
    `;

    // Update DraftTeamState
    await sql`
      UPDATE draft_team_states
      SET remaining_budget_minor = remaining_budget_minor - ${priceMinor},
          roster_filled_count = roster_filled_count + 1,
          required_remaining_spots = GREATEST(0, required_remaining_spots - 1)
      WHERE draft_id = ${draftId} AND team_id = ${teamId}
    `;

    return acquisitionId;
  }

  afterEach(async () => {
    if (!leagueId) return;

    // Clean in FK order
    if (draftId) {
      await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    }
    if (datasetId) {
      await sql`DELETE FROM player_dataset_entries WHERE dataset_id = ${datasetId}`;
      await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    }
    if (player1Id) {
      await sql`DELETE FROM players WHERE name LIKE 'F005-%'`;
    }
    if (leagueId) {
      await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
        SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
      )`;
      await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    }

    leagueId = '';
    team1Id = '';
    datasetId = '';
    draftId = '';
    player1Id = '';
    commToken = '';
    team1Token = '';
  });

  // ── Price Correction ──────────────────────────────────────────────────────

  it('test_F_MOD_005_price_correction_valid_updates_price_ledger_budget_and_appends_event', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });
    const acqId = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    const budgetBefore = before!.remaining_budget_minor; // 20000 - 1000 = 19000

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/corrections/price`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { acquisition_id: acqId, new_price_minor: 500 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      acquisition_id: string;
      old_price_minor: number;
      new_price_minor: number;
      team_id: string;
      new_remaining_budget_minor: number;
    }>();
    expect(body.acquisition_id).toBe(acqId);
    expect(body.old_price_minor).toBe(1000);
    expect(body.new_price_minor).toBe(500);
    expect(body.team_id).toBe(team1Id);
    expect(body.new_remaining_budget_minor).toBe(budgetBefore + 500); // refund of 500

    // Acquisition price updated in place
    const [acq] = await sql<[{ price_minor: number }]>`SELECT price_minor FROM acquisitions WHERE id = ${acqId}`;
    expect(acq!.price_minor).toBe(500);

    // Original BudgetLedgerEntry is superseded
    const oldEntries = await sql<[{ active: boolean; entry_type: string; amount_minor: number }]>`
      SELECT active, entry_type, amount_minor FROM budget_ledger_entries
      WHERE acquisition_id = ${acqId} AND entry_type = 'AWARD'
    `;
    expect(oldEntries.length).toBe(1);
    expect(oldEntries[0]!.active).toBe(false);

    // New CORRECTION entry appended
    const newEntry = await sql<[{ active: boolean; entry_type: string; amount_minor: number }]>`
      SELECT active, entry_type, amount_minor FROM budget_ledger_entries
      WHERE acquisition_id = ${acqId} AND entry_type = 'CORRECTION'
    `;
    expect(newEntry.length).toBe(1);
    expect(newEntry[0]!.active).toBe(true);
    expect(newEntry[0]!.amount_minor).toBe(-500); // new price as negative debit

    // DraftTeamState updated
    const [after] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(after!.remaining_budget_minor).toBe(budgetBefore + 500);

    // PRICE_CORRECTED DraftEvent appended
    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'PRICE_CORRECTED'
    `;
    expect(events.length).toBe(1);
  });

  it('test_F_MOD_005_price_correction_rejected_when_would_make_later_pick_illegal', async () => {
    // Small budget: initial=1000, totalRosterSize=2
    // Pick 1: 400, Pick 2: 500 (legal at time of award: remaining after p1=600, max_bid for p2=600-1*100=500 ✓)
    // If we correct p1 from 400 to 600: replay: budget=1000, p1 max=1000-1*100=900, 600<=900 ✓;
    // p2: budget=400, max=400-0*100=400, 500>400 → illegal
    const { playerEntryIds } = await setupDraft({
      draftStatus: 'PAUSED',
      initialBudgetMinor: 1000,
      totalRosterSize: 2,
    });

    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 400,
      resolutionSequence: 1,
    });
    await insertAwardedPick({
      playerEntryId: playerEntryIds[1]!,
      teamId: team1Id,
      priceMinor: 500,
      resolutionSequence: 2,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/corrections/price`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { acquisition_id: acq1Id, new_price_minor: 600 },
    });

    expect(res.statusCode).toBe(409);

    // No DB changes: original price unchanged
    const [acq] = await sql<[{ price_minor: number }]>`SELECT price_minor FROM acquisitions WHERE id = ${acq1Id}`;
    expect(acq!.price_minor).toBe(400);

    // No CORRECTION entry
    const corrEntries = await sql`
      SELECT id FROM budget_ledger_entries WHERE draft_id = ${draftId} AND entry_type = 'CORRECTION'
    `;
    expect(corrEntries.length).toBe(0);

    // No PRICE_CORRECTED event
    const events = await sql`
      SELECT id FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'PRICE_CORRECTED'
    `;
    expect(events.length).toBe(0);
  });

  it('test_F_MOD_005_price_correction_non_commissioner_returns_403', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });
    const acqId = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    // Use team owner token
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/corrections/price`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { acquisition_id: acqId, new_price_minor: 500 },
    });

    expect(res.statusCode).toBe(403);

    // Acquisition unchanged
    const [acq] = await sql<[{ price_minor: number }]>`SELECT price_minor FROM acquisitions WHERE id = ${acqId}`;
    expect(acq!.price_minor).toBe(1000);
  });

  it('test_F_MOD_005_price_correction_increasing_price_within_budget_is_valid', async () => {
    // Increasing price is valid as long as no later pick becomes illegal
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED', initialBudgetMinor: 20000 });
    const acqId = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    // Increase price from 1000 to 1500 — budget still positive (20000-1500=18500)
    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/corrections/price`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { acquisition_id: acqId, new_price_minor: 1500 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ old_price_minor: number; new_price_minor: number }>();
    expect(body.old_price_minor).toBe(1000);
    expect(body.new_price_minor).toBe(1500);

    // Budget decreased by 500
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    // 20000 - 1000 (original) - 500 (correction delta) = 18500
    expect(state!.remaining_budget_minor).toBe(18500);
  });

  // ── Rollback ──────────────────────────────────────────────────────────────

  it('test_F_MOD_005_rollback_when_paused_reverses_last_n_picks_in_order', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });

    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });
    const acq2Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[1]!,
      teamId: team1Id,
      priceMinor: 500,
      resolutionSequence: 2,
    });

    const [budgetBefore] = await sql<[{ remaining_budget_minor: number; roster_filled_count: number }]>`
      SELECT remaining_budget_minor, roster_filled_count FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 1 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      rolled_back: number;
      picks_reversed: Array<{ acquisition_id: string; player_name: string; team_id: string; price_minor: number }>;
    }>();
    expect(body.rolled_back).toBe(1);
    expect(body.picks_reversed).toHaveLength(1);
    // Should reverse the LAST pick (resolution_sequence=2, price=500)
    expect(body.picks_reversed[0]!.acquisition_id).toBe(acq2Id);
    expect(body.picks_reversed[0]!.price_minor).toBe(500);
    expect(body.picks_reversed[0]!.team_id).toBe(team1Id);
    expect(body.picks_reversed[0]!.player_name).toBe('F005-CMC');

    // acq2 is inactive, acq1 still active
    const [a2] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq2Id}`;
    expect(a2!.active).toBe(false);
    const [a1] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq1Id}`;
    expect(a1!.active).toBe(true);

    // Roster entries for acq2 are inactive
    const rosterEntries = await sql<[{ active: boolean }]>`
      SELECT active FROM roster_entries WHERE acquisition_id = ${acq2Id}
    `;
    expect(rosterEntries.every((r) => !r.active)).toBe(true);

    // ROLLBACK budget_ledger_entry inserted for acq2 (positive = refund)
    const rollbackEntry = await sql<[{ amount_minor: number; entry_type: string }]>`
      SELECT amount_minor, entry_type FROM budget_ledger_entries
      WHERE acquisition_id = ${acq2Id} AND entry_type = 'ROLLBACK'
    `;
    expect(rollbackEntry.length).toBe(1);
    expect(rollbackEntry[0]!.amount_minor).toBe(500); // positive refund

    // PlayerAuction for acq2 reset to PENDING
    const [pa2] = await sql<[{ status: string; resolution_sequence: number | null }]>`
      SELECT pa.status, pa.resolution_sequence FROM player_auctions pa
      JOIN acquisitions a ON a.player_auction_id = pa.id
      WHERE a.id = ${acq2Id}
    `;
    expect(pa2!.status).toBe('PENDING');
    expect(pa2!.resolution_sequence).toBeNull();

    // DraftTeamState updated (budget += 500, roster_filled_count -= 1)
    const [stateAfter] = await sql<[{ remaining_budget_minor: number; roster_filled_count: number }]>`
      SELECT remaining_budget_minor, roster_filled_count FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(stateAfter!.remaining_budget_minor).toBe(budgetBefore!.remaining_budget_minor + 500);
    expect(stateAfter!.roster_filled_count).toBe(budgetBefore!.roster_filled_count - 1);

    // ROLLBACK_APPLIED DraftEvent appended
    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'ROLLBACK_APPLIED'
    `;
    expect(events.length).toBe(1);
  });

  it('test_F_MOD_005_rollback_returns_409_when_draft_not_paused', async () => {
    await setupDraft({ draftStatus: 'RUNNING' });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 1 },
    });

    expect(res.statusCode).toBe(409);

    // No ROLLBACK_APPLIED event
    const events = await sql`
      SELECT id FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'ROLLBACK_APPLIED'
    `;
    expect(events.length).toBe(0);
  });

  it('test_F_MOD_005_rollback_partial_when_fewer_picks_available_than_count', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });

    // Only 1 pick, request count=5
    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 5 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rolled_back: number }>();
    expect(body.rolled_back).toBe(1); // only 1 available

    const [a1] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq1Id}`;
    expect(a1!.active).toBe(false);
  });

  it('test_F_MOD_005_rollback_non_commissioner_returns_403', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });
    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { count: 1 },
    });

    expect(res.statusCode).toBe(403);

    // Acquisition unchanged
    const [a1] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq1Id}`;
    expect(a1!.active).toBe(true);
  });

  it('test_F_MOD_005_rollback_multiple_picks_reversed_in_reverse_order', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });

    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });
    const acq2Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[1]!,
      teamId: team1Id,
      priceMinor: 500,
      resolutionSequence: 2,
    });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 2 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      rolled_back: number;
      picks_reversed: Array<{ acquisition_id: string; price_minor: number }>;
    }>();
    expect(body.rolled_back).toBe(2);
    expect(body.picks_reversed).toHaveLength(2);
    // First in response = highest resolution_sequence (most recent)
    expect(body.picks_reversed[0]!.acquisition_id).toBe(acq2Id);
    expect(body.picks_reversed[1]!.acquisition_id).toBe(acq1Id);

    // Both acquisitions inactive
    const [a1] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq1Id}`;
    const [a2] = await sql<[{ active: boolean }]>`SELECT active FROM acquisitions WHERE id = ${acq2Id}`;
    expect(a1!.active).toBe(false);
    expect(a2!.active).toBe(false);

    // Budget fully refunded (both picks reversed)
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state!.remaining_budget_minor).toBe(20000); // fully restored
  });

  it('test_F_MOD_005_rollback_no_picks_available_returns_409', async () => {
    await setupDraft({ draftStatus: 'PAUSED' });
    // No picks inserted

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 1 },
    });

    expect(res.statusCode).toBe(409);
  });

  it('test_F_MOD_005_price_correction_ws_broadcast_sent_to_subscribers', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });
    const acqId = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    // Connect WS and authenticate
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: commToken } }));
      });
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'AUTHENTICATED' || msg.type === 'STATE_SNAPSHOT') resolve();
        else if (msg.type === 'ERROR') reject(new Error(JSON.stringify(msg)));
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS auth timed out')), 5000);
    });

    // Trigger price correction and wait for broadcast
    const broadcastPromise = waitForWsMessage(
      ws,
      (msg) => msg.type === 'PRICE_CORRECTED',
      5000,
    );

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/corrections/price`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { acquisition_id: acqId, new_price_minor: 500 },
    });

    const broadcast = await broadcastPromise;
    expect(broadcast.type).toBe('PRICE_CORRECTED');
    const payload = broadcast.payload as {
      acquisition_id: string;
      old_price_minor: number;
      new_price_minor: number;
    };
    expect(payload.acquisition_id).toBe(acqId);
    expect(payload.old_price_minor).toBe(1000);
    expect(payload.new_price_minor).toBe(500);

    ws.close();
  });

  it('test_F_MOD_005_rollback_ws_broadcast_sent_to_subscribers', async () => {
    const { playerEntryIds } = await setupDraft({ draftStatus: 'PAUSED' });
    const acq1Id = await insertAwardedPick({
      playerEntryId: playerEntryIds[0]!,
      teamId: team1Id,
      priceMinor: 1000,
      resolutionSequence: 1,
    });

    // Connect WS and authenticate
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/drafts/${draftId}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token: commToken } }));
      });
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'AUTHENTICATED' || msg.type === 'STATE_SNAPSHOT') resolve();
        else if (msg.type === 'ERROR') reject(new Error(JSON.stringify(msg)));
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS auth timed out')), 5000);
    });

    const broadcastPromise = waitForWsMessage(
      ws,
      (msg) => msg.type === 'ROLLBACK_APPLIED',
      5000,
    );

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/rollback`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { count: 1 },
    });

    const broadcast = await broadcastPromise;
    expect(broadcast.type).toBe('ROLLBACK_APPLIED');
    // WS broadcast uses `count` per MOD-005-api-schema.yaml x-websocket-events
    const payload = broadcast.payload as { count: number; picks_reversed: unknown[] };
    expect(payload.count).toBe(1);
    expect(payload.picks_reversed).toHaveLength(1);

    ws.close();
    void acq1Id; // referenced in insertAwardedPick
  });
});
