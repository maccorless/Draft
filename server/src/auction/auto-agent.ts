/**
 * Auto-Agent — control-mode FSM, grace-timer expiry handler, bidding cadence.
 *
 * Critical invariants:
 * 1. control_mode is SEPARATE from connection state — reconnect does NOT restore MANUAL.
 * 2. All control-mode transitions persist a DraftEvent in the same transaction.
 * 3. Auto-agent bids route through the per-draft AsyncQueue (same atomicity as manual bids).
 * 4. Willingness ceiling uses live remaining_budget_minor, never a stale snapshot.
 * 5. Multi-draft isolation: every command checks draft.league_id == token.league_id.
 */
import postgres from 'postgres';
import { broadcast, getOrCreateRuntime, computeMaxLegalBid, processBidCommand } from './engine.js';

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

/**
 * Upsert willingness_pct for a team's auto-agent config.
 * Returns the stored value.
 */
export async function upsertAutoAgentConfig(
  draftId: string,
  teamId: string,
  willingness_pct: number,
  sql: postgres.Sql,
): Promise<{ team_id: string; willingness_pct: number }> {
  const existing = await sql<[{ id: string }]>`
    SELECT id FROM auto_agent_configs
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE auto_agent_configs
      SET willingness_pct = ${willingness_pct}
      WHERE id = ${existing[0]!.id}
    `;
  } else {
    await sql`
      INSERT INTO auto_agent_configs (draft_id, team_id, willingness_pct)
      VALUES (${draftId}, ${teamId}, ${willingness_pct})
    `;
  }

  return { team_id: teamId, willingness_pct };
}

/** Fetch willingness_pct for a team, defaulting to 0.8 (80%). */
async function getWillingnessPct(
  draftId: string,
  teamId: string,
  sql: postgres.Sql,
): Promise<number> {
  const rows = await sql<[{ willingness_pct: string }]>`
    SELECT willingness_pct FROM auto_agent_configs
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;
  return rows[0] ? parseFloat(rows[0].willingness_pct) : 0.8;
}

// ─── Bidding cadence ──────────────────────────────────────────────────────────

interface AutoAgentTeamState {
  team_id: string;
  remaining_budget_minor: number;
  required_remaining_spots: number;
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
  const teams = await sql<AutoAgentTeamState[]>`
    SELECT dts.team_id, dts.remaining_budget_minor, dts.required_remaining_spots
    FROM draft_team_states dts
    JOIN player_auctions pa ON pa.id = ${playerAuctionId}
    WHERE dts.draft_id = ${draftId}
      AND dts.control_mode = 'AUTO_AGENT'
      AND dts.team_id != ${nominatorTeamId}
      AND NOT EXISTS (
        SELECT 1 FROM do_not_draft_items ddi
        WHERE ddi.draft_id = dts.draft_id
          AND ddi.team_id = dts.team_id
          AND ddi.dataset_player_id = pa.dataset_player_id
      )
  `;

  for (const team of teams) {
    const willingnessPct = await getWillingnessPct(draftId, team.team_id, sql);
    const willingnessCeiling = Math.floor(team.remaining_budget_minor * willingnessPct);
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
  const teams = await sql<AutoAgentTeamState[]>`
    SELECT dts.team_id, dts.remaining_budget_minor, dts.required_remaining_spots
    FROM draft_team_states dts
    JOIN player_auctions pa ON pa.id = ${playerAuctionId}
    WHERE dts.draft_id = ${draftId}
      AND dts.control_mode = 'AUTO_AGENT'
      AND dts.team_id != ${newLeaderTeamId}
      AND NOT EXISTS (
        SELECT 1 FROM do_not_draft_items ddi
        WHERE ddi.draft_id = dts.draft_id
          AND ddi.team_id = dts.team_id
          AND ddi.dataset_player_id = pa.dataset_player_id
      )
  `;

  for (const team of teams) {
    const willingnessPct = await getWillingnessPct(draftId, team.team_id, sql);
    const willingnessCeiling = Math.floor(team.remaining_budget_minor * willingnessPct);
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
