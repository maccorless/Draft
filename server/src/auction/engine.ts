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
import { resolveEffectivePrimarySource, resolvePlayerPrimaryAav } from '../player/aav-resolution.js';
import { getFirstLegalNominationQueueEntry } from '../draft/strategy.js';

export interface DraftRuntime {
  queue: AsyncQueue;
  clients: Set<WebSocket>;
  awardTimer: ReturnType<typeof setInterval> | null;
  /** Per-team session tracking: Map<team_id, Set<WebSocket>> for multi-window identity */
  teamSessions: Map<string, Set<WebSocket>>;
  /** Grace timers: when all of a team's windows drop, a timer is started (F-MOD-004 acts on expiry) */
  graceTimers: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * Nomination-turn deadline for the CURRENT nominator (MANUAL teams only —
   * F-MOD-002-rework-01). Cleared whenever a nomination actually starts (manual
   * or system) or a new turn is dispatched. At most one pending at a time.
   */
  nominationTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Per-draft runtimes (keyed by draft_id) ──────────────────────────────────
// ponytail: module-level map is safe because multi-draft isolation is enforced at
// the command level (draft.league_id check) — not just routing.
const draftRuntimes = new Map<string, DraftRuntime>();

// ─── Draft completion flag (keyed by draft_id) ───────────────────────────────
// Tracks whether a draft just completed in a transaction, used for post-commit broadcast.
// ponytail: short-lived flag; set inside tx scope, read immediately after commit.
const draftCompletedMap = new Map<string, boolean>();

export function getOrCreateRuntime(draftId: string): DraftRuntime {
  let rt = draftRuntimes.get(draftId);
  if (!rt) {
    rt = {
      queue: new AsyncQueue(),
      clients: new Set(),
      awardTimer: null,
      teamSessions: new Map(),
      graceTimers: new Map(),
      nominationTimer: null,
    };
    draftRuntimes.set(draftId, rt);
  }
  return rt;
}

/** Live connection counts for the Draft Health panel (F-MOD-011) — read-only. */
export function getConnectionCounts(draftId: string): {
  connectedTeamCount: number;
  reconnectingTeamCount: number;
} {
  const rt = draftRuntimes.get(draftId);
  if (!rt) return { connectedTeamCount: 0, reconnectingTeamCount: 0 };
  return {
    connectedTeamCount: rt.teamSessions.size,
    reconnectingTeamCount: rt.graceTimers.size,
  };
}

export function removeRuntime(draftId: string): void {
  const rt = draftRuntimes.get(draftId);
  if (rt?.awardTimer) clearInterval(rt.awardTimer);
  if (rt?.nominationTimer) clearTimeout(rt.nominationTimer);
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

// ─── Post-nomination hook (auto-agent reactive bidding) ───────────────────────
// engine.ts cannot import auto-agent.ts (auto-agent.ts already imports engine.ts
// for processBidCommand/broadcast/computeMaxLegalBid — importing back would be
// circular). Auto-nomination (F-MOD-002-rework-01) still needs to trigger other
// AUTO_AGENT teams' reactive bidding after a system-nominated auction opens, the
// same way the WS handler does after a manual NOMINATE_COMMAND. main.ts wires
// this hook to auto-agent.ts's triggerAutoAgentBidsOnNomination at boot.

export type PostNominationHook = (
  draftId: string,
  leagueId: string,
  playerAuctionId: string,
  currentBidMinor: number,
  nominatorTeamId: string,
  sql: postgres.Sql,
) => Promise<void>;

let postNominationHook: PostNominationHook | null = null;

export function setPostNominationHook(hook: PostNominationHook): void {
  postNominationHook = hook;
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

export interface BidResult {
  accepted: boolean;
  leadingTeamId?: string;
  bidAmountMinor?: number;
  playerAuctionId: string;
}

export async function processBidCommand(ctx: BidContext): Promise<BidResult> {
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
  }
  // Multi-draft isolation: verify league_id matches token
  if (draft.league_id !== leagueId) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'LEAGUE_MISMATCH', reason: 'Token league does not match draft' },
    });
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
  }
  if (auction.status !== 'OPEN') {
    broadcast(draftId, {
      type: 'BID_REJECTED',
      payload: { player_auction_id: command.player_auction_id, code: 'AUCTION_NOT_OPEN', reason: `Auction is ${auction.status}` },
    });
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
      return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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
    return { accepted: false, playerAuctionId: command.player_auction_id };
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

  return {
    accepted: true,
    leadingTeamId: teamId,
    bidAmountMinor: command.bid_amount_minor,
    playerAuctionId: command.player_auction_id,
  };
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

export interface NominateResult {
  succeeded: boolean;
  auctionId?: string;
  openingBidMinor?: number;
  nominatorTeamId?: string;
}

export async function processNominateCommand(ctx: NominateContext): Promise<NominateResult> {
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
    return { succeeded: false }; // silently skip
  }

  const cfg = cfgRows[0];
  if (!cfg) return { succeeded: false };

  if (command.opening_bid_minor < cfg.min_bid_minor) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'BID_TOO_LOW', reason: `Opening bid must be at least ${cfg.min_bid_minor}` },
    });
    return { succeeded: false };
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
    return { succeeded: false };
  }

  // Verify player is in the frozen dataset and not already nominated.
  // Full detail (not just id/name/position) is selected here so the
  // NOMINATION_STARTED broadcast below can carry it — clients otherwise have
  // no way to know a newly-nominated player's team/tier/AAV until a second
  // round trip, and carrying forward the *previous* auction's values would
  // be actively wrong. AAV/tier are resolved from the dataset's effective
  // primary AAV source (F-MOD-016) — a player may have rows from more than
  // one source, so this is not a plain join anymore.
  const effectiveSource = await resolveEffectivePrimarySource(sql, draft.dataset_id);
  const playerRows = await sql<[{
    id: string;
    name: string;
    position: string;
    nfl_team: string;
    tier: number | null;
    aav_minor: number | null;
    projected_points: string | null;
  }]>`
    SELECT p.id, p.name, p.position, p.nfl_team, pas.tier, pas.aav_minor, pas.projected_points
    FROM players p
    LEFT JOIN player_aav_sources pas
      ON pas.player_id = p.id AND pas.dataset_id = ${draft.dataset_id} AND pas.source = ${effectiveSource}
    WHERE p.id = ${command.player_dataset_entry_id}
      AND EXISTS (
        SELECT 1 FROM player_aav_sources x
        WHERE x.player_id = p.id AND x.dataset_id = ${draft.dataset_id}
      )
    LIMIT 1
  `;
  const player = playerRows[0];
  if (!player) {
    broadcast(draftId, {
      type: 'ERROR',
      payload: { code: 'PLAYER_NOT_FOUND', reason: 'Player not in this draft dataset' },
    });
    return { succeeded: false };
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
    return { succeeded: false };
  }

  const now = new Date();
  const nominationDeadline = new Date(now.getTime() + cfg.nomination_timer_ms);
  const secondBidDeadline = new Date(now.getTime() + cfg.second_bid_timer_ms);

  let auctionId: string;
  let seq: number;
  let nominationPayload: {
    player_auction_id: string;
    player_name: string;
    position: string;
    nfl_team: string;
    tier: number | null;
    aav_minor: number;
    projected_points: number | null;
    nominator_team_id: string;
    opening_bid_minor: number;
    nomination_deadline_ts: number;
    second_bid_deadline_ts: number;
    system_nominated: boolean;
  };
  let nominationAudioPayload: { team_id: string; audio_url: string; duration_cap_ms: number } | null = null;

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

      // Built once and reused for both the persisted draft_event and the live
      // broadcast below — reconnect replay sends exactly this same payload
      // shape (session/routes.ts's WS handler merges in sequence/team_id/
      // player_auction_id/created_at itself), so a reconnecting client must
      // see byte-identical data to a client that was live for the original
      // broadcast. Two separately-hand-written payload literals previously
      // drifted apart (the persisted one was missing nominator_team_id,
      // position, etc. entirely), which silently corrupted a reconnecting
      // client's state during replay.
      nominationPayload = {
        player_auction_id: auctionId!,
        player_name: player.name,
        position: player.position,
        nfl_team: player.nfl_team,
        tier: player.tier,
        aav_minor: player.aav_minor ?? 0,
        projected_points: player.projected_points !== null ? Number(player.projected_points) : null,
        nominator_team_id: teamId,
        opening_bid_minor: command.opening_bid_minor,
        nomination_deadline_ts: nominationDeadline.getTime(),
        second_bid_deadline_ts: secondBidDeadline.getTime(),
        system_nominated: systemNominated,
      };

      seq = await nextDraftEventSequence(tx, draftId);
      await tx`
        INSERT INTO draft_events
          (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
        VALUES
          (${draftId}, ${seq}, 'NOMINATION_STARTED',
           ${teamId}, ${auctionId},
           ${JSON.stringify(nominationPayload)}::jsonb,
           NOW())
      `;

      // Nomination-audio (F-MOD-015): fires at most once per team per draft,
      // in this same transaction, when the nominating team has a
      // nomination_audio_url and hasn't played it yet this draft.
      const audioRows = await tx<[{ nomination_audio_url: string | null }]>`
        SELECT t.nomination_audio_url
        FROM teams t
        JOIN draft_team_states dts ON dts.team_id = t.id AND dts.draft_id = ${draftId}
        WHERE t.id = ${teamId} AND dts.nomination_audio_played = false
        LIMIT 1
      `;
      const audioUrl = audioRows[0]?.nomination_audio_url ?? null;
      if (audioUrl) {
        await tx`
          UPDATE draft_team_states SET nomination_audio_played = true
          WHERE draft_id = ${draftId} AND team_id = ${teamId}
        `;
        nominationAudioPayload = { team_id: teamId, audio_url: audioUrl, duration_cap_ms: 5000 };
      }
    });
  } catch (err) {
    console.error('[engine] NOMINATE transaction failed:', err);
    return { succeeded: false };
  }

  // A nomination just started (manual or system) — any pending nomination-turn
  // deadline for this draft is now moot (F-MOD-002-rework-01).
  const rt = getOrCreateRuntime(draftId);
  if (rt.nominationTimer) {
    clearTimeout(rt.nominationTimer);
    rt.nominationTimer = null;
  }

  broadcast(draftId, { type: 'NOMINATION_STARTED', payload: nominationPayload! });
  if (nominationAudioPayload) {
    broadcast(draftId, { type: 'TEAM_NOMINATION_AUDIO', payload: nominationAudioPayload });
  }

  return {
    succeeded: true,
    auctionId: auctionId!,
    openingBidMinor: command.opening_bid_minor,
    nominatorTeamId: teamId,
  };
}

// ─── Auto-nomination (F-MOD-002-rework-01) ─────────────────────────────────────
//
// Both trigger paths — an AUTO_AGENT team's turn (immediate, no timer) and a
// MANUAL team's nomination-timer expiry — select a player the same way and
// route through the same processNominateCommand path as a manual nomination
// (systemNominated: true), so second-bid timer start, the DraftEvent append,
// and the Auto-Agent reactive-bidding trigger on other AUTO_AGENT teams all
// fire identically to a manual nomination.

/**
 * Selects the player an auto-nomination should open:
 * (1) the first legal (not already OPEN/AWARDED) entry in the team's
 *     Nomination Queue, if one exists; otherwise
 * (2) the highest-aav_minor available player at a position where the team
 *     still has an open roster slot (starter or bench), excluding any player
 *     on the team's Do Not Draft list.
 * Returns null if no eligible player exists (nothing left to nominate).
 */
async function selectAutoNominationPlayer(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
  leagueId: string,
  datasetId: string,
): Promise<{ playerId: string } | null> {
  const queueEntry = await getFirstLegalNominationQueueEntry(sql, draftId, teamId);
  if (queueEntry) return { playerId: queueEntry.dataset_player_id };

  const effectiveSource = await resolveEffectivePrimarySource(sql, datasetId);
  const candidates = await sql<Array<{ id: string; position: string }>>`
    SELECT p.id, p.position
    FROM players p
    JOIN player_aav_sources pas
      ON pas.player_id = p.id AND pas.dataset_id = ${datasetId} AND pas.source = ${effectiveSource}
    WHERE NOT EXISTS (
        SELECT 1 FROM player_auctions pa
        WHERE pa.draft_id = ${draftId} AND pa.dataset_player_id = p.id
          AND pa.status IN ('OPEN', 'AWARDED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM do_not_draft_items ddi
        WHERE ddi.draft_id = ${draftId} AND ddi.team_id = ${teamId} AND ddi.dataset_player_id = p.id
      )
    ORDER BY pas.aav_minor DESC
  `;

  for (const candidate of candidates) {
    const slot = await assignRosterSlot(sql, draftId, teamId, leagueId, candidate.position);
    if (slot) return { playerId: candidate.id };
  }
  return null;
}

/**
 * Auto-nominates on a team's behalf: selects a player per selectAutoNominationPlayer,
 * opens it at min_bid_minor through the normal nomination path (systemNominated:
 * true), then triggers other AUTO_AGENT teams' reactive bidding — same as a
 * manual nomination.
 */
async function processAutoNomination(
  sql: postgres.Sql,
  draftId: string,
  leagueId: string,
  teamId: string,
): Promise<void> {
  const draftRows = await sql<[{ dataset_id: string; status: string }]>`
    SELECT dataset_id, status FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft || draft.status !== 'RUNNING') return;

  const cfgRows = await sql<[{ min_bid_minor: number }]>`
    SELECT min_bid_minor FROM auction_configurations WHERE league_id = ${leagueId} LIMIT 1
  `;
  const minBidMinor = cfgRows[0]?.min_bid_minor ?? 100;

  const candidate = await selectAutoNominationPlayer(sql, draftId, teamId, leagueId, draft.dataset_id);
  if (!candidate) return; // nothing eligible left to auto-nominate

  const result = await processNominateCommand({
    draftId,
    teamId,
    leagueId,
    serverReceiptTime: new Date(),
    sql,
    command: { player_dataset_entry_id: candidate.playerId, opening_bid_minor: minBidMinor },
    systemNominated: true,
  });

  if (result.succeeded && result.auctionId && postNominationHook) {
    await postNominationHook(
      draftId,
      leagueId,
      result.auctionId,
      result.openingBidMinor!,
      result.nominatorTeamId!,
      sql,
    );
  }
}

/**
 * Dispatches the current nomination turn for `teamId`: an AUTO_AGENT team
 * auto-nominates immediately (no timer wait); a MANUAL team gets a
 * nomination-turn deadline that auto-nominates on their behalf if it elapses
 * with no NOMINATE_COMMAND received. Always clears any previously pending
 * nomination timer for the draft first — at most one is ever pending.
 */
async function dispatchNominationTurn(
  sql: postgres.Sql,
  draftId: string,
  leagueId: string,
  teamId: string,
  controlMode: string,
  nominationTimerMs?: number,
): Promise<void> {
  const rt = getOrCreateRuntime(draftId);
  if (rt.nominationTimer) {
    clearTimeout(rt.nominationTimer);
    rt.nominationTimer = null;
  }

  if (controlMode === 'AUTO_AGENT') {
    await processAutoNomination(sql, draftId, leagueId, teamId);
    return;
  }

  let timerMs = nominationTimerMs;
  if (timerMs === undefined) {
    const cfgRows = await sql<[{ nomination_timer_ms: number }]>`
      SELECT nomination_timer_ms FROM auction_configurations WHERE league_id = ${leagueId} LIMIT 1
    `;
    timerMs = cfgRows[0]?.nomination_timer_ms ?? 90000;
  }

  const timer = setTimeout(() => {
    rt.nominationTimer = null;
    rt.queue.enqueue(async () => {
      // Re-check the draft is still RUNNING before firing — it may have been
      // paused between scheduling and expiry.
      const draftRows = await sql<[{ status: string }]>`
        SELECT status FROM drafts WHERE id = ${draftId} LIMIT 1
      `;
      if (draftRows[0]?.status !== 'RUNNING') return;
      await processAutoNomination(sql, draftId, leagueId, teamId);
    });
  }, timerMs);
  timer.unref?.();
  rt.nominationTimer = timer;
}

/** Team + turn-eligibility rows shared by advanceNominationTurn and triggerCurrentNominationTurn. */
interface NominationTurnState {
  team_id: string;
  required_remaining_spots: number;
  control_mode: string;
}

async function loadNominationTurnStates(
  sql: postgres.Sql,
  draftId: string,
): Promise<Map<string, NominationTurnState>> {
  const rows = await sql<NominationTurnState[]>`
    SELECT team_id, required_remaining_spots, control_mode
    FROM draft_team_states WHERE draft_id = ${draftId}
  `;
  return new Map(rows.map((r) => [r.team_id, r]));
}

// ─── Nomination turn advance (shared: PASS_NOMINATION and post-award) ─────────

/**
 * Advances nomination_cursor to the next ELIGIBLE team (draft_order order,
 * wrapping; teams with a completed roster — required_remaining_spots <= 0 —
 * are skipped and never re-selected) and broadcasts NOMINATION_TURN_CHANGED.
 * Called both when an owner explicitly passes their nomination, and after
 * every awarded pick — nomination order is a fixed round-robin independent of
 * who wins each auction, so a normal award must advance the turn exactly like
 * an explicit pass does. Also dispatches the new team's turn (auto-nominate
 * immediately if AUTO_AGENT, else start their nomination-turn deadline).
 */
async function advanceNominationTurn(
  sql: postgres.Sql,
  draftId: string,
  leagueId: string,
): Promise<void> {
  const draftRows = await sql<[{ nomination_cursor: number }]>`
    SELECT nomination_cursor FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) return;

  const teamsRows = await sql<Array<{ id: string; draft_order: number }>>`
    SELECT id, draft_order FROM teams WHERE league_id = ${leagueId}
    ORDER BY draft_order ASC
  `;
  if (teamsRows.length === 0) return;

  const stateMap = await loadNominationTurnStates(sql, draftId);

  let newCursor = draft.nomination_cursor;
  let nextTeam: { id: string; draft_order: number } | undefined;
  for (let i = 1; i <= teamsRows.length; i++) {
    const idx = (draft.nomination_cursor + i) % teamsRows.length;
    const candidate = teamsRows[idx]!;
    const state = stateMap.get(candidate.id);
    if (state && state.required_remaining_spots <= 0) continue; // completed roster — never re-selected
    newCursor = idx;
    nextTeam = candidate;
    break;
  }
  if (!nextTeam) return; // every team has a completed roster — draft should already be COMPLETE

  const cfgRows2 = await sql<[{ nomination_timer_ms: number }]>`
    SELECT nomination_timer_ms FROM auction_configurations WHERE league_id = ${leagueId} LIMIT 1
  `;
  const nominationTimerMs = cfgRows2[0]?.nomination_timer_ms ?? 90000;
  const nominationDeadlineMs = Date.now() + nominationTimerMs;

  // Same reasoning as NOMINATION_STARTED above: one payload object for both
  // the persisted event and the broadcast, so replay can never drift from
  // what a live client saw. This previously persisted `next_team_id` while
  // broadcasting `current_nominator_team_id` — a reconnecting client (which
  // reads the replayed event, not the live one) silently got `undefined`
  // for the current nominator.
  const turnChangedPayload = {
    current_nominator_team_id: nextTeam.id,
    nomination_deadline_ts: nominationDeadlineMs,
  };

  await sql.begin(async (tx) => {
    await tx`UPDATE drafts SET nomination_cursor = ${newCursor} WHERE id = ${draftId}`;
    const seq = await nextDraftEventSequence(tx, draftId);
    await tx`
      INSERT INTO draft_events (draft_id, sequence, event_type, team_id, payload, created_at)
      VALUES (${draftId}, ${seq}, 'NOMINATION_TURN_CHANGED', ${nextTeam.id},
              ${JSON.stringify(turnChangedPayload)}::jsonb, NOW())
    `;
  });

  broadcast(draftId, { type: 'NOMINATION_TURN_CHANGED', payload: turnChangedPayload });

  const nextState = stateMap.get(nextTeam.id);
  await dispatchNominationTurn(
    sql, draftId, leagueId, nextTeam.id, nextState?.control_mode ?? 'MANUAL', nominationTimerMs,
  );
}

/**
 * Dispatches the CURRENT nomination_cursor's turn without advancing it — used
 * once, right after DRAFT_STARTED, to close the gap where a draft with every
 * team on AUTO_AGENT would otherwise never nominate a first player.
 */
export async function triggerCurrentNominationTurn(
  sql: postgres.Sql,
  draftId: string,
  leagueId: string,
): Promise<void> {
  const draftRows = await sql<[{ nomination_cursor: number }]>`
    SELECT nomination_cursor FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) return;

  const teamsRows = await sql<Array<{ id: string }>>`
    SELECT id FROM teams WHERE league_id = ${leagueId} ORDER BY draft_order ASC
  `;
  if (teamsRows.length === 0) return;

  const stateMap = await loadNominationTurnStates(sql, draftId);

  for (let i = 0; i < teamsRows.length; i++) {
    const idx = (draft.nomination_cursor + i) % teamsRows.length;
    const candidate = teamsRows[idx]!;
    const state = stateMap.get(candidate.id);
    if (state && state.required_remaining_spots <= 0) continue;
    await dispatchNominationTurn(sql, draftId, leagueId, candidate.id, state?.control_mode ?? 'MANUAL');
    return;
  }
}

export async function processPassNomination(
  draftId: string,
  teamId: string,
  leagueId: string,
  sql: postgres.Sql,
): Promise<void> {
  const draftRows = await sql<[{ id: string; league_id: string; status: string }]>`
    SELECT id, league_id, status FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft || draft.league_id !== leagueId || draft.status !== 'RUNNING') return;
  // NOTE: pre-existing gap, unrelated to this refactor — teamId isn't checked
  // against the current nominator, so any team can currently pass on another's
  // turn. Preserved as-is; not part of this fix's scope.
  void teamId;
  await advanceNominationTurn(sql, draftId, leagueId);
}

// ─── Award timer ──────────────────────────────────────────────────────────────

interface AwardableAuction {
  id: string;
  draft_id: string;
  league_id: string;
  dataset_id: string;
  current_bid_minor: number;
  current_leader_id: string;
  dataset_player_id: string;
  player_name: string;
  player_position: string;
}

async function findAwardableAuctions(sql: postgres.Sql): Promise<AwardableAuction[]> {
  return sql<AwardableAuction[]>`
    SELECT
      pa.id, pa.draft_id, d.league_id, d.dataset_id,
      pa.current_bid_minor, pa.current_leader_id,
      pa.dataset_player_id, p.name AS player_name, p.position AS player_position
    FROM player_auctions pa
    JOIN drafts d ON d.id = pa.draft_id
    JOIN players p ON p.id = pa.dataset_player_id
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

    // Position matching: exact match, FLEX (accepts RB/WR/TE), SUPERFLEX
    // (accepts any position — a QB-eligible flex slot), or BN/BENCH (accepts all)
    const pos = slot.position.toUpperCase();
    const playerPos = playerPosition.toUpperCase();
    if (
      pos === playerPos ||
      pos === 'BN' ||
      pos === 'BENCH' ||
      pos === 'SUPERFLEX' ||
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

  // Primary AAV for the close card's over/under diff (F-MOD-017) — static
  // reference data, resolved the same way nomination does, ahead of the
  // transaction (same pattern as the slot lookup above).
  const resolvedAav = await resolvePlayerPrimaryAav(sql, auction.dataset_id, auction.dataset_player_id);
  const aavMinor = resolvedAav?.aav_minor ?? 0;

  let resolutionSequence: number;
  let acquisitionId: string;
  let acceptedBidCount: number;
  let uniqueBidderCount: number;
  let remainingBudgetMinor: number;

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
    const [updatedTeamState] = await tx<[{ remaining_budget_minor: number }]>`
      UPDATE draft_team_states
      SET remaining_budget_minor = remaining_budget_minor - ${auction.current_bid_minor},
          roster_filled_count = roster_filled_count + 1,
          required_remaining_spots = GREATEST(0, required_remaining_spots - 1)
      WHERE draft_id = ${draftId} AND team_id = ${auction.current_leader_id}
      RETURNING remaining_budget_minor
    `;
    remainingBudgetMinor = updatedTeamState!.remaining_budget_minor;

    // Accepted-bid / unique-bidder counts for the close card (F-MOD-017) —
    // computed here from bid_attempts, not the client's 10-entry bidLadder,
    // so auctions with more than 10 bids still report true totals.
    const [bidStats] = await tx<[{ accepted_count: number; unique_bidders: number }]>`
      SELECT COUNT(*)::int AS accepted_count, COUNT(DISTINCT team_id)::int AS unique_bidders
      FROM bid_attempts
      WHERE player_auction_id = ${auctionId} AND accepted = true
    `;
    acceptedBidCount = bidStats?.accepted_count ?? 0;
    uniqueBidderCount = bidStats?.unique_bidders ?? 0;

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
           accepted_bid_count: acceptedBidCount,
           unique_bidder_count: uniqueBidderCount,
           aav_minor: aavMinor,
           remaining_budget_minor: remainingBudgetMinor,
         })}::jsonb,
         NOW())
    `;

    // ─── Draft completion check (constraint: same transaction as last award) ──
    // A draft is complete when every team's roster is full — NOT when every
    // player_auctions row created so far happens to be AWARDED (that table only
    // holds nominated players, so with no auction currently open the count of
    // non-AWARDED rows is trivially 0 after literally the first pick).
    const [unfilled] = await tx<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt
      FROM draft_team_states
      WHERE draft_id = ${draftId} AND required_remaining_spots > 0
    `;
    if ((unfilled?.cnt ?? 1) === 0) {
      // All auctions awarded — complete the draft
      await tx`
        UPDATE drafts
        SET status = 'COMPLETE', completed_at = NOW()
        WHERE id = ${draftId}
      `;
      const completeSeq = await nextDraftEventSequence(tx, draftId);
      await tx`
        INSERT INTO draft_events
          (draft_id, sequence, event_type, payload, created_at)
        VALUES
          (${draftId}, ${completeSeq}, 'DRAFT_COMPLETE',
           ${JSON.stringify({ draft_id: draftId })}::jsonb,
           NOW())
      `;
    }
    // Store completion flag for post-commit broadcast (hoisting out of tx scope)
    draftCompletedMap.set(draftId, (unfilled?.cnt ?? 1) === 0);
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
      accepted_bid_count: acceptedBidCount!,
      unique_bidder_count: uniqueBidderCount!,
      aav_minor: aavMinor,
      remaining_budget_minor: remainingBudgetMinor!,
    },
  });

  // Broadcast DRAFT_COMPLETE after commit if draft just completed; otherwise
  // the nomination turn always advances after an award, same as an explicit
  // pass — round-robin nomination order doesn't depend on who won the pick.
  if (draftCompletedMap.get(draftId)) {
    draftCompletedMap.delete(draftId);
    broadcast(draftId, { type: 'DRAFT_COMPLETE', payload: { draft_id: draftId } });
  } else {
    await advanceNominationTurn(sql, draftId, leagueId);
  }
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

// ─── Nominator Match command ──────────────────────────────────────────────────

export interface NominatorMatchResult {
  accepted: boolean;
  eventType: 'NOMINATOR_MATCH_USED' | 'NOMINATOR_MATCH_CONSUMED' | 'REJECTED';
  reason?: string;
  price_minor?: number;
}

/**
 * Process NOMINATOR_MATCH WS command through the per-draft serialized queue.
 *
 * Valid use: timer running, requesting team does not lead, another team leads.
 * - Sets NominatorMatch.used = true in same transaction as BidAttempt.
 * - Records NOMINATOR_MATCH_USED DraftEvent.
 * - Ties the current bid (does not raise it); new_leader = teamId.
 *
 * Invalid use (already used): appends NOMINATOR_MATCH_CONSUMED event.
 * Other rejections: returns REJECTED with a reason, no state change.
 */
export async function processNominatorMatchCommand({
  draftId,
  teamId,
  sql,
}: {
  draftId: string;
  teamId: string;
  sql: postgres.Sql;
}): Promise<NominatorMatchResult> {
  // Find the open player auction for this draft
  const auctionRows = await sql<Array<{
    id: string;
    current_bid_minor: number;
    current_leader_id: string | null;
    rebid_deadline: Date | null;
    nomination_deadline: Date | null;
  }>>`
    SELECT id, current_bid_minor, current_leader_id, rebid_deadline, nomination_deadline
    FROM player_auctions
    WHERE draft_id = ${draftId} AND status = 'OPEN'
    LIMIT 1
  `;

  const auction = auctionRows[0];
  if (!auction) {
    return { accepted: false, eventType: 'REJECTED', reason: 'No active auction' };
  }

  // Timer must be active (rebid_deadline or nomination_deadline in the future)
  const now = new Date();
  const deadline = auction.rebid_deadline ?? auction.nomination_deadline;
  if (!deadline || deadline <= now) {
    return { accepted: false, eventType: 'REJECTED', reason: 'Timer not active' };
  }

  // Requesting team must not already lead
  if (auction.current_leader_id === teamId) {
    return { accepted: false, eventType: 'REJECTED', reason: 'Requesting team already leads' };
  }

  // Another team must currently lead (bid > 0 and a leader is set)
  if (!auction.current_leader_id || auction.current_bid_minor === 0) {
    return { accepted: false, eventType: 'REJECTED', reason: 'No competing bid to match' };
  }

  // Check NominatorMatch state for this team
  const nmRows = await sql<Array<{ id: string; used: boolean }>>`
    SELECT id, used FROM nominator_matches
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;
  const nm = nmRows[0];

  if (nm?.used) {
    // Already consumed — record the rejected attempt and emit NOMINATOR_MATCH_CONSUMED
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO bid_attempts
          (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
           server_receipt_time, accepted, rejection_reason)
        VALUES
          (${draftId}, ${auction.id}, ${teamId}, ${auction.current_bid_minor},
           'NOMINATOR_MATCH', NOW(), false, 'NOMINATOR_MATCH_CONSUMED')
      `;
      const seq = await nextDraftEventSequence(tx, draftId);
      await tx`
        INSERT INTO draft_events
          (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
        VALUES
          (${draftId}, ${seq}, 'NOMINATOR_MATCH_CONSUMED', ${teamId}, ${auction.id},
           ${JSON.stringify({ team_id: teamId, player_auction_id: auction.id })}::jsonb,
           NOW())
      `;
    });
    return { accepted: false, eventType: 'NOMINATOR_MATCH_CONSUMED', reason: 'NOMINATOR_MATCH_CONSUMED' };
  }

  // Valid use — execute the match in one transaction
  await sql.begin(async (tx) => {
    // Record accepted BidAttempt with bid_type = NOMINATOR_MATCH
    await tx`
      INSERT INTO bid_attempts
        (draft_id, player_auction_id, team_id, bid_amount_minor, bid_type,
         server_receipt_time, accepted)
      VALUES
        (${draftId}, ${auction.id}, ${teamId}, ${auction.current_bid_minor},
         'NOMINATOR_MATCH', NOW(), true)
    `;

    // Transfer leadership to requesting team at the same price, bump version
    await tx`
      UPDATE player_auctions
      SET current_leader_id = ${teamId}, auction_version = auction_version + 1
      WHERE id = ${auction.id}
    `;

    // Set NominatorMatch.used = true, used_at = NOW()
    if (nm) {
      await tx`
        UPDATE nominator_matches SET used = true, used_at = NOW() WHERE id = ${nm.id}
      `;
    } else {
      await tx`
        INSERT INTO nominator_matches (draft_id, team_id, used, used_at)
        VALUES (${draftId}, ${teamId}, true, NOW())
      `;
    }

    // Keep draft_team_states.nominator_match_used in sync
    await tx`
      UPDATE draft_team_states
      SET nominator_match_used = true
      WHERE draft_id = ${draftId} AND team_id = ${teamId}
    `;

    // Append NOMINATOR_MATCH_USED DraftEvent
    const seq = await nextDraftEventSequence(tx, draftId);
    await tx`
      INSERT INTO draft_events
        (draft_id, sequence, event_type, team_id, player_auction_id, payload, created_at)
      VALUES
        (${draftId}, ${seq}, 'NOMINATOR_MATCH_USED', ${teamId}, ${auction.id},
         ${JSON.stringify({
           team_id: teamId,
           previous_leader_id: auction.current_leader_id,
           price_minor: auction.current_bid_minor,
           player_auction_id: auction.id,
         })}::jsonb,
         NOW())
    `;
  });

  broadcast(draftId, {
    type: 'NOMINATOR_MATCH_USED',
    payload: {
      player_auction_id: auction.id,
      team_id: teamId,
      previous_leader_id: auction.current_leader_id,
      price_minor: auction.current_bid_minor,
    },
  });

  return { accepted: true, eventType: 'NOMINATOR_MATCH_USED', price_minor: auction.current_bid_minor };
}
