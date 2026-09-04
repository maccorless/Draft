/**
 * F-MOD-011 Commissioner Draft Control Live-Operation UI — REST endpoints:
 *   POST /drafts/:draftId/timers/extend
 *   POST /drafts/:draftId/teams/:teamId/budget-adjustment
 *   POST /drafts/:draftId/auctions/current/reassign
 *   GET  /drafts/:draftId/health
 *   GET  /drafts/:draftId/audit-log
 *
 * All commissioner-only; auth_epoch and league_id are re-checked on every
 * request (CLAUDE.md constraints #11/#12). Pause/resume, nominate/bid-for-
 * owner (WS on_behalf_of_team_id), and Manual/Auto-Agent toggle reuse
 * existing MOD-002/MOD-004 endpoints and are not redefined here.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';
import { broadcast, getConnectionCounts } from '../auction/engine.js';

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
  dataset_id: string;
}

type DraftParams = { draftId: string };
type DraftTeamParams = { draftId: string; teamId: string };

// ─── Auth helper (mirrors auction/routes.ts + draft/corrections.ts pattern) ──

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

  const draftRows = await sql<[DraftRow]>`
    SELECT id, league_id, status, dataset_id FROM drafts WHERE id = ${req.params.draftId} LIMIT 1
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

async function nextEventSeq(tx: postgres.TransactionSql, draftId: string): Promise<number> {
  const [row] = await tx<[{ max: number | null }]>`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS max FROM draft_events WHERE draft_id = ${draftId}
  `;
  return row?.max ?? 0;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ─── Request body schemas ──────────────────────────────────────────────────────

const ExtendTimerBody = z.object({
  seconds: z.number().int().min(1),
});

const BudgetAdjustmentBody = z.object({
  delta_minor: z.number().int(),
  reason: z.string().min(1),
});

const ReassignBody = z.object({
  new_player_dataset_entry_id: z.string().uuid().nullable().optional(),
  award_to_team_id: z.string().uuid().nullable().optional(),
  award_price_minor: z.number().int().nullable().optional(),
});

// ─── Audit log event-type filter ───────────────────────────────────────────────
// Commissioner-relevant and exception event types read from the append-only
// DraftEvent log — no new write path (CLAUDE.md constraint #2).

const AUDIT_LOG_EVENT_TYPES = [
  'DRAFT_STARTED',
  'DRAFT_PAUSED',
  'DRAFT_RESUMED',
  'DRAFT_COMPLETE',
  'TEAM_AUTO_AGENT_ENABLED',
  'TEAM_AUTO_AGENT_DISABLED',
  'AUCTION_DEADLINE_EXTENDED',
  'BUDGET_ADJUSTED',
  'AUCTION_REASSIGNED',
  'PRICE_CORRECTED',
  'ROLLBACK_APPLIED',
  'NOMINATION_STARTED',
  'BID_ACCEPTED',
];

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerDraftControlRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * POST /drafts/:draftId/timers/extend
   * Extends the currently open (unresolved) PlayerAuction's deadline by
   * `seconds`, bumps auction_version, appends an event, broadcasts.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/timers/extend',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const parsed = ExtendTimerBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { seconds } = parsed.data;

      const [auction] = await sql<[{ id: string; rebid_deadline: Date | null; auction_version: number }]>`
        SELECT id, rebid_deadline, auction_version FROM player_auctions
        WHERE draft_id = ${draft.id} AND status = 'OPEN'
        LIMIT 1
      `;
      if (!auction) {
        return reply.status(409).send({ code: 'NO_OPEN_AUCTION', message: 'No open auction to extend' });
      }

      const currentDeadline = auction.rebid_deadline ? new Date(auction.rebid_deadline) : new Date();
      const newDeadline = new Date(currentDeadline.getTime() + seconds * 1000);
      const newVersion = auction.auction_version + 1;

      try {
        await sql.begin(async (tx) => {
          await tx`
            UPDATE player_auctions
            SET rebid_deadline = ${newDeadline.toISOString()}, auction_version = ${newVersion}
            WHERE id = ${auction.id}
          `;
          const seq = await nextEventSeq(tx, draft.id);
          await tx`
            INSERT INTO draft_events
              (draft_id, sequence, event_type, player_auction_id, payload, created_at)
            VALUES
              (${draft.id}, ${seq}, 'AUCTION_DEADLINE_EXTENDED', ${auction.id},
               ${JSON.stringify({
                 seconds,
                 new_deadline_at: newDeadline.toISOString(),
                 auction_version: newVersion,
               })}::jsonb,
               NOW())
          `;
        });
      } catch (err) {
        server.log.error(err, '[draft-control] timer extend transaction failed');
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Transaction failed' });
      }

      broadcast(draft.id, {
        type: 'AUCTION_DEADLINE_EXTENDED',
        payload: {
          player_auction_id: auction.id,
          new_deadline_ts: newDeadline.getTime(),
          auction_version: newVersion,
        },
      });

      return reply.send({
        player_auction_id: auction.id,
        new_deadline_at: newDeadline.toISOString(),
        auction_version: newVersion,
      });
    },
  );

  /**
   * POST /drafts/:draftId/teams/:teamId/budget-adjustment
   * Commissioner-only ledger entry with a required reason. The entered
   * delta_minor is applied exactly — never rounded or clamped server-side.
   */
  server.post<{ Params: DraftTeamParams }>(
    '/drafts/:draftId/teams/:teamId/budget-adjustment',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;
      const teamId = req.params.teamId;

      const parsed = BudgetAdjustmentBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'delta_minor and a non-empty reason are required' });
      }
      const { delta_minor, reason } = parsed.data;

      const [state] = await sql<[{ id: string }]>`
        SELECT id FROM draft_team_states WHERE draft_id = ${draft.id} AND team_id = ${teamId} LIMIT 1
      `;
      if (!state) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Team draft state not found' });
      }

      let newRemainingBudget = 0;
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO budget_ledger_entries
              (draft_id, team_id, amount_minor, entry_type, active)
            VALUES
              (${draft.id}, ${teamId}, ${delta_minor}, 'COMMISSIONER_ADJUSTMENT', true)
          `;
          const rows = await tx<[{ remaining_budget_minor: number }]>`
            UPDATE draft_team_states
            SET remaining_budget_minor = remaining_budget_minor + ${delta_minor}
            WHERE draft_id = ${draft.id} AND team_id = ${teamId}
            RETURNING remaining_budget_minor
          `;
          newRemainingBudget = rows[0]!.remaining_budget_minor;

          const seq = await nextEventSeq(tx, draft.id);
          await tx`
            INSERT INTO draft_events
              (draft_id, sequence, event_type, team_id, payload, created_at)
            VALUES
              (${draft.id}, ${seq}, 'BUDGET_ADJUSTED', ${teamId},
               ${JSON.stringify({
                 delta_minor,
                 reason,
                 new_remaining_budget_minor: newRemainingBudget,
               })}::jsonb,
               NOW())
          `;
        });
      } catch (err) {
        server.log.error(err, '[draft-control] budget adjustment transaction failed');
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Transaction failed' });
      }

      broadcast(draft.id, {
        type: 'BUDGET_ADJUSTED',
        payload: {
          team_id: teamId,
          delta_minor,
          reason,
          new_remaining_budget_minor: newRemainingBudget,
        },
      });

      return reply.send({ team_id: teamId, new_remaining_budget_minor: newRemainingBudget });
    },
  );

  /**
   * POST /drafts/:draftId/auctions/current/reassign
   * Changes the player and/or manually sets the leader/price of the
   * currently open (unresolved) PlayerAuction. Unrestricted — no legality
   * replay — because nothing has resolved yet (CLAUDE.md constraint #10).
   * An already-awarded pick is out of scope here (see MOD-012).
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/auctions/current/reassign',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const parsed = ReassignBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { new_player_dataset_entry_id, award_to_team_id, award_price_minor } = parsed.data;

      const [auction] = await sql<[{
        id: string;
        dataset_player_id: string;
        current_leader_id: string | null;
        current_bid_minor: number;
        auction_version: number;
      }]>`
        SELECT id, dataset_player_id, current_leader_id, current_bid_minor, auction_version
        FROM player_auctions
        WHERE draft_id = ${draft.id} AND status = 'OPEN'
        LIMIT 1
      `;
      if (!auction) {
        return reply.status(409).send({ code: 'AUCTION_ALREADY_RESOLVED', message: 'Target auction is already resolved' });
      }

      if (new_player_dataset_entry_id) {
        const [player] = await sql<[{ id: string }]>`
          SELECT p.id FROM players p
          WHERE p.id = ${new_player_dataset_entry_id}
            AND EXISTS (
              SELECT 1 FROM player_aav_sources x
              WHERE x.player_id = p.id AND x.dataset_id = ${draft.dataset_id}
            )
          LIMIT 1
        `;
        if (!player) {
          return reply.status(400).send({ code: 'PLAYER_NOT_FOUND', message: 'Player not in this draft dataset' });
        }
      }

      if (award_to_team_id) {
        const [team] = await sql<[{ id: string }]>`
          SELECT id FROM teams WHERE id = ${award_to_team_id} AND league_id = ${draft.league_id} LIMIT 1
        `;
        if (!team) {
          return reply.status(400).send({ code: 'TEAM_NOT_FOUND', message: 'Team not found in this league' });
        }
      }

      const newPlayerId = new_player_dataset_entry_id ?? auction.dataset_player_id;
      const newLeaderId = award_to_team_id ?? auction.current_leader_id;
      const newBidMinor = award_price_minor ?? auction.current_bid_minor;
      const newVersion = auction.auction_version + 1;

      try {
        await sql.begin(async (tx) => {
          await tx`
            UPDATE player_auctions
            SET dataset_player_id = ${newPlayerId},
                current_leader_id = ${newLeaderId},
                current_bid_minor = ${newBidMinor},
                auction_version = ${newVersion}
            WHERE id = ${auction.id}
          `;
          const seq = await nextEventSeq(tx, draft.id);
          await tx`
            INSERT INTO draft_events
              (draft_id, sequence, event_type, player_auction_id, payload, created_at)
            VALUES
              (${draft.id}, ${seq}, 'AUCTION_REASSIGNED', ${auction.id},
               ${JSON.stringify({
                 previous_dataset_player_id: auction.dataset_player_id,
                 new_dataset_player_id: newPlayerId,
                 previous_leader_id: auction.current_leader_id,
                 new_leader_id: newLeaderId,
                 previous_bid_minor: auction.current_bid_minor,
                 new_bid_minor: newBidMinor,
                 auction_version: newVersion,
               })}::jsonb,
               NOW())
          `;
        });
      } catch (err) {
        server.log.error(err, '[draft-control] reassign transaction failed');
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Transaction failed' });
      }

      broadcast(draft.id, {
        type: 'AUCTION_REASSIGNED',
        payload: {
          player_auction_id: auction.id,
          dataset_player_id: newPlayerId,
          leading_team_id: newLeaderId,
          current_bid_minor: newBidMinor,
          auction_version: newVersion,
        },
      });

      return reply.status(200).send();
    },
  );

  /**
   * GET /drafts/:draftId/health
   * Draft Health panel (screen-information-architecture.md §9.1).
   */
  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/health',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const [[openAuction], [{ cnt: auctionsCompleted }], [{ cnt: teamCount }], [{ cnt: autoAgentTeamCount }]] = await Promise.all([
        sql<Array<{ id: string; rebid_deadline: Date | null }>>`
          SELECT id, rebid_deadline FROM player_auctions
          WHERE draft_id = ${draft.id} AND status = 'OPEN'
          LIMIT 1
        `,
        sql<[{ cnt: number }]>`
          SELECT COUNT(*)::int AS cnt FROM player_auctions
          WHERE draft_id = ${draft.id} AND status = 'AWARDED'
        `,
        sql<[{ cnt: number }]>`
          SELECT COUNT(*)::int AS cnt FROM teams WHERE league_id = ${draft.league_id}
        `,
        sql<[{ cnt: number }]>`
          SELECT COUNT(*)::int AS cnt FROM draft_team_states
          WHERE draft_id = ${draft.id} AND control_mode = 'AUTO_AGENT'
        `,
      ]);

      const { connectedTeamCount, reconnectingTeamCount } = getConnectionCounts(draft.id);

      const warnings: string[] = [];
      if (reconnectingTeamCount > 0) {
        warnings.push(`${reconnectingTeamCount} team(s) reconnecting`);
      }

      const roundOrCycle = teamCount > 0 ? Math.floor(auctionsCompleted / teamCount) + 1 : null;

      return reply.send({
        status: draft.status,
        round_or_cycle: roundOrCycle,
        auctions_completed: auctionsCompleted,
        current_player_auction_id: openAuction?.id ?? null,
        current_deadline_at: openAuction?.rebid_deadline ? toIso(openAuction.rebid_deadline) : null,
        connected_team_count: connectedTeamCount,
        auto_agent_team_count: autoAgentTeamCount,
        reconnecting_team_count: reconnectingTeamCount,
        warnings,
      });
    },
  );

  /**
   * GET /drafts/:draftId/audit-log
   * Paginated, most-recent-first, read-only projection of the DraftEvent
   * log filtered to commissioner-relevant and exception event types.
   */
  server.get<{ Params: DraftParams; Querystring: { cursor?: string; limit?: string } }>(
    '/drafts/:draftId/audit-log',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const parsedLimit = parseInt(req.query.limit ?? '', 10);
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
      const parsedCursor = req.query.cursor !== undefined ? parseInt(req.query.cursor, 10) : NaN;
      const cursorSeq = Number.isFinite(parsedCursor) ? parsedCursor : null;

      const rows = cursorSeq !== null
        ? await sql<Array<{ sequence: number; event_type: string; team_id: string | null; payload: unknown; created_at: Date }>>`
            SELECT sequence, event_type, team_id, payload, created_at FROM draft_events
            WHERE draft_id = ${draft.id}
              AND event_type = ANY(${AUDIT_LOG_EVENT_TYPES})
              AND sequence < ${cursorSeq}
            ORDER BY sequence DESC
            LIMIT ${limit}
          `
        : await sql<Array<{ sequence: number; event_type: string; team_id: string | null; payload: unknown; created_at: Date }>>`
            SELECT sequence, event_type, team_id, payload, created_at FROM draft_events
            WHERE draft_id = ${draft.id}
              AND event_type = ANY(${AUDIT_LOG_EVENT_TYPES})
            ORDER BY sequence DESC
            LIMIT ${limit}
          `;

      const entries = rows.map((r) => ({
        event_type: r.event_type,
        occurred_at: toIso(r.created_at),
        team_id: r.team_id,
        payload: r.payload,
      }));

      const nextCursor = rows.length === limit ? String(rows[rows.length - 1]!.sequence) : null;

      return reply.send({ entries, next_cursor: nextCursor });
    },
  );
}
