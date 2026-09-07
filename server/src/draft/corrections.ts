/**
 * Commissioner corrections (F-MOD-005):
 *   POST /drafts/:draftId/corrections/price  — in-place price correction (gated by ledger replay)
 *   POST /drafts/:draftId/rollback           — undo last N picks in reverse resolution_sequence order
 *
 * Behavioral constraints (CLAUDE.md #10):
 * - Only price is corrected in place; winner/player changes require rollback.
 * - Rollback requires draft to be PAUSED and is bounded to last N picks.
 * - Append-only: no rows deleted; compensating rows supersede old ones.
 * - All corrections are commissioner-only with auth_epoch re-check.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';
import { broadcast } from '../auction/engine.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenClaims {
  league_id: string;
  role: string;
  auth_epoch: number;
}

interface DraftRow {
  id: string;
  league_id: string;
  status: string;
}

type DraftParams = { draftId: string };

// ─── Auth helper (mirrors auction/routes.ts pattern) ──────────────────────────

async function requireCommissioner(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
): Promise<{ draft: DraftRow; claims: TokenClaims } | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  if (claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }

  // Re-read auth_epoch from DB (constraint #12 — only revocation mechanism)
  const leagueRows = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
  `;
  const league = leagueRows[0];
  if (!league) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
    return null;
  }
  if (claims.auth_epoch !== league.auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  // Load draft and verify league_id matches token (constraint #11)
  const draftRows = await sql<[DraftRow]>`
    SELECT id, league_id, status FROM drafts WHERE id = ${req.params.draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'Draft not found' });
    return null;
  }
  if (draft.league_id !== claims.league_id) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Draft belongs to a different league' });
    return null;
  }

  return { draft, claims };
}

// ─── Draft event sequence helper ──────────────────────────────────────────────

async function nextEventSeq(tx: postgres.TransactionSql, draftId: string): Promise<number> {
  const [row] = await tx<[{ max: number | null }]>`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS max FROM draft_events WHERE draft_id = ${draftId}
  `;
  return row?.max ?? 0;
}

// Draft.state_version tracks the same monotonic counter as DraftEvent.sequence
// (data-model.md §17.5, §21) — no separate column, derived from the event log's
// highest committed sequence for this draft.
async function getStateVersion(sql: postgres.Sql, draftId: string): Promise<number> {
  const [row] = await sql<[{ max: number | null }]>`
    SELECT COALESCE(MAX(sequence), 0) AS max FROM draft_events WHERE draft_id = ${draftId}
  `;
  return row?.max ?? 0;
}

// ─── Ledger replay for price correction ───────────────────────────────────────
//
// Simulates the team's budget from initial value through all their active picks,
// substituting new_price_minor for the corrected acquisition. Returns false if any
// pick (at its resolution_sequence order) would exceed max_legal_bid at that step.
//
// max_legal_bid = remaining_budget - (spots_remaining - 1) * 100
// (spec constraint #5: money is exact integer units)

async function replayLedger(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
  leagueId: string,
  correctedAcquisitionId: string,
  newPriceMinor: number,
): Promise<{ valid: boolean }> {
  // Get initial budget from auction config
  const cfgRows = await sql<[{ initial_budget_minor: number }]>`
    SELECT initial_budget_minor FROM auction_configurations WHERE league_id = ${leagueId} LIMIT 1
  `;
  if (!cfgRows[0]) return { valid: false };
  const initialBudget = cfgRows[0].initial_budget_minor;

  // Get total roster size (all slot_count values summed) for reserve calculation
  const rosterRows = await sql<[{ total: number }]>`
    SELECT COALESCE(SUM(rsd.slot_count), 0)::int AS total
    FROM roster_slot_definitions rsd
    JOIN roster_configurations rc ON rc.id = rsd.config_id
    WHERE rc.league_id = ${leagueId}
  `;
  const totalRosterSize = rosterRows[0]?.total ?? 0;

  // All active picks for this team, oldest first
  const picks = await sql<Array<{ id: string; price_minor: number }>>`
    SELECT id, price_minor
    FROM acquisitions
    WHERE draft_id = ${draftId} AND team_id = ${teamId} AND active = true
    ORDER BY resolution_sequence ASC
  `;

  let budget = initialBudget;
  let completed = 0;

  for (const pick of picks) {
    const price = pick.id === correctedAcquisitionId ? newPriceMinor : pick.price_minor;
    const spotsRemaining = totalRosterSize - completed;
    // max_legal_bid = budget - reserve for other remaining required spots
    const maxLegal = budget - Math.max(0, spotsRemaining - 1) * 100;
    if (price > maxLegal) return { valid: false };
    budget -= price;
    completed++;
  }

  return { valid: true };
}

// ─── Request body schemas ──────────────────────────────────────────────────────

const PriceCorrectionBody = z.object({
  acquisition_id: z.string().uuid(),
  new_price_minor: z.number().int().min(100),
});

const RollbackBody = z.object({
  count: z.number().int().min(1),
});

const RollbackPreviewQuery = z.object({
  count: z.coerce.number().int().min(1),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerCorrectionRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * POST /drafts/:draftId/corrections/price
   *
   * In-place price correction — only price changes. Ledger replay gates the request.
   * Winner, player, and roster slot are unchanged; those require rollback (constraint #10).
   *
   * Transaction order (atomic):
   * 1. Supersede existing AWARD BudgetLedgerEntry (active=false)
   * 2. Insert CORRECTION BudgetLedgerEntry (amount=-new_price_minor)
   * 3. Update Acquisition.price_minor
   * 4. Update DraftTeamState.remaining_budget_minor by delta=(old-new)
   * 5. Append PRICE_CORRECTED DraftEvent
   *
   * Broadcast PRICE_CORRECTED after commit.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/corrections/price',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft, claims } = ctx;

      const bodyParse = PriceCorrectionBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { acquisition_id, new_price_minor } = bodyParse.data;

      // Load acquisition — must be active and belong to this draft
      const acqRows = await sql<[{
        id: string;
        team_id: string;
        price_minor: number;
      }]>`
        SELECT id, team_id, price_minor
        FROM acquisitions
        WHERE id = ${acquisition_id} AND draft_id = ${draft.id} AND active = true
        LIMIT 1
      `;
      const acq = acqRows[0];
      if (!acq) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Acquisition not found or inactive' });
      }

      const oldPrice = acq.price_minor;

      // Ledger replay: no later pick by this team becomes illegal
      const replay = await replayLedger(
        sql, draft.id, acq.team_id, claims.league_id, acquisition_id, new_price_minor,
      );
      if (!replay.valid) {
        return reply.status(409).send({
          code: 'CORRECTION_ILLEGAL',
          message: 'Corrected price would make a later pick by this team illegal',
        });
      }

      // Atomic transaction: supersede old entry, insert correction, update state, append event
      let newRemainingBudget = 0;
      try {
        await sql.begin(async (tx) => {
          // 1. Supersede existing active BudgetLedgerEntry for this acquisition
          await tx`
            UPDATE budget_ledger_entries
            SET active = false
            WHERE acquisition_id = ${acquisition_id} AND draft_id = ${draft.id} AND active = true
          `;

          // 2. Append CORRECTION entry (amount = -new_price_minor, like AWARD convention)
          await tx`
            INSERT INTO budget_ledger_entries
              (draft_id, team_id, acquisition_id, amount_minor, entry_type, active)
            VALUES
              (${draft.id}, ${acq.team_id}, ${acquisition_id}, ${-new_price_minor}, 'CORRECTION', true)
          `;

          // 3. Update acquisition price in place (the only in-place mutation allowed)
          await tx`
            UPDATE acquisitions SET price_minor = ${new_price_minor} WHERE id = ${acquisition_id}
          `;

          // 4. Adjust DraftTeamState: delta = old - new (positive = refund, negative = extra cost)
          const delta = oldPrice - new_price_minor;
          const stateRows = await tx<[{ remaining_budget_minor: number }]>`
            UPDATE draft_team_states
            SET remaining_budget_minor = remaining_budget_minor + ${delta}
            WHERE draft_id = ${draft.id} AND team_id = ${acq.team_id}
            RETURNING remaining_budget_minor
          `;
          newRemainingBudget = stateRows[0]?.remaining_budget_minor ?? 0;

          // 5. Append PRICE_CORRECTED DraftEvent
          const seq = await nextEventSeq(tx, draft.id);
          await tx`
            INSERT INTO draft_events
              (draft_id, sequence, event_type, team_id, payload, created_at)
            VALUES
              (${draft.id}, ${seq}, 'PRICE_CORRECTED', ${acq.team_id},
               ${JSON.stringify({
                 acquisition_id,
                 old_price_minor: oldPrice,
                 new_price_minor,
                 team_id: acq.team_id,
                 new_remaining_budget_minor: newRemainingBudget,
               })}::jsonb,
               NOW())
          `;
        });
      } catch (err) {
        server.log.error(err, '[corrections] price correction transaction failed');
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Transaction failed' });
      }

      // Broadcast after commit (constraint #4: no broadcast before commit)
      broadcast(draft.id, {
        type: 'PRICE_CORRECTED',
        payload: {
          acquisition_id,
          old_price_minor: oldPrice,
          new_price_minor,
          team_id: acq.team_id,
          new_remaining_budget_minor: newRemainingBudget,
        },
      });

      return reply.send({
        acquisition_id,
        old_price_minor: oldPrice,
        new_price_minor,
        team_id: acq.team_id,
        new_remaining_budget_minor: newRemainingBudget,
      });
    },
  );

  /**
   * POST /drafts/:draftId/rollback
   *
   * Roll back the last N picks in strict reverse resolution_sequence order.
   * Draft MUST be PAUSED (constraint #10 — commissioner initiates pause first).
   *
   * For each pick reversed (highest resolution_sequence first):
   * 1. Acquisition.active = false
   * 2. RosterEntry rows for this acquisition: active = false
   * 3. Insert ROLLBACK BudgetLedgerEntry (+price_minor, positive = refund)
   * 4. Reset PlayerAuction to PENDING, clear resolution_sequence
   * 5. Update DraftTeamState: +price_minor to remaining_budget, -1 roster_filled_count
   *
   * After all picks reversed: append ROLLBACK_APPLIED DraftEvent.
   * Broadcast ROLLBACK_APPLIED after commit.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/rollback',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      // Draft must be PAUSED
      if (draft.status !== 'PAUSED') {
        return reply.status(409).send({
          code: 'DRAFT_NOT_PAUSED',
          message: 'Draft must be PAUSED before rollback',
        });
      }

      const bodyParse = RollbackBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { count } = bodyParse.data;

      // Load N most recently resolved active acquisitions (highest resolution_sequence first)
      const picks = await sql<Array<{
        id: string;
        team_id: string;
        price_minor: number;
        resolution_sequence: number;
        player_auction_id: string;
        player_name: string;
      }>>`
        SELECT
          a.id, a.team_id, a.price_minor, a.resolution_sequence, a.player_auction_id,
          p.name AS player_name
        FROM acquisitions a
        JOIN player_auctions pa ON pa.id = a.player_auction_id
        JOIN players p ON p.id = pa.dataset_player_id
        WHERE a.draft_id = ${draft.id} AND a.active = true
        ORDER BY a.resolution_sequence DESC
        LIMIT ${count}
      `;

      if (picks.length === 0) {
        return reply.status(409).send({
          code: 'NO_PICKS_TO_ROLLBACK',
          message: 'No active picks to roll back',
        });
      }

      // All-or-nothing transaction (constraint #4: atomicity)
      try {
        await sql.begin(async (tx) => {
          // Reverse any APPLIED Whammy tied to a pick sequence being undone —
          // constraint #10 and F-MOD-012-rework-01's spec both require a
          // rollback to unwind Whammy financial effects, not just the awards
          // themselves. Same WHAMMY_APPLIED-event join the preview endpoint
          // below already uses to find these interactions (EXTRACTED-014: no
          // Whammy-specific rollback logic beyond finding what to reverse —
          // the reversal itself is the same generic ledger-entry/status-flip
          // pattern as everything else here).
          const minResolutionSeq = Math.min(...picks.map((p) => p.resolution_sequence));
          const affectedWhammies = await tx<Array<{
            id: string;
            team_id: string | null;
            amount_minor: number;
          }>>`
            SELECT DISTINCT we.id, we.team_id, we.amount_minor
            FROM whammy_events we
            JOIN budget_ledger_entries ble ON ble.reference_id = we.id AND ble.entry_type = 'WHAMMY' AND ble.active = true
            JOIN draft_events de
              ON de.draft_id = ${draft.id}
             AND de.event_type = 'WHAMMY_APPLIED'
             AND ((de.payload #>> '{}')::jsonb ->> 'whammy_event_id') = we.id::text
            WHERE we.draft_id = ${draft.id} AND we.status = 'APPLIED' AND de.sequence >= ${minResolutionSeq}
          `;

          for (const w of affectedWhammies) {
            await tx`
              INSERT INTO budget_ledger_entries
                (draft_id, team_id, amount_minor, entry_type, reference_id, active)
              VALUES
                (${draft.id}, ${w.team_id}, ${-w.amount_minor}, 'ROLLBACK', ${w.id}, true)
            `;
            if (w.team_id) {
              await tx`
                UPDATE draft_team_states
                SET remaining_budget_minor = remaining_budget_minor - ${w.amount_minor}
                WHERE draft_id = ${draft.id} AND team_id = ${w.team_id}
              `;
            }
            await tx`
              UPDATE whammy_events SET status = 'REVERSED' WHERE id = ${w.id}
            `;
          }

          for (const pick of picks) {
            // 1. Mark acquisition inactive (append-only: supersede, never delete)
            await tx`
              UPDATE acquisitions SET active = false WHERE id = ${pick.id}
            `;

            // 2. Mark roster entries inactive
            await tx`
              UPDATE roster_entries
              SET active = false
              WHERE acquisition_id = ${pick.id} AND draft_id = ${draft.id}
            `;

            // 3. Insert ROLLBACK BudgetLedgerEntry (positive amount = refund)
            await tx`
              INSERT INTO budget_ledger_entries
                (draft_id, team_id, acquisition_id, amount_minor, entry_type, active)
              VALUES
                (${draft.id}, ${pick.team_id}, ${pick.id}, ${pick.price_minor}, 'ROLLBACK', true)
            `;

            // 4. Reset PlayerAuction to PENDING, clear resolution_sequence
            await tx`
              UPDATE player_auctions
              SET status = 'PENDING', resolution_sequence = NULL
              WHERE id = ${pick.player_auction_id}
            `;

            // 5. Refund budget, decrement roster count, restore required spots
            await tx`
              UPDATE draft_team_states
              SET remaining_budget_minor = remaining_budget_minor + ${pick.price_minor},
                  roster_filled_count = GREATEST(0, roster_filled_count - 1),
                  required_remaining_spots = required_remaining_spots + 1
              WHERE draft_id = ${draft.id} AND team_id = ${pick.team_id}
            `;
          }

          // Append ROLLBACK_APPLIED DraftEvent (single event for the whole batch)
          const seq = await nextEventSeq(tx, draft.id);
          const picksPayload = picks.map((p) => ({
            acquisition_id: p.id,
            player_name: p.player_name,
            team_id: p.team_id,
            price_minor: p.price_minor,
          }));
          await tx`
            INSERT INTO draft_events
              (draft_id, sequence, event_type, payload, created_at)
            VALUES
              (${draft.id}, ${seq}, 'ROLLBACK_APPLIED',
               ${JSON.stringify({ count: picks.length, picks_reversed: picksPayload })}::jsonb,
               NOW())
          `;
        });
      } catch (err) {
        server.log.error(err, '[corrections] rollback transaction failed');
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Transaction failed' });
      }

      const picksReversed = picks.map((p) => ({
        acquisition_id: p.id,
        player_name: p.player_name,
        team_id: p.team_id,
        price_minor: p.price_minor,
      }));

      // Broadcast after commit
      broadcast(draft.id, {
        type: 'ROLLBACK_APPLIED',
        payload: {
          count: picks.length,
          picks_reversed: picksReversed,
        },
      });

      return reply.send({
        rolled_back: picks.length,
        picks_reversed: picksReversed,
      });
    },
  );

  /**
   * GET /drafts/:draftId/rollback/preview?count=N
   *
   * Read-only dry-run: same pick-selection as POST rollback (highest
   * resolution_sequence first, active=true only) but performs no writes.
   * Returns a per-pick breakdown (budget returned, roster slot vacated,
   * Whammy interactions) plus the draft's current state_version, so the
   * caller (MOD-012) can detect staleness before confirming (data-model.md §17.5).
   */
  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/rollback/preview',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const queryParse = RollbackPreviewQuery.safeParse(req.query);
      if (!queryParse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid count' });
      }
      const { count } = queryParse.data;

      const picks = await sql<Array<{
        id: string;
        team_id: string;
        price_minor: number;
        resolution_sequence: number;
        player_name: string;
        vacated_roster_slot: string | null;
      }>>`
        SELECT
          a.id, a.team_id, a.price_minor, a.resolution_sequence,
          p.name AS player_name,
          rsd.position AS vacated_roster_slot
        FROM acquisitions a
        JOIN player_auctions pa ON pa.id = a.player_auction_id
        JOIN players p ON p.id = pa.dataset_player_id
        LEFT JOIN roster_entries re ON re.acquisition_id = a.id AND re.active = true
        LEFT JOIN roster_slot_definitions rsd ON rsd.id = re.roster_slot_id
        WHERE a.draft_id = ${draft.id} AND a.active = true
        ORDER BY a.resolution_sequence DESC
        LIMIT ${count}
      `;

      if (picks.length === 0) {
        return reply.status(409).send({
          code: 'NO_PICKS_TO_ROLLBACK',
          message: 'No active picks to roll back',
        });
      }

      const stateVersion = await getStateVersion(sql, draft.id);

      const previewPicks = [];
      for (const pick of picks) {
        // WHAMMY-type ledger entries for this team whose triggering WhammyEvent
        // (found via the WHAMMY_APPLIED DraftEvent that carries its id) landed at
        // or after this pick's resolution_sequence (data-model.md §18.3).
        const whammyRows = await sql<Array<{
          whammy_id: string;
          amount_minor: number;
          description: string;
        }>>`
          SELECT we.id AS whammy_id, we.amount_minor, we.description
          FROM budget_ledger_entries ble
          JOIN whammy_events we ON we.id = ble.reference_id
          JOIN draft_events de
            ON de.draft_id = ${draft.id}
           AND de.event_type = 'WHAMMY_APPLIED'
           -- de.payload is written as JSON.stringify(...)::jsonb by callers, which
           -- stores it as a jsonb scalar string rather than a jsonb object; unwrap
           -- via #>>'{}' (text form, works for both a scalar string and an object)
           -- then re-cast to jsonb before extracting the key.
           AND ((de.payload #>> '{}')::jsonb ->> 'whammy_event_id') = we.id::text
          WHERE ble.draft_id = ${draft.id}
            AND ble.team_id = ${pick.team_id}
            AND ble.entry_type = 'WHAMMY'
            AND ble.active = true
            AND de.sequence >= ${pick.resolution_sequence}
        `;

        previewPicks.push({
          acquisition_id: pick.id,
          player_name: pick.player_name,
          team_id: pick.team_id,
          price_minor: pick.price_minor,
          budget_return_minor: pick.price_minor,
          vacated_roster_slot: pick.vacated_roster_slot,
          whammy_interactions: whammyRows.map((w) => ({
            whammy_id: w.whammy_id,
            amount_minor: w.amount_minor,
            description: w.description,
          })),
        });
      }

      return reply.send({
        would_roll_back: picks.length,
        picks: previewPicks,
        state_version: stateVersion,
      });
    },
  );
}
