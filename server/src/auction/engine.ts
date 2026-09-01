/**
 * Auction Engine — core bid pipeline, nomination, and award logic.
 *
 * Critical invariants (from CLAUDE.md):
 * 1. server_receipt_time stamped BEFORE this code runs (in the WS handler).
 * 2. auth_epoch re-read from DB on every command (passed in, not from token).
 * 3. Bid atomicity: validate → transaction → commit → in-memory update → broadcast.
 * 4. All money as *_minor integers, no floating point.
 * 5. Anti-sniping extends rebid_deadline within the same transaction.
 * 6. max_legal_bid = remaining_budget_minor - (required_remaining_spots - 1) * 100.
 * 7. Starter-first roster assignment (lowest priority unfilled starter, then bench).
 * 8. Multi-draft isolation: every command checks draft.league_id == token.league_id.
 */
import type WebSocket from 'ws';
import postgres from 'postgres';

import { AsyncQueue } from './queue.js';

export interface DraftRuntime {
  queue: AsyncQueue;
  clients: Set<WebSocket>;
  awardTimer: ReturnType<typeof setInterval> | null;
  /** Per-team session tracking: Map<team_id, Set<WebSocket>> for multi-window identity */
  teamSessions: Map<string, Set<WebSocket>>;
  /** Grace timers: when all of a team's windows drop, a timer is started (F-MOD-004 acts on expiry) */
  graceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// ─── Per-draft runtimes (keyed by draft_id) ──────────────────────────────────
// ponytail: module-level map is safe because multi-draft isolation is enforced at
// the command level (draft.league_id check) — not just routing.
const draftRuntimes = new Map<string, DraftRuntime>();

export function getOrCreateRuntime(draftId: string): DraftRuntime {
  let rt = draftRuntimes.get(draftId);
  if (!rt) {
    rt = { queue: new AsyncQueue(), clients: new Set(), awardTimer: null, teamSessions: new Map(), graceTimers: new Map() };
    draftRuntimes.set(draftId, rt);
  }
  return rt;
}

export function removeRuntime(draftId: string): void {
  const rt = draftRuntimes.get(draftId);
  if (rt?.awardTimer) clearInterval(rt.awardTimer);
  for (const t of rt?.graceTimers.values() ?? []) clearTimeout(t);
  draftRuntimes.delete(draftId);
}

/**
 * Register a WebSocket connection for a given team.
 * Adds to both the flat broadcast set and the per-team set.
 * Clears any existing grace timer for this team (reconnect within grace).
 */
export function registerTeamSession(
  draftId: string,
  teamId: string,
  ws: WebSocket,
  gracePeriodMs = 60_000,
  onGraceExpired?: (draftId: string, teamId: string) => void,
): void {
  const rt = getOrCreateRuntime(draftId);
  rt.clients.add(ws);

  if (!rt.teamSessions.has(teamId)) {
    rt.teamSessions.set(teamId, new Set());
  }
  rt.teamSessions.get(teamId)!.add(ws);

  // Clear grace timer if reconnecting within grace period
  const existing = rt.graceTimers.get(teamId);
  if (existing) {
    clearTimeout(existing);
    rt.graceTimers.delete(teamId);
  }

  void gracePeriodMs; // captured for use in unregister — stored per-usage
  void onGraceExpired;
}

/**
 * Unregister a WebSocket connection for a given team.
 * If this was the last connection for the team, start the grace timer.
 */
export function unregisterTeamSession(
  draftId: string,
  teamId: string,
  ws: WebSocket,
  gracePeriodMs = 60_000,
  onGraceExpired?: (draftId: string, teamId: string) => void,
): void {
  const rt = draftRuntimes.get(draftId);
  if (!rt) return;
  rt.clients.delete(ws);

  const teamSet = rt.teamSessions.get(teamId);
  if (teamSet) {
    teamSet.delete(ws);
    if (teamSet.size === 0) {
      rt.teamSessions.delete(teamId);
      // All windows for this team dropped — start grace timer
      const timer = setTimeout(() => {
        rt.graceTimers.delete(teamId);
        if (onGraceExpired) onGraceExpired(draftId, teamId);
      }, gracePeriodMs);
      rt.graceTimers.set(teamId, timer);
    }
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

export function broadcast(draftId: string, message: object): void {
  const rt = draftRuntimes.get(draftId);
  if (!rt) return;
  const payload = JSON.stringify(message);
  for (const ws of rt.clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

// ─── Auth epoch re-read ───────────────────────────────────────────────────────

export interface TokenClaims {
  league_id: string;
  team_id?: string;
  role: string;
  auth_epoch: number;
}

export async function readAuthEpoch(
  sql: postgres.Sql,
  claims: TokenClaims,
): Promise<number | null> {
  if (claims.role === 'OWNER' && claims.team_id) {
    const rows = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM teams WHERE id = ${claims.team_id} LIMIT 1
    `;
    return rows[0]?.auth_epoch ?? null;
  }
  const rows = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
  `;
  return rows[0]?.auth_epoch ?? null;
}

// ─── max_legal_bid ─────────────────────────────────────────────────────────────

export function computeMaxLegalBid(
  remainingBudgetMinor: number,
  requiredRemainingSpots: number,
): number {
  // Per spec: max_legal_bid = remaining_budget_minor - (required_remaining_spots - 1) * 100
  // All integer arithmetic, no floating point.
  return remainingBudgetMinor - Math.max(0, requiredRemainingSpots - 1) * 100;
}

// ─── Next draft_events sequence ───────────────────────────────────────────────

async function nextDraftEventSequence(
  tx: postgres.TransactionSql,
  draftId: string,
): Promise<number> {
  const rows = await tx<[{ max: number | null }]>`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS max
    FROM draft_events WHERE draft_id = ${draftId}
  `;
  return rows[0]?.max ?? 0;
}

// ─── BID_COMMAND processing ───────────────────────────────────────────────────

export interface BidCommandPayload {
  player_auction_id: string;
  bid_amount_minor: number;
  bid_type: 'ABSOLUTE' | 'RELATIVE' | 'NOMINATOR_MATCH';
  expected_current_bid_minor?: number;
  expected_auction_version?: number;
}

export interface BidContext {
  draftId: string;
  teamId: string;
  leagueId: string; // from token
  serverReceiptTime: Date;
  sql: postgres.Sql;
  command: BidCommandPayload;
}

export async function processBidCommand(ctx: BidContext): Promise<void> {
  const { draftId, teamId, leagueId, serverReceiptTime, sql, command } = ctx;

  // 1. Load draft — verify RUNNING and league_id matches token
  const draftRows = await sql<[{
    id: string;
    league_id: string;
    status: string;
    dataset_id: string;
  }]>`
    SELECT id, league_id, status, dataset_id FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'DRAFT_NOT_FOUND', reason: 'Draft not found' },
    });
    return;
  }
  // Multi-draft isolation: verify league_id matches token
  if (draft.league_id !== leagueId) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'LEAGUE_MISMATCH', reason: 'Token league does not match draft' },
    });
    return;
  }
  if (draft.status !== 'RUNNING') {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: {
        player_auction_id: command.player_auction_id,
        code: 'DRAFT_NOT_RUNNING',
        reason: `Draft is ${draft.status}`,
      },
    });
    return;
  }

  // 2. Load auction config
  const auctionCfgRows = await sql<[{
    anti_snipe_threshold_ms: number;
    anti_snipe_extension_ms: number;
    min_bid_minor: number;
    rebid_timer_ms: number;
  }]>`
    SELECT anti_snipe_threshold_ms, anti_snipe_extension_ms, min_bid_minor, rebid_timer_ms
    FROM auction_configurations
    WHERE league_id = ${draft.league_id}
    LIMIT 1
  `;
  const auctionCfg = auctionCfgRows[0];
  if (!auctionCfg) {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'NO_AUCTION_CONFIG', reason: 'Auction configuration missing' },
    });
    return;
  }

  // 3. Load PlayerAuction
  const auctionRows = await sql<[{
    id: string;
    draft_id: string;
    status: string;
    current_bid_minor: number;
    current_leader_id: string | null;
    auction_version: number;
    rebid_deadline: Date | null;
  }]>`
    SELECT id, draft_id, status, current_bid_minor, current_leader_id, auction_version, rebid_deadline
    FROM player_auctions
    WHERE id = ${command.player_auction_id} AND draft_id = ${draftId}
    LIMIT 1
  `;
  const auction = auctionRows[0];
  if (!auction) {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'AUCTION_NOT_FOUND', reason: 'PlayerAuction not found' },
    });
    return;
  }
  if (auction.status !== 'OPEN') {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'AUCTION_NOT_OPEN', reason: `Auction is ${auction.status}` },
    });
    return;
  }

  // 4. Stale-state check for RELATIVE / NOMINATOR_MATCH
  if (command.bid_type === 'RELATIVE' || command.bid_type === 'NOMINATOR_MATCH') {
    if (
      command.expected_current_bid_minor !== auction.current_bid_minor ||
      command.expected_auction_version !== auction.auction_version
    ) {
      // Record rejected bid attempt
      await sql`
        INSERT INTO bid_attempts
          (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
           expected_current_bid_minor, expected_auction_version,
           server_receipt_time, accepted, rejection_reason)
        VALUES
          (${draftId}, ${command.player_auction_id}, ${teamId}, ${command.bid_amount_minor},
           ${command.bid_type},
           ${command.expected_current_bid_minor ?? null},
           ${command.expected_auction_version ?? null},
           ${serverReceiptTime.toISOString()},
           false, 'STALE_STATE')
      `;
      broadcast(draftId, {
        type: 'BID_REJECTED',
        payload: {
          player_auction_id: command.player_auction_id,
          code: 'STALE_STATE',
          reason: 'Expected bid or version does not match current state',
        },
      });
      return;
    }
  }

  // 5. bid_amount_minor must exceed current_bid_minor
  if (command.bid_amount_minor <= auction.current_bid_minor) {
    await sql`
      INSERT INTO bid_attempts
        (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
         server_receipt_time, accepted, rejection_reason)
      VALUES
        (${draftId}, ${command.player_auction_id}, ${teamId}, ${command.bid_amount_minor},
         ${command.bid_type}, ${serverReceiptTime.toISOString()},
         false, 'BID_TOO_LOW')
    `;
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: {
        player_auction_id: command.player_auction_id,
        code: 'BID_TOO_LOW',
        reason: `Bid ${command.bid_amount_minor} must exceed current ${auction.current_bid_minor}`,
      },
    });
    return;
  }

  // 6. Load DraftTeamState for the bidding team — for max_legal_bid
  const teamStateRows = await sql<[{
    remaining_budget_minor: number;
    required_remaining_spots: number;
    roster_filled_count: number;
  }]>`
    SELECT remaining_budget_minor, required_remaining_spots, roster_filled_count
    FROM draft_team_states
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;
  const teamState = teamStateRows[0];
  if (!teamState) {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'TEAM_STATE_NOT_FOUND', reason: 'Team draft state not found' },
    });
    return;
  }

  const maxLegalBid = computeMaxLegalBid(
    teamState.remaining_budget_minor,
    teamState.required_remaining_spots,
  );
  if (command.bid_amount_minor > maxLegalBid) {
    await sql`
      INSERT INTO bid_attempts
        (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
         server_receipt_time, accepted, rejection_reason)
      VALUES
        (${draftId}, ${command.player_auction_id}, ${teamId}, ${command.bid_amount_minor},
         ${command.bid_type}, ${serverReceiptTime.toISOString()},
         false, 'EXCEEDS_MAX_LEGAL_BID')
    `;
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: {
        player_auction_id: command.player_auction_id,
        code: 'EXCEEDS_MAX_LEGAL_BID',
        reason: `Bid ${command.bid_amount_minor} exceeds max legal bid ${maxLegalBid}`,
      },
    });
    return;
  }

  // 7. Anti-snipe check
  // postgres.js may return timestamptz as a string or Date depending on context;
  // normalise to Date before arithmetic.
  let antiSnipeExtended = false;
  let newRebidDeadline = auction.rebid_deadline
    ? new Date(auction.rebid_deadline as unknown as string | Date)
    : null;
  if (newRebidDeadline) {
    const msToDeadline = newRebidDeadline.getTime() - serverReceiptTime.getTime();
    if (msToDeadline >= 0 && msToDeadline <= auctionCfg.anti_snipe_threshold_ms) {
      antiSnipeExtended = true;
      newRebidDeadline = new Date(newRebidDeadline.getTime() + auctionCfg.anti_snipe_extension_ms);
    }
  }

  // 8. Atomic transaction: UPDATE player_auction + INSERT bid_attempt + INSERT draft_event
  let newVersion: number;
  let finalRebidDeadlineTs: number;

  try {
    await sql.begin(async (tx) => {
      newVersion = auction.auction_version + 1;
      const rebidDeadlineForUpdate = newRebidDeadline ?? new Date(serverReceiptTime.getTime() + auctionCfg.rebid_timer_ms);

      // UPDATE player_auctions
      await tx`
        UPDATE player_auctions
        SET current_bid_minor = ${command.bid_amount_minor},
            current_leader_id = ${teamId},
            auction_version = ${newVersion},
            rebid_deadline = ${rebidDeadlineForUpdate.toISOString()}
        WHERE id = ${command.player_auction_id}
      `;

      finalRebidDeadlineTs = rebidDeadlineForUpdate.getTime();

      // INSERT bid_attempt (accepted=true)
      await tx`
        INSERT INTO bid_attempts
          (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
           expected_current_bid_minor, expected_auction_version,
           server_receipt_time, accepted, rejection_reason)
        VALUES
          (${draftId}, ${command.player_auction_id}, ${teamId}, ${command.bid_amount_minor},
           ${command.bid_type},
           ${command.expected_current_bid_minor ?? null},
           ${command.expected_auction_version ?? null},
           ${serverReceiptTime.toISOString()},
           true, null)
      `;

      // INSERT draft_event
      const seq = await nextDraftEventSequence(tx, draftId);
      await tx`
        INSERT INTO draft_events
          (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
        VALUES
          (${draftId}, ${seq}, 'BID_ACCEPTED',
           ${teamId}, ${command.player_auction_id},
           ${JSON.stringify({
             bid_amount_minor: command.bid_amount_minor,
             auction_version: newVersion,
             anti_snipe_extended: antiSnipeExtended,
           })}::jsonb,
           ${serverReceiptTime.toISOString()})
      `;
    });
  } catch (err) {
    console.error('[engine] BID transaction failed:', err);
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'TRANSACTION_FAILED', reason: 'Internal error' },
    });
    return;
  }

  // 9. In-memory update after commit — broadcast BID_ACCEPTED
  broadcast(draftId, {
    type: 'BID_ACCEPTED',
    payload: {
      player_auction_id: command.player_auction_id,
      bid_amount_minor: command.bid_amount_minor,
      leading_team_id: teamId,
      auction_version: newVersion!,
      rebid_deadline_ts: finalRebidDeadlineTs!,
      anti_snipe_extended: antiSnipeExtended,
    },
  });
}

// ─── NOMINATE_COMMAND processing ──────────────────────────────────────────────

export interface NominateCommandPayload {
  player_dataset_entry_id: string;
  opening_bid_minor: number;
}

export interface NominateContext {
  draftId: string;
  teamId: string;
  leagueId: string;
  serverReceiptTime: Date;
  sql: postgres.Sql;
  command: NominateCommandPayload;
  systemNominated?: boolean;
}

export async function processNominateCommand(ctx: NominateContext): Promise<void> {
  const { draftId, teamId, leagueId, sql, command, systemNominated = false } = ctx;

  // Load draft + auction config in parallel
  const [draftRows, cfgRows] = await Promise.all([
    sql<[{ id: string; league_id: string; status: string; dataset_id: string }]>`
      SELECT id, league_id, status, dataset_id FROM drafts WHERE id = ${draftId} LIMIT 1
    `,
    sql<[{
      nomination_timer_ms: number;
      second_bid_timer_ms: number;
      rebid_timer_ms: number;
      min_bid_minor: number;
    }]>`
      SELECT nomination_timer_ms, second_bid_timer_ms, rebid_timer_ms, min_bid_minor
      FROM auction_configurations
      WHERE league_id = ${leagueId}
      LIMIT 1
    `,
  ]);

  const draft = draftRows[0];
  if (!draft || draft.league_id !== leagueId || draft.status !== 'RUNNING') {
    return; // silently skip
  }

  const cfg = cfgRows[0];
  if (!cfg) return;

  if (command.opening_bid_minor < cfg.min_bid_minor) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'BID_TOO_LOW', reason: `Opening bid must be at least ${cfg.min_bid_minor}` },
    });
    return;
  }

  // Check no current OPEN auction
  const openRows = await sql<[{ id: string }]>`
    SELECT id FROM player_auctions
    WHERE draft_id = ${draftId} AND status = 'OPEN'
    LIMIT 1
  `;
  if (openRows.length > 0) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'AUCTION_ALREADY_OPEN', reason: 'Another auction is currently OPEN' },
    });
    return;
  }

  // Verify player is in the frozen dataset and not already nominated
  const playerRows = await sql<[{ id: string; name: string; position: string }]>`
    SELECT pde.id, p.name, p.position
    FROM player_dataset_entries pde
    JOIN players p ON p.id = pde.player_id
    WHERE pde.id = ${command.player_dataset_entry_id}
      AND pde.dataset_id = ${draft.dataset_id}
    LIMIT 1
  `;
  const player = playerRows[0];
  if (!player) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'PLAYER_NOT_FOUND', reason: 'Player not in this draft dataset' },
    });
    return;
  }

  // Check player hasn't been nominated already (AWARDED or OPEN)
  const alreadyRows = await sql<[{ id: string }]>`
    SELECT id FROM player_auctions
    WHERE draft_id = ${draftId}
      AND dataset_player_id = ${command.player_dataset_entry_id}
      AND status IN ('OPEN', 'AWARDED')
    LIMIT 1
  `;
  if (alreadyRows.length > 0) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'PLAYER_ALREADY_NOMINATED', reason: 'Player already nominated' },
    });
    return;
  }

  const now = new Date();
  const nominationDeadline = new Date(now.getTime() + cfg.nomination_timer_ms);
  const secondBidDeadline = new Date(now.getTime() + cfg.second_bid_timer_ms);

  let auctionId: string;
  let seq: number;

  try {
    await sql.begin(async (tx) => {
      // INSERT player_auction
      const auctionRows = await tx<[{ id: string }]>`
        INSERT INTO player_auctions
          (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id,
           auction_version, nomination_deadline, rebid_deadline, nominator_team_id)
        VALUES
          (${draftId}, ${command.player_dataset_entry_id}, 'OPEN',
           ${command.opening_bid_minor}, ${teamId},
           1,
           ${nominationDeadline.toISOString()},
           ${secondBidDeadline.toISOString()},
           ${teamId})
        RETURNING id
      `;
      auctionId = auctionRows[0]!.id;

      seq = await nextDraftEventSequence(tx, draftId);
      await tx`
        INSERT INTO draft_events
          (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
        VALUES
          (${draftId}, ${seq}, 'NOMINATION_STARTED',
           ${teamId}, ${auctionId},
           ${JSON.stringify({
             player_name: player.name,
             opening_bid_minor: command.opening_bid_minor,
             system_nominated: systemNominated,
           })}::jsonb,
           NOW())
      `;
    });
  } catch (err) {
    console.error('[engine] NOMINATE transaction failed:', err);
    return;
  }

  broadcast(draftId, {
    type: 'NOMINATION_STARTED',
    payload: {
      player_auction_id: auctionId!,
      player_name: player.name,
      nominator_team_id: teamId,
      opening_bid_minor: command.opening_bid_minor,
      nomination_deadline_ts: nominationDeadline.getTime(),
      second_bid_deadline_ts: secondBidDeadline.getTime(),
      system_nominated: systemNominated,
    },
  });
}

// ─── PASS_NOMINATION processing ───────────────────────────────────────────────

export async function processPassNomination(
  draftId: string,
  teamId: string,
  leagueId: string,
  sql: postgres.Sql,
): Promise<void> {
  // Load draft
  const draftRows = await sql<[{
    id: string;
    league_id: string;
    status: string;
    nomination_cursor: number;
  }]>`
    SELECT id, league_id, status, nomination_cursor
    FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft || draft.league_id !== leagueId || draft.status !== 'RUNNING') return;

  // Get all teams ordered by draft_order
  const teamsRows = await sql<[{ id: string; draft_order: number }]>`
    SELECT id, draft_order FROM teams WHERE league_id = ${leagueId}
    ORDER BY draft_order ASC
  `;
  if (teamsRows.length === 0) return;

  const currentCursor = draft.nomination_cursor;
  const newCursor = (currentCursor + 1) % teamsRows.length;
  const nextTeam = teamsRows[newCursor];
  if (!nextTeam) return;

  const cfgRows2 = await sql<[{ nomination_timer_ms: number }]>`
    SELECT nomination_timer_ms FROM auction_configurations WHERE league_id = ${leagueId} LIMIT 1
  `;
  const nominationDeadlineMs = Date.now() + (cfgRows2[0]?.nomination_timer_ms ?? 90000);

  await sql.begin(async (tx) => {
    await tx`UPDATE drafts SET nomination_cursor = ${newCursor} WHERE id = ${draftId}`;
    const seq = await nextDraftEventSequence(tx, draftId);
    await tx`
      INSERT INTO draft_events (draft_id, sequence, event_type, team_id, payload, created_at)
      VALUES (${draftId}, ${seq}, 'NOMINATION_TURN_CHANGED', ${nextTeam.id},
              ${JSON.stringify({ next_team_id: nextTeam.id })}::jsonb, NOW())
    `;
  });

  broadcast(draftId, {
    type: 'NOMINATION_TURN_CHANGED',
    payload: {
      current_nominator_team_id: nextTeam.id,
      nomination_deadline_ts: nominationDeadlineMs,
    },
  });
}

// ─── Award timer ──────────────────────────────────────────────────────────────

interface AwardableAuction {
  id: string;
  draft_id: string;
  league_id: string;
  current_bid_minor: number;
  current_leader_id: string;
  dataset_player_id: string;
  player_name: string;
  player_position: string;
}

async function findAwardableAuctions(sql: postgres.Sql): Promise<AwardableAuction[]> {
  return sql<AwardableAuction[]>`
    SELECT
      pa.id, pa.draft_id, d.league_id,
      pa.current_bid_minor, pa.current_leader_id,
      pa.dataset_player_id, p.name AS player_name, p.position AS player_position
    FROM player_auctions pa
    JOIN drafts d ON d.id = pa.draft_id
    JOIN player_dataset_entries pde ON pde.id = pa.dataset_player_id
    JOIN players p ON p.id = pde.player_id
    WHERE pa.status = 'OPEN'
      AND pa.rebid_deadline < NOW()
      AND pa.current_bid_minor > 0
      AND pa.current_leader_id IS NOT NULL
      AND d.status = 'RUNNING'
  `;
}

/**
 * Starter-first roster assignment:
 * - Find the lowest-priority unfilled starter slot matching the player's position.
 * - Fall back to any unfilled bench slot.
 * - Never reshuffles prior assignments.
 */
async function assignRosterSlot(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
  leagueId: string,
  playerPosition: string,
): Promise<{ slotId: string; slotLabel: string } | null> {
  // Get all slot definitions ordered by is_starter DESC (starters first), then priority ASC
  const slotsRows = await sql<[{
    id: string;
    position: string;
    priority: number;
    is_starter: boolean;
    slot_count: number;
  }]>`
    SELECT rsd.id, rsd.position, rsd.priority, rsd.is_starter, rsd.slot_count
    FROM roster_slot_definitions rsd
    JOIN roster_configurations rc ON rc.id = rsd.config_id
    WHERE rc.league_id = ${leagueId}
    ORDER BY rsd.is_starter DESC, rsd.priority ASC
  `;

  // Count how many players are assigned to each slot definition for this team+draft
  const filledCountsRows = await sql<[{ roster_slot_id: string; filled: number }]>`
    SELECT roster_slot_id, COUNT(*)::int AS filled
    FROM roster_entries
    WHERE draft_id = ${draftId} AND team_id = ${teamId} AND active = true
    GROUP BY roster_slot_id
  `;
  const filledMap = new Map<string, number>(
    filledCountsRows.map((r) => [r.roster_slot_id, r.filled]),
  );

  // Find first eligible unfilled slot
  for (const slot of slotsRows) {
    const filled = filledMap.get(slot.id) ?? 0;
    if (filled >= slot.slot_count) continue; // slot is full

    // Position matching: exact match, or FLEX (accepts RB/WR/TE), or BN (accepts all)
    const pos = slot.position.toUpperCase();
    const playerPos = playerPosition.toUpperCase();
    if (
      pos === playerPos ||
      pos === 'BN' ||
      pos === 'BENCH' ||
      (pos === 'FLEX' && ['RB', 'WR', 'TE', 'RB/WR/TE'].includes(playerPos))
    ) {
      return { slotId: slot.id, slotLabel: slot.position };
    }
  }

  // No matching slot found — should not happen if roster is configured correctly
  return null;
}

export async function processAwardCycle(sql: postgres.Sql): Promise<void> {
  let awardable: AwardableAuction[];
  try {
    awardable = await findAwardableAuctions(sql);
  } catch {
    return; // DB might be temporarily unavailable
  }

  for (const auction of awardable) {
    try {
      await awardAuction(sql, auction);
    } catch (err) {
      console.error(`[engine] Award failed for auction ${auction.id}:`, err);
    }
  }
}

async function awardAuction(sql: postgres.Sql, auction: AwardableAuction): Promise<void> {
  const { id: auctionId, draft_id: draftId, league_id: leagueId } = auction;

  // Find roster slot
  const slot = await assignRosterSlot(
    sql,
    draftId,
    auction.current_leader_id,
    leagueId,
    auction.player_position,
  );

  let resolutionSequence: number;
  let acquisitionId: string;

  await sql.begin(async (tx) => {
    // Get next resolution_sequence
    const seqRows = await tx<[{ max: number | null }]>`
      SELECT COALESCE(MAX(resolution_sequence), 0) + 1 AS max
      FROM acquisitions WHERE draft_id = ${draftId}
    `;
    resolutionSequence = seqRows[0]?.max ?? 1;

    // UPDATE player_auction → AWARDED
    await tx`
      UPDATE player_auctions
      SET status = 'AWARDED', resolution_sequence = ${resolutionSequence}
      WHERE id = ${auctionId}
    `;

    // INSERT acquisition
    const acqRows = await tx<[{ id: string }]>`
      INSERT INTO acquisitions
        (draft_id, team_id, player_auction_id, price_minor, resolution_sequence, active)
      VALUES
        (${draftId}, ${auction.current_leader_id}, ${auctionId},
         ${auction.current_bid_minor}, ${resolutionSequence}, true)
      RETURNING id
    `;
    acquisitionId = acqRows[0]!.id;

    // INSERT budget_ledger_entry (negative amount = spend)
    await tx`
      INSERT INTO budget_ledger_entries
        (draft_id, team_id, acquisition_id, amount_minor, entry_type, active)
      VALUES
        (${draftId}, ${auction.current_leader_id}, ${acquisitionId},
         ${-auction.current_bid_minor}, 'AWARD', true)
    `;

    // UPDATE draft_team_states
    await tx`
      UPDATE draft_team_states
      SET remaining_budget_minor = remaining_budget_minor - ${auction.current_bid_minor},
          roster_filled_count = roster_filled_count + 1,
          required_remaining_spots = GREATEST(0, required_remaining_spots - 1)
      WHERE draft_id = ${draftId} AND team_id = ${auction.current_leader_id}
    `;

    // INSERT roster_entry (if slot found)
    if (slot) {
      await tx`
        INSERT INTO roster_entries
          (acquisition_id, draft_id, team_id, roster_slot_id, active)
        VALUES
          (${acquisitionId}, ${draftId}, ${auction.current_leader_id}, ${slot.slotId}, true)
      `;
    }

    // INSERT draft_event PLAYER_AWARDED
    const eventSeq = await nextDraftEventSequence(tx, draftId);
    await tx`
      INSERT INTO draft_events
        (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
      VALUES
        (${draftId}, ${eventSeq}, 'PLAYER_AWARDED',
         ${auction.current_leader_id}, ${auctionId},
         ${JSON.stringify({
           player_name: auction.player_name,
           winning_team_id: auction.current_leader_id,
           price_minor: auction.current_bid_minor,
           roster_slot: slot?.slotLabel ?? 'BN',
           resolution_sequence: resolutionSequence,
         })}::jsonb,
         NOW())
    `;
  });

  broadcast(draftId, {
    type: 'PLAYER_AWARDED',
    payload: {
      player_auction_id: auctionId,
      player_name: auction.player_name,
      winning_team_id: auction.current_leader_id,
      price_minor: auction.current_bid_minor,
      roster_slot: slot?.slotLabel ?? 'BN',
      resolution_sequence: resolutionSequence!,
    },
  });
}

// ─── Start/stop award timer for a draft ──────────────────────────────────────

export function startAwardTimer(draftId: string, sql: postgres.Sql): void {
  const rt = getOrCreateRuntime(draftId);
  if (rt.awardTimer) return; // already running
  rt.awardTimer = setInterval(() => {
    processAwardCycle(sql).catch((err) => {
      console.error('[engine] award cycle error:', err);
    });
  }, 500);
}

export function stopAwardTimer(draftId: string): void {
  const rt = draftRuntimes.get(draftId);
  if (!rt) return;
  if (rt.awardTimer) {
    clearInterval(rt.awardTimer);
    rt.awardTimer = null;
  }
}
