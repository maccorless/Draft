/**
 * F-MOD-009: Commissioner Whammy: Budget Entertainment Events
 *
 * Behavioral expectations tested:
 * 1. Whammy disabled → POST 409, no WhammyEvent or ledger entry created
 * 2. max_per_team exceeded → POST 409, no ledger entry created
 * 3. max_per_draft exceeded → POST 409, no ledger entry created
 * 4. allow_positive=false + amount_minor>0 → POST 409, rejected
 * 5. allow_negative=false + amount_minor<0 → POST 409, rejected
 * 6. amount would breach roster-completion invariant → POST 409 (no override)
 * 7. approval_required=true → WhammyEvent PENDING_APPROVAL, no ledger, no broadcast
 * 8. PENDING_APPROVAL + reject → status=REJECTED, no budget effect
 * 9. PENDING_APPROVAL + approve → full apply in one transaction, broadcast sent
 * 10. approval_required=false → full apply in single transaction, broadcast sent
 * 11. Non-commissioner → 403, no state written
 * 12. Ledger reconciliation: remaining_budget = initial - sum(active ledger debits)
 * 13. WHAMMY_APPLIED WS broadcast delivers {team_id, amount_minor, description, new_remaining_budget_minor}
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

// ─── WS helper ───────────────────────────────────────────────────────────────

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

describe.skipIf(SKIP_DB)('F-MOD-009 whammy events', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  // Per-test state (reset in afterEach)
  let leagueId = '';
  let team1Id = '';
  let datasetId = '';
  let draftId = '';
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
   * Set up a league + team + dataset + draft in RUNNING status.
   * Also creates a whammy_config row. Returns player entry ids.
   */
  async function setupDraft(opts: {
    whammyEnabled?: boolean;
    allowPositive?: boolean;
    allowNegative?: boolean;
    maxPerTeam?: number | null;
    maxPerDraft?: number | null;
    commissionerApprovalRequired?: boolean;
    initialBudgetMinor?: number;
    totalRosterSize?: number;
    draftStatus?: 'RUNNING' | 'PAUSED' | 'CREATED';
  } = {}): Promise<{ playerEntryIds: string[] }> {
    const {
      whammyEnabled = true,
      allowPositive = true,
      allowNegative = true,
      maxPerTeam = null,
      maxPerDraft = null,
      commissionerApprovalRequired = false,
      initialBudgetMinor = 20000,
      totalRosterSize = 6,
      draftStatus = 'RUNNING',
    } = opts;

    // League
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F009 Test ${Date.now()}`,
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

    // Whammy config (insert directly — no API endpoint for config in this module)
    const [wc] = await sql<[{ id: string }]>`
      INSERT INTO whammy_configs
        (league_id, enabled, max_amount_minor, allowed_event_types,
         allow_positive, allow_negative, max_per_team, max_per_draft,
         commissioner_approval_required)
      VALUES
        (${leagueId}, ${whammyEnabled}, 100000, '{}',
         ${allowPositive}, ${allowNegative},
         ${maxPerTeam}, ${maxPerDraft},
         ${commissionerApprovalRequired})
      RETURNING id
    `;
    void wc!.id; // inserted but ID not used directly in tests

    // Dataset
    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    // Insert players + entries
    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F009-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F009-CMC', 'RB', 'SF') RETURNING id
    `;

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

    // Start draft → RUNNING
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    if (draftStatus === 'PAUSED') {
      await server.inject({
        method: 'POST',
        url: `/drafts/${draftId}/pause`,
        headers: { authorization: `Bearer ${commToken}` },
      });
    }

    return { playerEntryIds: [en1!.id, en2!.id] };
  }

  afterEach(async () => {
    if (!leagueId) return;

    if (draftId) {
      await sql`DELETE FROM whammy_events WHERE draft_id = ${draftId}`;
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
    if (leagueId) {
      await sql`DELETE FROM players WHERE name LIKE 'F009-%'`;
      await sql`DELETE FROM whammy_configs WHERE league_id = ${leagueId}`;
      // Note: whammyConfigId local used only in setupDraft, reset here
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
    commToken = '';
    team1Token = '';
  });

  // ── Behavioral test 1: Whammy disabled ───────────────────────────────────────

  it('test_F_MOD_009_disabled_config_rejects_whammy_with_no_state_written', async () => {
    await setupDraft({ whammyEnabled: false });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Bad luck' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('WHAMMY_DISABLED');

    // No WhammyEvent row
    const events = await sql`SELECT id FROM whammy_events WHERE draft_id = ${draftId}`;
    expect(events.length).toBe(0);

    // No ledger entry
    const ledger = await sql`SELECT id FROM budget_ledger_entries WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'`;
    expect(ledger.length).toBe(0);
  });

  // ── Behavioral test 2: max_per_team limit ─────────────────────────────────────

  it('test_F_MOD_009_max_per_team_exceeded_rejects_and_no_ledger_entry', async () => {
    await setupDraft({ maxPerTeam: 1 });

    // Manually insert an existing APPLIED WhammyEvent for this team
    await sql`
      INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status)
      VALUES (${draftId}, ${team1Id}, -100, 'Prior whammy', 'APPLIED')
    `;

    // Update budget state for the applied whammy
    await sql`
      UPDATE draft_team_states
      SET remaining_budget_minor = remaining_budget_minor - 100
      WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    await sql`
      INSERT INTO budget_ledger_entries (draft_id, team_id, amount_minor, entry_type, active)
      VALUES (${draftId}, ${team1Id}, -100, 'WHAMMY', true)
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -200, description: 'Another' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('WHAMMY_MAX_PER_TEAM_EXCEEDED');

    // Only the pre-inserted one exists
    const events = await sql`SELECT id FROM whammy_events WHERE draft_id = ${draftId} AND team_id = ${team1Id} AND status = 'APPLIED'`;
    expect(events.length).toBe(1);
  });

  // ── Behavioral test 3: max_per_draft limit ────────────────────────────────────

  it('test_F_MOD_009_max_per_draft_exceeded_rejects', async () => {
    await setupDraft({ maxPerDraft: 1 });

    // Insert one APPLIED whammy for the draft (can be any team)
    await sql`
      INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status)
      VALUES (${draftId}, ${team1Id}, -100, 'Prior', 'APPLIED')
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -200, description: 'Over limit' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('WHAMMY_MAX_PER_DRAFT_EXCEEDED');
  });

  // ── Behavioral test 4: allow_positive=false + positive amount ─────────────────

  it('test_F_MOD_009_allow_positive_false_rejects_positive_amount', async () => {
    await setupDraft({ allowPositive: false });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: 500, description: 'Bonus' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('WHAMMY_POSITIVE_NOT_ALLOWED');
  });

  // ── Behavioral test 5: allow_negative=false + negative amount ─────────────────

  it('test_F_MOD_009_allow_negative_false_rejects_negative_amount', async () => {
    await setupDraft({ allowNegative: false });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Penalty' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('WHAMMY_NEGATIVE_NOT_ALLOWED');
  });

  // ── Behavioral test 6: roster-completion invariant breach ─────────────────────

  it('test_F_MOD_009_amount_that_breaches_roster_completion_invariant_is_rejected', async () => {
    // 6 roster slots, initial_budget=600 (min required = 6 * $1 = $600, so no room for negatives)
    // After start, remaining_budget = 600, required_remaining_spots = 6
    // max_legal_bid = 600 - (6-1)*100 = 100 (minimum to bid on the next player)
    // A whammy of -1 would leave budget=599, and min required = 600 (6*100 = 600) → illegal
    await setupDraft({ initialBudgetMinor: 600, totalRosterSize: 6 });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -1, description: 'Tiny penalty' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('WHAMMY_ROSTER_COMPLETION_INFEASIBLE');
  });

  // ── Behavioral test 7: approval_required=true → PENDING_APPROVAL ───────────────

  it('test_F_MOD_009_approval_required_creates_pending_approval_no_ledger_no_broadcast', async () => {
    await setupDraft({ commissionerApprovalRequired: true });

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Approval needed' },
    });

    expect(res.statusCode).toBe(200);

    // WhammyEvent created with PENDING_APPROVAL status
    const events = await sql<[{ status: string; amount_minor: number }]>`
      SELECT status, amount_minor FROM whammy_events WHERE draft_id = ${draftId}
    `;
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe('PENDING_APPROVAL');
    expect(events[0]!.amount_minor).toBe(-500);

    // No ledger entry yet
    const ledger = await sql`SELECT id FROM budget_ledger_entries WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'`;
    expect(ledger.length).toBe(0);

    // No DraftEvent WHAMMY_APPLIED
    const draftEvents = await sql`SELECT id FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'WHAMMY_APPLIED'`;
    expect(draftEvents.length).toBe(0);

    // Budget unchanged
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state!.remaining_budget_minor).toBe(20000); // unchanged from initial
  });

  // ── Behavioral test 8: reject a PENDING_APPROVAL whammy ───────────────────────

  it('test_F_MOD_009_reject_pending_whammy_sets_rejected_no_budget_effect', async () => {
    await setupDraft({ commissionerApprovalRequired: true });

    const triggerRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Will reject' },
    });
    expect(triggerRes.statusCode).toBe(200);
    const triggerBody = triggerRes.json<{ whammy_id: string }>();
    const whammyId = triggerBody.whammy_id;

    // Budget before
    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    const budgetBefore = before!.remaining_budget_minor;

    const rejectRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy/${whammyId}/reject`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(rejectRes.statusCode).toBe(200);
    const rejectBody = rejectRes.json<{ whammy_id: string; status: string }>();
    expect(rejectBody.whammy_id).toBe(whammyId);
    expect(rejectBody.status).toBe('REJECTED');

    // Status updated in DB
    const [we] = await sql<[{ status: string }]>`SELECT status FROM whammy_events WHERE id = ${whammyId}`;
    expect(we!.status).toBe('REJECTED');

    // No budget change
    const [after] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(after!.remaining_budget_minor).toBe(budgetBefore);

    // No ledger entry
    const ledger = await sql`SELECT id FROM budget_ledger_entries WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'`;
    expect(ledger.length).toBe(0);
  });

  // ── Behavioral test 9: approve a PENDING_APPROVAL whammy ─────────────────────

  it('test_F_MOD_009_approve_pending_whammy_applies_budget_effect_in_transaction', async () => {
    await setupDraft({ commissionerApprovalRequired: true });

    const triggerRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Pending approval whammy' },
    });
    expect(triggerRes.statusCode).toBe(200);
    const whammyId = triggerRes.json<{ whammy_id: string }>().whammy_id;

    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    const budgetBefore = before!.remaining_budget_minor;

    const approveRes = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy/${whammyId}/approve`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    expect(approveRes.statusCode).toBe(200);
    const body = approveRes.json<{
      team_id: string;
      amount_minor: number;
      new_remaining_budget_minor: number;
    }>();
    expect(body.team_id).toBe(team1Id);
    expect(body.amount_minor).toBe(-500);
    expect(body.new_remaining_budget_minor).toBe(budgetBefore - 500);

    // WhammyEvent status = APPLIED
    const [we] = await sql<[{ status: string; budget_ledger_entry_id: string | null }]>`
      SELECT status, budget_ledger_entry_id FROM whammy_events WHERE id = ${whammyId}
    `;
    expect(we!.status).toBe('APPLIED');
    expect(we!.budget_ledger_entry_id).not.toBeNull();

    // BudgetLedgerEntry created with entry_type=WHAMMY, reference_id=whammyId
    const [ble] = await sql<[{ amount_minor: number; entry_type: string; reference_id: string; active: boolean }]>`
      SELECT amount_minor, entry_type, reference_id, active
      FROM budget_ledger_entries
      WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'
    `;
    expect(ble).toBeDefined();
    expect(ble!.amount_minor).toBe(-500);
    expect(ble!.entry_type).toBe('WHAMMY');
    expect(ble!.reference_id).toBe(whammyId);
    expect(ble!.active).toBe(true);

    // DraftTeamState updated
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state!.remaining_budget_minor).toBe(budgetBefore - 500);

    // WHAMMY_APPLIED DraftEvent appended
    const draftEvents = await sql<[{ event_type: string; payload: unknown }]>`
      SELECT event_type, payload FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'WHAMMY_APPLIED'
    `;
    expect(draftEvents.length).toBe(1);
  });

  // ── Behavioral test 10: approval_required=false → immediate apply ─────────────

  it('test_F_MOD_009_no_approval_required_applies_immediately_in_single_transaction', async () => {
    await setupDraft({ commissionerApprovalRequired: false });

    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    const budgetBefore = before!.remaining_budget_minor;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Immediate whammy' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      team_id: string;
      amount_minor: number;
      new_remaining_budget_minor: number;
    }>();
    expect(body.team_id).toBe(team1Id);
    expect(body.amount_minor).toBe(-500);
    expect(body.new_remaining_budget_minor).toBe(budgetBefore - 500);

    // WhammyEvent status = APPLIED immediately
    const [we] = await sql<[{ id: string; status: string; budget_ledger_entry_id: string | null }]>`
      SELECT id, status, budget_ledger_entry_id FROM whammy_events WHERE draft_id = ${draftId}
    `;
    expect(we!.status).toBe('APPLIED');
    expect(we!.budget_ledger_entry_id).not.toBeNull();

    // BudgetLedgerEntry exists with correct amount and reference_id pointing to the whammy event
    const [ble] = await sql<[{ amount_minor: number; reference_id: string; entry_type: string }]>`
      SELECT amount_minor, reference_id, entry_type
      FROM budget_ledger_entries
      WHERE draft_id = ${draftId} AND entry_type = 'WHAMMY'
    `;
    expect(ble!.amount_minor).toBe(-500);
    expect(ble!.entry_type).toBe('WHAMMY');
    // reference_id on the ledger entry points back to the whammy_events.id
    expect(ble!.reference_id).toBe(we!.id);

    // DraftTeamState updated
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(state!.remaining_budget_minor).toBe(budgetBefore - 500);

    // WHAMMY_APPLIED DraftEvent
    const draftEvents = await sql`
      SELECT id FROM draft_events WHERE draft_id = ${draftId} AND event_type = 'WHAMMY_APPLIED'
    `;
    expect(draftEvents.length).toBe(1);
  });

  // ── Behavioral test 11: non-commissioner → 403 ────────────────────────────────

  it('test_F_MOD_009_non_commissioner_returns_403_no_state_written', async () => {
    await setupDraft();

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { team_id: team1Id, amount_minor: -500, description: 'Unauthorized' },
    });

    expect(res.statusCode).toBe(403);

    // No whammy_events row
    const events = await sql`SELECT id FROM whammy_events WHERE draft_id = ${draftId}`;
    expect(events.length).toBe(0);
  });

  // ── Behavioral test 12: ledger reconciliation ─────────────────────────────────

  it('test_F_MOD_009_remaining_budget_equals_initial_minus_sum_of_active_ledger_debits', async () => {
    await setupDraft({ commissionerApprovalRequired: false });

    // Apply two whammies
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -300, description: 'First' },
    });
    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -200, description: 'Second' },
    });

    // Get DraftTeamState
    const [state] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;

    // Get initial budget from auction config
    const [cfg] = await sql<[{ initial_budget_minor: number }]>`
      SELECT initial_budget_minor FROM auction_configurations WHERE league_id = ${leagueId}
    `;

    // Sum all active ledger entries for this team (debits are negative)
    const [ledgerSum] = await sql<[{ total: number }]>`
      SELECT COALESCE(SUM(amount_minor), 0)::int AS total
      FROM budget_ledger_entries
      WHERE draft_id = ${draftId} AND team_id = ${team1Id} AND active = true
    `;

    // Invariant: remaining_budget = initial + sum_of_all_active_entries
    // (debits are negative so sum is negative → initial + negative = reduced budget)
    const expected = cfg!.initial_budget_minor + ledgerSum!.total;
    expect(state!.remaining_budget_minor).toBe(expected);
    expect(state!.remaining_budget_minor).toBe(20000 - 300 - 200);
  });

  // ── Behavioral test 13: WS broadcast ─────────────────────────────────────────

  it('test_F_MOD_009_whammy_applied_ws_broadcast_delivers_correct_payload', async () => {
    await setupDraft({ commissionerApprovalRequired: false });

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
      (msg) => msg.type === 'WHAMMY_APPLIED',
      5000,
    );

    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: -750, description: 'Big penalty' },
    });

    const broadcast = await broadcastPromise;
    expect(broadcast.type).toBe('WHAMMY_APPLIED');
    const payload = broadcast.payload as {
      team_id: string;
      amount_minor: number;
      description: string;
      new_remaining_budget_minor: number;
    };
    expect(payload.team_id).toBe(team1Id);
    expect(payload.amount_minor).toBe(-750);
    expect(payload.description).toBe('Big penalty');
    expect(payload.new_remaining_budget_minor).toBe(before!.remaining_budget_minor - 750);

    ws.close();
  });

  // ── Behavioral test: positive whammy (bonus) ──────────────────────────────────

  it('test_F_MOD_009_positive_whammy_increases_team_budget', async () => {
    await setupDraft({ allowPositive: true, commissionerApprovalRequired: false });

    const [before] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/whammy`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { team_id: team1Id, amount_minor: 500, description: 'Lucky bonus' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ new_remaining_budget_minor: number }>();
    expect(body.new_remaining_budget_minor).toBe(before!.remaining_budget_minor + 500);

    const [after] = await sql<[{ remaining_budget_minor: number }]>`
      SELECT remaining_budget_minor FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(after!.remaining_budget_minor).toBe(before!.remaining_budget_minor + 500);
  });
});
