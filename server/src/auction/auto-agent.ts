/**
 * Auto-Agent — control-mode FSM, grace-timer expiry handler, bidding cadence.
 *
 * Critical invariants:
 * 1. control_mode is SEPARATE from connection state — reconnect does NOT restore MANUAL.
 * 2. All control-mode transitions persist a DraftEvent in the same transaction.
 * 3. Auto-agent bids route through the per-draft AsyncQueue (same atomicity as manual bids).
 * 4. Willingness ceiling uses live remaining_budget_minor, never a stale snapshot.
 * 5. Multi-draft isolation: every command checks draft.league_id == token.league_id.
 *
 * Willingness ceiling (F-MOD-004-rework-02, UF-17-05; state-machine-flows.md §11,
 * data-model.md §10.5): computed PER PLAYER, not as a flat percentage of the team's
 * total remaining budget. See computeAutoAgentWillingnessCeiling for the 5-step
 * algorithm: base value (Owner Target or Primary AAV) -> stable variance -> max-
 * over-base ceiling -> starter/bench discount -> clamp to max_legal_bid.
 */
import postgres from 'postgres';
import { broadcast, getOrCreateRuntime, computeMaxLegalBid, processBidCommand } from './engine.js';
import { resolvePlayerPrimaryAav } from '../player/aav-resolution.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Control-mode transitions ─────────────────────────────────────────────────

/**
 * Transition a team's control_mode.
 * Atomically upserts draft_team_states (creating a pre-start row, seeded from the
 * draft's auction/roster configuration, if none exists yet — a bare UPDATE would
 * silently match zero rows and no-op for a draft that hasn't started), appends a
 * DraftEvent, then broadcasts. Never returns success without persisting a change.
 */
export async function setControlMode(
  draftId: string,
  teamId: string,
  mode: 'MANUAL' | 'AUTO_AGENT',
  triggeredBy: string,
  sql: postgres.Sql,
): Promise<void> {
  const eventType = mode === 'AUTO_AGENT' ? 'TEAM_AUTO_AGENT_ENABLED' : 'TEAM_AUTO_AGENT_DISABLED';

  await sql.begin(async (tx) => {
    const updated = await tx<Array<{ id: string }>>`
      UPDATE draft_team_states
      SET control_mode = ${mode}
      WHERE draft_id = ${draftId} AND team_id = ${teamId}
      RETURNING id
    `;

    if (updated.length === 0) {
      // No DraftTeamState row yet — the draft hasn't started (POST /start normally
      // creates one per team). Upsert one now, seeded the same way /start does, so
      // the control-mode choice isn't lost and /start won't reset it later.
      const [draftRow] = await tx<[{ league_id: string } | undefined]>`
        SELECT league_id FROM drafts WHERE id = ${draftId} LIMIT 1
      `;
      if (!draftRow) throw new Error(`setControlMode: draft ${draftId} not found`);

      const [cfg] = await tx<[{ initial_budget_minor: number } | undefined]>`
        SELECT initial_budget_minor FROM auction_configurations
        WHERE league_id = ${draftRow.league_id} LIMIT 1
      `;
      const [rosterCfg] = await tx<[{ total_roster_size: number } | undefined]>`
        SELECT total_roster_size FROM roster_configurations
        WHERE league_id = ${draftRow.league_id} LIMIT 1
      `;
      const initialBudgetMinor = cfg?.initial_budget_minor ?? 0;
      const totalRosterSize = rosterCfg?.total_roster_size ?? 0;

      // No unique constraint on (draft_id, team_id) — mirror the same select-then-insert
      // pattern POST /start already uses, inside this transaction for atomicity.
      await tx`
        INSERT INTO draft_team_states
          (draft_id, team_id, remaining_budget_minor, roster_filled_count,
           required_remaining_spots, control_mode)
        VALUES
          (${draftId}, ${teamId}, ${initialBudgetMinor}, 0, ${totalRosterSize}, ${mode})
      `;
    }

    const seq = await nextDraftEventSequence(tx, draftId);
    await tx`
      INSERT INTO draft_events
        (draft_id, sequence, event_type, team_id, payload, created_at)
      VALUES
        (${draftId}, ${seq}, ${eventType}, ${teamId},
         ${JSON.stringify({ triggered_by: triggeredBy })}::jsonb, NOW())
    `;
  });

  broadcast(draftId, {
    type: eventType,
    payload: { team_id: teamId, triggered_by: triggeredBy },
  });
}

/**
 * Called when the grace timer fires (team fully disconnected for grace_period_ms).
 * Transitions the team to AUTO_AGENT only if they haven't reconnected in the meantime.
 * Runs in the draft's queue for atomicity.
 */
export async function handleGraceExpiry(
  draftId: string,
  teamId: string,
  sql: postgres.Sql,
): Promise<void> {
  // If the team has reconnected since the timer was set, abort
  const rt = getOrCreateRuntime(draftId);
  if (rt.teamSessions.has(teamId)) return;

  await setControlMode(draftId, teamId, 'AUTO_AGENT', 'disconnect_grace', sql);
}

// ─── Auto-agent config ────────────────────────────────────────────────────────

export interface AutoAgentConfigFields {
  use_owner_target_when_customized: boolean;
  fallback_to_primary_aav: boolean;
  max_over_base_pct: number;
  random_variance_pct: number;
  bench_value_pct: number;
  prioritize_starters: boolean;
}

/**
 * Sane out-of-box defaults (data-model.md §10.5) for a team that has never had
 * its AutoAgentConfiguration explicitly set — AAV-anchored, not a flat
 * percentage of total budget.
 */
export const DEFAULT_AUTO_AGENT_CONFIG: AutoAgentConfigFields = {
  use_owner_target_when_customized: true,
  fallback_to_primary_aav: true,
  max_over_base_pct: 0.25,
  random_variance_pct: 0.25,
  bench_value_pct: 0.5,
  prioritize_starters: true,
};

/** Fetch a team's AutoAgentConfiguration fields, defaulting when no row exists. */
export async function getAutoAgentConfig(
  draftId: string,
  teamId: string,
  sql: postgres.Sql,
): Promise<AutoAgentConfigFields> {
  const rows = await sql<Array<{
    use_owner_target_when_customized: boolean;
    fallback_to_primary_aav: boolean;
    max_over_base_pct: string;
    random_variance_pct: string;
    bench_value_pct: string;
    prioritize_starters: boolean;
  }>>`
    SELECT use_owner_target_when_customized, fallback_to_primary_aav,
           max_over_base_pct, random_variance_pct, bench_value_pct, prioritize_starters
    FROM auto_agent_configs
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ...DEFAULT_AUTO_AGENT_CONFIG };
  return {
    use_owner_target_when_customized: row.use_owner_target_when_customized,
    fallback_to_primary_aav: row.fallback_to_primary_aav,
    max_over_base_pct: parseFloat(row.max_over_base_pct),
    random_variance_pct: parseFloat(row.random_variance_pct),
    bench_value_pct: parseFloat(row.bench_value_pct),
    prioritize_starters: row.prioritize_starters,
  };
}

/**
 * Upsert a team's AutoAgentConfiguration. Accepts a partial update (only the
 * fields the owner sent) — merges onto the team's current stored values (or
 * the documented defaults, for a first-time row), so `PUT` never resets fields
 * the caller didn't mention.
 */
export async function upsertAutoAgentConfig(
  draftId: string,
  teamId: string,
  fields: Partial<AutoAgentConfigFields>,
  sql: postgres.Sql,
): Promise<{ team_id: string } & AutoAgentConfigFields> {
  const existing = await sql<[{ id: string } | undefined]>`
    SELECT id FROM auto_agent_configs
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;

  const current = existing[0]
    ? await getAutoAgentConfig(draftId, teamId, sql)
    : DEFAULT_AUTO_AGENT_CONFIG;
  const merged: AutoAgentConfigFields = { ...current, ...fields };

  if (existing[0]) {
    await sql`
      UPDATE auto_agent_configs
      SET use_owner_target_when_customized = ${merged.use_owner_target_when_customized},
          fallback_to_primary_aav = ${merged.fallback_to_primary_aav},
          max_over_base_pct = ${merged.max_over_base_pct},
          random_variance_pct = ${merged.random_variance_pct},
          bench_value_pct = ${merged.bench_value_pct},
          prioritize_starters = ${merged.prioritize_starters}
      WHERE id = ${existing[0].id}
    `;
  } else {
    await sql`
      INSERT INTO auto_agent_configs
        (draft_id, team_id, use_owner_target_when_customized, fallback_to_primary_aav,
         max_over_base_pct, random_variance_pct, bench_value_pct, prioritize_starters)
      VALUES
        (${draftId}, ${teamId}, ${merged.use_owner_target_when_customized},
         ${merged.fallback_to_primary_aav}, ${merged.max_over_base_pct},
         ${merged.random_variance_pct}, ${merged.bench_value_pct}, ${merged.prioritize_starters})
    `;
  }

  return { team_id: teamId, ...merged };
}

// ─── Per-player willingness ceiling ────────────────────────────────────────────

/**
 * Deterministic pseudo-random value in [0, 1) derived from a seed string.
 * FNV-1a hash — stable across calls (no Math.random), so the variance applied
 * to a given team+player combination doesn't change between triggers within
 * the same draft (state-machine-flows.md §11 step 2).
 */
function stableUnitRandom(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

/** Stable variance in [-pct, +pct] for a given (draft, team, player) triple. */
function stableVariance(draftId: string, teamId: string, playerDatasetId: string, pct: number): number {
  const u = stableUnitRandom(`${draftId}:${teamId}:${playerDatasetId}`);
  return (u * 2 - 1) * pct;
}

/**
 * Whether `playerDatasetId` (a players.id) would fill one of the team's
 * currently-unfilled starter slots, mirroring the starter-fill-state /
 * position-matching logic in server/src/draft/war-room.ts and the
 * assignRosterSlot starter-first assignment in engine.ts.
 */
async function wouldFillStarterSlot(
  draftId: string,
  teamId: string,
  leagueId: string,
  playerDatasetId: string,
  sql: postgres.Sql,
): Promise<boolean> {
  const [player] = await sql<[{ position: string } | undefined]>`
    SELECT position FROM players WHERE id = ${playerDatasetId} LIMIT 1
  `;
  if (!player) return false;

  const starterSlots = await sql<Array<{ id: string; position: string; slot_count: number }>>`
    SELECT rsd.id, rsd.position, rsd.slot_count
    FROM roster_slot_definitions rsd
    JOIN roster_configurations rc ON rc.id = rsd.config_id
    WHERE rc.league_id = ${leagueId} AND rsd.is_starter = true
    ORDER BY rsd.priority ASC
  `;
  if (starterSlots.length === 0) return false;

  const filledRows = await sql<Array<{ roster_slot_id: string; n: number }>>`
    SELECT roster_slot_id, COUNT(*)::int AS n
    FROM roster_entries
    WHERE draft_id = ${draftId} AND team_id = ${teamId} AND active = true
    GROUP BY roster_slot_id
  `;
  const filledMap = new Map<string, number>(filledRows.map((r) => [r.roster_slot_id, r.n]));

  const playerPos = player.position.toUpperCase();
  for (const slot of starterSlots) {
    const filled = filledMap.get(slot.id) ?? 0;
    if (filled >= slot.slot_count) continue; // slot already full

    const pos = slot.position.toUpperCase();
    if (
      pos === playerPos ||
      pos === 'SUPERFLEX' ||
      (pos === 'FLEX' && ['RB', 'WR', 'TE', 'RB/WR/TE'].includes(playerPos))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the base value for a player per state-machine-flows.md §11 step 1:
 * the team's customized Owner Target if one exists and configured to be used,
 * else the dataset's Primary AAV. Returns null if neither source is available
 * (the agent does not bid on this player).
 */
async function resolveBaseValueMinor(
  draftId: string,
  teamId: string,
  playerDatasetId: string,
  cfg: AutoAgentConfigFields,
  sql: postgres.Sql,
): Promise<number | null> {
  if (cfg.use_owner_target_when_customized) {
    const [target] = await sql<[{ target_value_minor: number } | undefined]>`
      SELECT target_value_minor FROM owner_target_values
      WHERE draft_id = ${draftId} AND team_id = ${teamId} AND dataset_player_id = ${playerDatasetId}
      LIMIT 1
    `;
    if (target) return target.target_value_minor;
  }

  if (cfg.fallback_to_primary_aav) {
    const [draftRow] = await sql<[{ dataset_id: string } | undefined]>`
      SELECT dataset_id FROM drafts WHERE id = ${draftId} LIMIT 1
    `;
    if (!draftRow) return null;

    // Reuse the same "effective primary source" resolution the rest of the app
    // uses (F-MOD-016): the commissioner's explicit Primary AAV selection, or
    // — until one is made — the sole source loaded so far.
    const resolved = await resolvePlayerPrimaryAav(sql, draftRow.dataset_id, playerDatasetId);
    if (resolved) return resolved.aav_minor;
  }

  return null;
}

/**
 * Compute a team's willingness ceiling for a specific player — the 5-step
 * algorithm from state-machine-flows.md §11 / this module's spec:
 *   1. Base value (Owner Target if customized, else Primary AAV)
 *   2. Stable variance within ± random_variance_pct
 *   3. Cap at base * (1 + max_over_base_pct)
 *   4. Starter willingness as-is, else discount by bench_value_pct
 *   5. Clamp to max_legal_bid (live remaining_budget_minor, never stale)
 * Returns null if no base value is available — the agent does not bid.
 */
export async function computeAutoAgentWillingnessCeiling(
  draftId: string,
  teamId: string,
  leagueId: string,
  playerDatasetId: string,
  remainingBudgetMinor: number,
  requiredRemainingSpots: number,
  sql: postgres.Sql,
): Promise<number | null> {
  const cfg = await getAutoAgentConfig(draftId, teamId, sql);

  const baseValueMinor = await resolveBaseValueMinor(draftId, teamId, playerDatasetId, cfg, sql);
  if (baseValueMinor === null) return null;

  const variance = stableVariance(draftId, teamId, playerDatasetId, cfg.random_variance_pct);
  let value = baseValueMinor * (1 + variance);

  const maxOverBase = baseValueMinor * (1 + cfg.max_over_base_pct);
  value = Math.min(value, maxOverBase);

  const fillsStarter = await wouldFillStarterSlot(draftId, teamId, leagueId, playerDatasetId, sql);
  if (!(fillsStarter && cfg.prioritize_starters)) {
    value = value * cfg.bench_value_pct;
  }

  const maxLegalBid = computeMaxLegalBid(remainingBudgetMinor, requiredRemainingSpots);
  value = Math.min(value, maxLegalBid);

  return Math.floor(Math.max(0, value));
}

// ─── Bidding cadence ──────────────────────────────────────────────────────────

interface AutoAgentTeamState {
  team_id: string;
  remaining_budget_minor: number;
  required_remaining_spots: number;
}

interface PlayerAuctionIdentity {
  dataset_player_id: string;
}

async function loadPlayerAuctionIdentity(
  playerAuctionId: string,
  sql: postgres.Sql,
): Promise<PlayerAuctionIdentity | undefined> {
  const [row] = await sql<[PlayerAuctionIdentity | undefined]>`
    SELECT dataset_player_id FROM player_auctions WHERE id = ${playerAuctionId} LIMIT 1
  `;
  return row;
}

/**
 * Enqueue an auto-agent bid for a single team.
 * If accepted, triggers further auto-agent responses (for teams that lost the lead).
 * ponytail: the queue handles serialization; no external lock needed.
 */
function enqueueAutoAgentBid(
  draftId: string,
  leagueId: string,
  teamId: string,
  playerAuctionId: string,
  bidAmount: number,
  sql: postgres.Sql,
): void {
  const rt = getOrCreateRuntime(draftId);
  rt.queue.enqueue(async () => {
    const result = await processBidCommand({
      draftId,
      teamId,
      leagueId,
      serverReceiptTime: new Date(),
      sql,
      command: {
        player_auction_id: playerAuctionId,
        bid_amount_minor: bidAmount,
        bid_type: 'ABSOLUTE',
      },
    });

    // If accepted, trigger other AUTO_AGENT teams that just lost the lead
    if (result.accepted && result.leadingTeamId === teamId) {
      await triggerAutoAgentBidsOnLeaderChange(
        draftId,
        leagueId,
        playerAuctionId,
        bidAmount,
        teamId,
        sql,
      );
    }
  });
}

/**
 * Trigger auto-agent bids for all AUTO_AGENT teams when a new auction opens.
 * Skips the nominator (already the leader).
 * Called inside the queue item that processed the nomination, so subsequent
 * auto-agent bids are appended to the queue and run after.
 */
export async function triggerAutoAgentBidsOnNomination(
  draftId: string,
  leagueId: string,
  playerAuctionId: string,
  currentBidMinor: number,
  nominatorTeamId: string,
  sql: postgres.Sql,
): Promise<void> {
  const identity = await loadPlayerAuctionIdentity(playerAuctionId, sql);
  if (!identity) return;

  const teams = await sql<AutoAgentTeamState[]>`
    SELECT dts.team_id, dts.remaining_budget_minor, dts.required_remaining_spots
    FROM draft_team_states dts
    JOIN player_auctions pa ON pa.id = ${playerAuctionId}
    WHERE dts.draft_id = ${draftId}
      AND dts.control_mode = 'AUTO_AGENT'
      AND dts.team_id != ${nominatorTeamId}
      AND dts.required_remaining_spots > 0
      AND NOT EXISTS (
        SELECT 1 FROM do_not_draft_items ddi
        WHERE ddi.draft_id = dts.draft_id
          AND ddi.team_id = dts.team_id
          AND ddi.dataset_player_id = pa.dataset_player_id
      )
  `;

  for (const team of teams) {
    const willingnessCeiling = await computeAutoAgentWillingnessCeiling(
      draftId,
      team.team_id,
      leagueId,
      identity.dataset_player_id,
      team.remaining_budget_minor,
      team.required_remaining_spots,
      sql,
    );
    if (willingnessCeiling === null) continue; // no base value — agent does not bid

    const maxLegalBid = computeMaxLegalBid(
      team.remaining_budget_minor,
      team.required_remaining_spots,
    );
    const bidAmount = Math.min(currentBidMinor + 100, maxLegalBid);

    // Skip if bid would exceed willingness ceiling or max_legal_bid is too low
    if (bidAmount > willingnessCeiling || maxLegalBid <= currentBidMinor) continue;

    enqueueAutoAgentBid(draftId, leagueId, team.team_id, playerAuctionId, bidAmount, sql);
  }
}

/**
 * Trigger auto-agent bids for all AUTO_AGENT teams when leadership changes.
 * Skips the new leader.
 * Called inside the queue item that processed the triggering bid.
 */
export async function triggerAutoAgentBidsOnLeaderChange(
  draftId: string,
  leagueId: string,
  playerAuctionId: string,
  currentBidMinor: number,
  newLeaderTeamId: string,
  sql: postgres.Sql,
): Promise<void> {
  const identity = await loadPlayerAuctionIdentity(playerAuctionId, sql);
  if (!identity) return;

  const teams = await sql<AutoAgentTeamState[]>`
    SELECT dts.team_id, dts.remaining_budget_minor, dts.required_remaining_spots
    FROM draft_team_states dts
    JOIN player_auctions pa ON pa.id = ${playerAuctionId}
    WHERE dts.draft_id = ${draftId}
      AND dts.control_mode = 'AUTO_AGENT'
      AND dts.team_id != ${newLeaderTeamId}
      AND dts.required_remaining_spots > 0
      AND NOT EXISTS (
        SELECT 1 FROM do_not_draft_items ddi
        WHERE ddi.draft_id = dts.draft_id
          AND ddi.team_id = dts.team_id
          AND ddi.dataset_player_id = pa.dataset_player_id
      )
  `;

  for (const team of teams) {
    const willingnessCeiling = await computeAutoAgentWillingnessCeiling(
      draftId,
      team.team_id,
      leagueId,
      identity.dataset_player_id,
      team.remaining_budget_minor,
      team.required_remaining_spots,
      sql,
    );
    if (willingnessCeiling === null) continue; // no base value — agent does not bid

    const maxLegalBid = computeMaxLegalBid(
      team.remaining_budget_minor,
      team.required_remaining_spots,
    );
    const bidAmount = Math.min(currentBidMinor + 100, maxLegalBid);

    // Skip if bid would exceed willingness ceiling or max_legal_bid is too low
    if (bidAmount > willingnessCeiling || maxLegalBid <= currentBidMinor) continue;

    enqueueAutoAgentBid(draftId, leagueId, team.team_id, playerAuctionId, bidAmount, sql);
  }
}
