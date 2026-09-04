/**
 * Do Not Draft (F-MOD-014, PRD §12.3, data-model.md §10.4):
 *   GET    /drafts/:draftId/teams/:teamId/do-not-draft
 *   POST   /drafts/:draftId/teams/:teamId/do-not-draft
 *   DELETE /drafts/:draftId/teams/:teamId/do-not-draft/:playerId
 *
 * Same auth rules as F-MOD-008's strategy endpoints (requireTeamOwner):
 * token.team_id must equal :teamId, auth_epoch re-read from DB, and
 * draft.league_id must match token.league_id. Entries are per-team private
 * data, never broadcast, and only ever constrain Auto-Agent bid candidate
 * selection (server/src/auction/auto-agent.ts) — never manual bidding.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';

import { requireTeamOwner } from './strategy.js';

interface DoNotDraftParams {
  draftId: string;
  teamId: string;
}

interface DoNotDraftItemParams extends DoNotDraftParams {
  playerId: string;
}

const AddDoNotDraftBody = z.object({
  player_id: z.string().uuid(),
});

export async function registerDoNotDraftRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * GET /drafts/:draftId/teams/:teamId/do-not-draft
   * Returns the authenticated team's Do Not Draft entries for the draft.
   */
  server.get<{ Params: DoNotDraftParams }>(
    '/drafts/:draftId/teams/:teamId/do-not-draft',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const rows = await sql<Array<{ dataset_player_id: string; player_name: string }>>`
        SELECT ddi.dataset_player_id, p.name AS player_name
        FROM do_not_draft_items ddi
        JOIN players p ON p.id = ddi.dataset_player_id
        WHERE ddi.draft_id = ${ctx.draftId}
          AND ddi.team_id = ${ctx.teamId}
        ORDER BY p.name ASC
      `;

      return reply.status(200).send({
        entries: rows.map((r) => ({ player_id: r.dataset_player_id, player_name: r.player_name })),
      });
    },
  );

  /**
   * POST /drafts/:draftId/teams/:teamId/do-not-draft
   * Adds a player to the team's Do Not Draft list. Idempotent.
   */
  server.post<{ Params: DoNotDraftParams }>(
    '/drafts/:draftId/teams/:teamId/do-not-draft',
    async (req, reply) => {
      const ctx = await requireTeamOwner(server, sql, req, reply);
      if (!ctx) return;

      const parsed = AddDoNotDraftBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }
      const { player_id } = parsed.data;

      const playerRows = await sql<Array<{ id: string; name: string }>>`
        SELECT id, name FROM players WHERE id = ${player_id} LIMIT 1
      `;
      if (playerRows.length === 0) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Player not found' });
      }

      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM do_not_draft_items
        WHERE draft_id = ${ctx.draftId} AND team_id = ${ctx.teamId} AND dataset_player_id = ${player_id}
        LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(201).send({ player_id, player_name: playerRows[0]!.name });
      }

      await sql`
        INSERT INTO do_not_draft_items (draft_id, team_id, dataset_player_id)
        VALUES (${ctx.draftId}, ${ctx.teamId}, ${player_id})
      `;

      return reply.status(201).send({ player_id, player_name: playerRows[0]!.name });
    },
  );

  /**
   * DELETE /drafts/:draftId/teams/:teamId/do-not-draft/:playerId
   * Removes a player from the team's Do Not Draft list. 204 whether or not it existed.
   */
  server.delete<{ Params: DoNotDraftItemParams }>(
    '/drafts/:draftId/teams/:teamId/do-not-draft/:playerId',
    async (req, reply) => {
      const ctx = await requireTeamOwner(
        server,
        sql,
        req as FastifyRequest<{ Params: DoNotDraftParams }>,
        reply,
      );
      if (!ctx) return;

      const { playerId } = req.params;

      await sql`
        DELETE FROM do_not_draft_items
        WHERE draft_id = ${ctx.draftId} AND team_id = ${ctx.teamId} AND dataset_player_id = ${playerId}
      `;

      return reply.status(204).send();
    },
  );
}
