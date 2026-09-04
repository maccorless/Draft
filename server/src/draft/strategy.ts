/**
 * Owner strategy REST endpoints (F-MOD-008):
 *   GET    /drafts/:draftId/teams/:teamId/target-values
 *   PUT    /drafts/:draftId/teams/:teamId/target-values
 *   GET    /drafts/:draftId/teams/:teamId/watchlist
 *   POST   /drafts/:draftId/teams/:teamId/watchlist
 *   DELETE /drafts/:draftId/teams/:teamId/watchlist/:playerId
 *   GET    /drafts/:draftId/teams/:teamId/nomination-queue
 *   PUT    /drafts/:draftId/teams/:teamId/nomination-queue
 *
 * Auth rules (enforced on every endpoint):
 * - JWT required; token.team_id must equal :teamId param (403 on mismatch).
 * - auth_epoch re-read from teams table on every command (constraint #12).
 * - draft.league_id must match token.league_id (dual-layer isolation, constraint #11).
 *
 * Target values are NEVER emitted in any WS broadcast.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';

import { resolveEffectivePrimarySource } from '../player/aav-resolution.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenClaims {
  league_id: string;
  team_id?: string;
  role: string;
  auth_epoch: number;
}

interface StrategyParams {
  draftId: string;
  teamId: string;
}

interface WatchlistItemParams extends StrategyParams {
  playerId: string;
}

type NominationQueueItemParams = WatchlistItemParams;

// ─── Auth helper ──────────────────────────────────────────────────────────────

/**
 * Verifies JWT, enforces token.team_id === :teamId, re-reads auth_epoch,
 * and checks draft.league_id === token.league_id.
 * Returns null and sends the error reply on failure.
 */
export async function requireTeamOwner(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: StrategyParams }>,
  reply: FastifyReply,
): Promise<{ draftId: string; teamId: string; leagueId: string } | null> {
  // 1. Verify JWT
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  const { draftId, teamId } = req.params;

  // 2. token.team_id must match the :teamId route param (private data guard)
  if (!claims.team_id || claims.team_id !== teamId) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Token does not match requested team' });
    return null;
  }

  // 3. Re-read auth_epoch from teams table (only revocation mechanism)
  const teamRows = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM teams WHERE id = ${teamId} LIMIT 1
  `;
  const team = teamRows[0];
  if (!team) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found' });
    return null;
  }
  if (claims.auth_epoch !== team.auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  // 4. Load draft and verify league_id matches token (dual-layer isolation)
  const draftRows = await sql<[{ id: string; league_id: string }]>`
    SELECT id, league_id FROM drafts WHERE id = ${draftId} LIMIT 1
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

  return { draftId, teamId, leagueId: claims.league_id };
}

/** Resolves a draft's dataset_id and effective primary AAV source in one call. */
async function getDatasetAndPrimarySource(
  sql: postgres.Sql,
  draftId: string,
): Promise<{ datasetId: string | null; source: string | null }> {
  const [row] = await sql<[{ dataset_id: string }]>`
    SELECT dataset_id FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  if (!row) return { datasetId: null, source: null };
  const source = await resolveEffectivePrimarySource(sql, row.dataset_id);
  return { datasetId: row.dataset_id, source };
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const SetTargetValuesBody = z.object({
  targets: z.array(
    z.object({
      dataset_player_id: z.string().uuid(),
      target_value_minor: z.number().int().min(0),
    }),
  ),
});

const WatchlistAddBody = z.object({
  dataset_player_id: z.string().uuid(),
});

const ReorderQueueBody = z.object({
  ordered_player_ids: z.array(z.string().uuid()),
});

const NominationQueueAddBody = z.object({
  dataset_player_id: z.string().uuid(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export async function registerStrategyRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // ── Target Values ────────────────────────────────────────────────────────────

  /**
   * GET /drafts/:draftId/teams/:teamId/target-values
   * Returns the authenticated team's OwnerTargetValue rows for the draft.
   * 403 if token.team_id !== :teamId.
   */
  server.get<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/target-values',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const { datasetId, source } = await getDatasetAndPrimarySource(sql, ctx.draftId);

      const rows = await sql<Array<{
        dataset_player_id: string;
        target_value_minor: number;
        player_name: string;
        position: string;
        aav_minor: number | null;
      }>>`
        SELECT
          otv.dataset_player_id,
          otv.target_value_minor,
          p.name AS player_name,
          p.position,
          pas.aav_minor
        FROM owner_target_values otv
        JOIN players p ON p.id = otv.dataset_player_id
        LEFT JOIN player_aav_sources pas
          ON pas.player_id = p.id AND pas.dataset_id = ${datasetId} AND pas.source = ${source}
        WHERE otv.draft_id = ${ctx.draftId}
          AND otv.team_id = ${ctx.teamId}
        ORDER BY p.name ASC
      `;

      return reply.status(200).send({
        targets: rows.map((r) => ({ ...r, aav_minor: r.aav_minor ?? 0 })),
      });
    },
  );

  /**
   * PUT /drafts/:draftId/teams/:teamId/target-values
   * Upserts OwnerTargetValue rows (insert or update on draft_id+team_id+player).
   * No WS broadcast — target values are strictly private.
   */
  server.put<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/target-values',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const parsed = SetTargetValuesBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }

      const { targets } = parsed.data;

      // Upsert each target value: delete-then-insert (no unique constraint needed)
      for (const t of targets) {
        await sql`
          DELETE FROM owner_target_values
          WHERE draft_id = ${ctx.draftId}
            AND team_id = ${ctx.teamId}
            AND dataset_player_id = ${t.dataset_player_id}
        `;
        await sql`
          INSERT INTO owner_target_values
            (draft_id, team_id, dataset_player_id, target_value_minor)
          VALUES
            (${ctx.draftId}, ${ctx.teamId}, ${t.dataset_player_id}, ${t.target_value_minor})
        `;
      }

      return reply.status(200).send({ updated: targets.length });
    },
  );

  // ── Watch List ───────────────────────────────────────────────────────────────

  /**
   * GET /drafts/:draftId/teams/:teamId/watchlist
   * Returns WatchListItem rows with player_id, player_name, position.
   * Watch List NEVER auto-nominates.
   */
  server.get<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/watchlist',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const { datasetId, source } = await getDatasetAndPrimarySource(sql, ctx.draftId);

      const rows = await sql<Array<{
        dataset_player_id: string;
        player_name: string;
        position: string;
        aav_minor: number | null;
        created_at: Date;
      }>>`
        SELECT
          wli.dataset_player_id,
          p.name AS player_name,
          p.position,
          pas.aav_minor,
          wli.created_at
        FROM watch_list_items wli
        JOIN players p ON p.id = wli.dataset_player_id
        LEFT JOIN player_aav_sources pas
          ON pas.player_id = p.id AND pas.dataset_id = ${datasetId} AND pas.source = ${source}
        WHERE wli.draft_id = ${ctx.draftId}
          AND wli.team_id = ${ctx.teamId}
        ORDER BY wli.created_at ASC
      `;

      return reply.status(200).send({
        watchlist: rows.map((r) => ({ ...r, aav_minor: r.aav_minor ?? 0 })),
      });
    },
  );

  /**
   * POST /drafts/:draftId/teams/:teamId/watchlist
   * Adds a player to the Watch List. Idempotent (duplicate is 409 if already present).
   * Watch List items NEVER cause automatic nomination.
   */
  server.post<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/watchlist',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const parsed = WatchlistAddBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }

      const { dataset_player_id } = parsed.data;

      // Verify player exists in draft dataset
      const draftRows = await sql<[{ dataset_id: string }]>`
        SELECT dataset_id FROM drafts WHERE id = ${ctx.draftId} LIMIT 1
      `;
      const playerRows = await sql<Array<{ id: string }>>`
        SELECT id FROM player_aav_sources
        WHERE player_id = ${dataset_player_id} AND dataset_id = ${draftRows[0]!.dataset_id}
        LIMIT 1
      `;
      if (playerRows.length === 0) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Player not in draft dataset' });
      }

      // Check for duplicate before insert
      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM watch_list_items
        WHERE draft_id = ${ctx.draftId}
          AND team_id = ${ctx.teamId}
          AND dataset_player_id = ${dataset_player_id}
        LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(200).send({ created: false, id: existing[0]!.id });
      }

      const result = await sql<Array<{ id: string }>>`
        INSERT INTO watch_list_items (draft_id, team_id, dataset_player_id)
        VALUES (${ctx.draftId}, ${ctx.teamId}, ${dataset_player_id})
        RETURNING id
      `;

      if (result.length === 0) {
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Insert failed' });
      }

      return reply.status(201).send({ id: result[0]!.id });
    },
  );

  /**
   * DELETE /drafts/:draftId/teams/:teamId/watchlist/:playerId
   * Removes a player from the Watch List. Returns 204 whether or not it existed.
   */
  server.delete<{ Params: WatchlistItemParams }>(
    '/drafts/:draftId/teams/:teamId/watchlist/:playerId',
    async (req, reply) => {
      // Re-use requireTeamOwner — params has draftId + teamId
      const ctx = await requireTeamOwner(
        server,
        sql,
        req as FastifyRequest<{ Params: StrategyParams }>,
        reply,
      );
      if (!ctx) return;

      const { playerId } = req.params;

      await sql`
        DELETE FROM watch_list_items
        WHERE draft_id = ${ctx.draftId}
          AND team_id = ${ctx.teamId}
          AND dataset_player_id = ${playerId}
      `;

      return reply.status(204).send();
    },
  );

  // ── Nomination Queue ─────────────────────────────────────────────────────────

  /**
   * GET /drafts/:draftId/teams/:teamId/nomination-queue
   * Returns NominationQueueItem rows ordered by ascending queue_position.
   */
  server.get<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/nomination-queue',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const { datasetId, source } = await getDatasetAndPrimarySource(sql, ctx.draftId);

      const rows = await sql<Array<{
        dataset_player_id: string;
        queue_position: number;
        player_name: string;
        position: string;
        aav_minor: number | null;
      }>>`
        SELECT
          nqi.dataset_player_id,
          nqi.queue_position,
          p.name AS player_name,
          p.position,
          pas.aav_minor
        FROM nomination_queue_items nqi
        JOIN players p ON p.id = nqi.dataset_player_id
        LEFT JOIN player_aav_sources pas
          ON pas.player_id = p.id AND pas.dataset_id = ${datasetId} AND pas.source = ${source}
        WHERE nqi.draft_id = ${ctx.draftId}
          AND nqi.team_id = ${ctx.teamId}
        ORDER BY nqi.queue_position ASC
      `;

      return reply.status(200).send({
        queue: rows.map((r) => ({ ...r, aav_minor: r.aav_minor ?? 0 })),
      });
    },
  );

  /**
   * POST /drafts/:draftId/teams/:teamId/nomination-queue
   * Adds a player to the nomination queue at the end (highest existing position + 1).
   */
  server.post<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/nomination-queue',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const parsed = NominationQueueAddBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }

      const { dataset_player_id } = parsed.data;

      // Verify player exists in draft dataset
      const draftRows = await sql<[{ dataset_id: string }]>`
        SELECT dataset_id FROM drafts WHERE id = ${ctx.draftId} LIMIT 1
      `;
      const playerRows = await sql<Array<{ id: string }>>`
        SELECT id FROM player_aav_sources
        WHERE player_id = ${dataset_player_id} AND dataset_id = ${draftRows[0]!.dataset_id}
        LIMIT 1
      `;
      if (playerRows.length === 0) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Player not in draft dataset' });
      }

      // Get next position
      const posRows = await sql<Array<{ max_pos: number | null }>>`
        SELECT MAX(queue_position) AS max_pos
        FROM nomination_queue_items
        WHERE draft_id = ${ctx.draftId} AND team_id = ${ctx.teamId}
      `;
      const nextPos = (posRows[0]?.max_pos ?? -1) + 1;

      // Check for duplicate before insert
      const existingQ = await sql<Array<{ id: string }>>`
        SELECT id FROM nomination_queue_items
        WHERE draft_id = ${ctx.draftId}
          AND team_id = ${ctx.teamId}
          AND dataset_player_id = ${dataset_player_id}
        LIMIT 1
      `;
      if (existingQ.length > 0) {
        return reply.status(200).send({ created: false, id: existingQ[0]!.id });
      }

      const result = await sql<Array<{ id: string }>>`
        INSERT INTO nomination_queue_items (draft_id, team_id, dataset_player_id, queue_position)
        VALUES (${ctx.draftId}, ${ctx.teamId}, ${dataset_player_id}, ${nextPos})
        RETURNING id
      `;

      if (result.length === 0) {
        return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Insert failed' });
      }

      return reply.status(201).send({ id: result[0]!.id, queue_position: nextPos });
    },
  );

  /**
   * PUT /drafts/:draftId/teams/:teamId/nomination-queue
   * Reorders the queue: ordered_player_ids[0] gets queue_position=0, etc.
   * Position 0 = first to be auto-nominated.
   */
  server.put<{ Params: StrategyParams }>(
    '/drafts/:draftId/teams/:teamId/nomination-queue',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const parsed = ReorderQueueBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }

      const { ordered_player_ids } = parsed.data;

      // Update queue_position for each player in the submitted order
      for (let i = 0; i < ordered_player_ids.length; i++) {
        await sql`
          UPDATE nomination_queue_items
          SET queue_position = ${i}
          WHERE draft_id = ${ctx.draftId}
            AND team_id = ${ctx.teamId}
            AND dataset_player_id = ${ordered_player_ids[i]!}
        `;
      }

      return reply.status(200).send({ reordered: ordered_player_ids.length });
    },
  );

  /**
   * DELETE /drafts/:draftId/teams/:teamId/nomination-queue/:playerId
   * Removes a player from the nomination queue. Returns 204 whether or not it existed.
   */
  server.delete<{ Params: NominationQueueItemParams }>(
    '/drafts/:draftId/teams/:teamId/nomination-queue/:playerId',
    async (req, reply) => {
      const ctx = await requireTeamOwner(
        server,
        sql,
        req as FastifyRequest<{ Params: StrategyParams }>,
        reply,
      );
      if (!ctx) return;

      const { playerId } = req.params;

      await sql`
        DELETE FROM nomination_queue_items
        WHERE draft_id = ${ctx.draftId}
          AND team_id = ${ctx.teamId}
          AND dataset_player_id = ${playerId}
      `;

      return reply.status(204).send();
    },
  );
}

// ─── Nomination Queue lookup (for auto-nomination hook in engine) ─────────────

/**
 * Returns the dataset_player_id and aav_minor at position 0 of the team's
 * nomination queue for the given draft, or null if the queue is empty.
 *
 * Called by processPassNomination in engine.ts when the nominator has no explicit pick.
 */
export async function getTopNominationQueueEntry(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
): Promise<{ dataset_player_id: string; aav_minor: number } | null> {
  const { datasetId, source } = await getDatasetAndPrimarySource(sql, draftId);
  const rows = await sql<[{ dataset_player_id: string; aav_minor: number | null }]>`
    SELECT nqi.dataset_player_id, pas.aav_minor
    FROM nomination_queue_items nqi
    JOIN players p ON p.id = nqi.dataset_player_id
    LEFT JOIN player_aav_sources pas
      ON pas.player_id = p.id AND pas.dataset_id = ${datasetId} AND pas.source = ${source}
    WHERE nqi.draft_id = ${draftId}
      AND nqi.team_id = ${teamId}
    ORDER BY nqi.queue_position ASC
    LIMIT 1
  `;
  const top = rows[0];
  return top ? { dataset_player_id: top.dataset_player_id, aav_minor: top.aav_minor ?? 0 } : null;
}
