/**
 * Draft lifecycle REST endpoints:
 *   POST /drafts/:draftId/start   — CREATED → RUNNING
 *   POST /drafts/:draftId/pause   — RUNNING → PAUSED
 *   POST /drafts/:draftId/resume  — PAUSED  → RUNNING
 *
 * All require a commissioner JWT whose league_id matches the draft's league_id.
 * On start: initializes DraftTeamState rows and starts the award timer.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { broadcast, startAwardTimer, stopAwardTimer } from './engine.js';

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

type DraftParams = { draftId: string };

/** Validates commissioner JWT + auth_epoch + league_id match for a draft. */
async function requireCommissionerForDraft(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
): Promise<{ draft: { id: string; league_id: string; status: string; dataset_id: string } } | null> {
  // 1. Verify JWT
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  // 2. Must be COMMISSIONER
  if (claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }

  // 3. Re-read auth_epoch from DB
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

  // 4. Load draft and verify league_id matches
  const draftRows = await sql<[{
    id: string;
    league_id: string;
    status: string;
    dataset_id: string;
  }]>`
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

  return { draft };
}

export async function registerDraftRoutes(
  // db is reserved for future Drizzle-ORM usage (currently using raw sql for complex queries)
  server: FastifyInstance,
  _db: PostgresJsDatabase,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * POST /drafts/:draftId/start
   * Transitions draft CREATED → RUNNING.
   * Initializes DraftTeamState rows for all teams in the league.
   * Starts the award timer.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/start',
    async (req, reply) => {
      const ctx = await requireCommissionerForDraft(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'CREATED') {
        return reply.status(409).send({
          code: 'CONFLICT',
          message: `Draft is ${draft.status}; can only start a CREATED draft`,
        });
      }

      // Get auction config for initial_budget_minor and total_roster_size
      const cfgRows = await sql<[{ initial_budget_minor: number }]>`
        SELECT initial_budget_minor FROM auction_configurations
        WHERE league_id = ${draft.league_id} LIMIT 1
      `;
      const cfg = cfgRows[0];
      if (!cfg) {
        return reply.status(422).send({ code: 'NO_AUCTION_CONFIG', message: 'Auction configuration missing' });
      }

      const rosterRows = await sql<[{ total_roster_size: number }]>`
        SELECT total_roster_size FROM roster_configurations
        WHERE league_id = ${draft.league_id} LIMIT 1
      `;
      const rosterCfg = rosterRows[0];
      const totalRosterSize = rosterCfg?.total_roster_size ?? 0;

      // Get all teams for this league
      const teamsRows = await sql<[{ id: string }]>`
        SELECT id FROM teams WHERE league_id = ${draft.league_id}
      `;

      await sql.begin(async (tx) => {
        // UPDATE draft status → RUNNING
        await tx`
          UPDATE drafts SET status = 'RUNNING', started_at = NOW()
          WHERE id = ${draft.id}
        `;

        // Initialize DraftTeamState for each team (only if not already created)
        for (const team of teamsRows) {
          const existing = await tx<[{ id: string }]>`
            SELECT id FROM draft_team_states
            WHERE draft_id = ${draft.id} AND team_id = ${team.id}
            LIMIT 1
          `;
          if (existing.length === 0) {
            await tx`
              INSERT INTO draft_team_states
                (draft_id, team_id, remaining_budget_minor, roster_filled_count,
                 required_remaining_spots, control_mode)
              VALUES
                (${draft.id}, ${team.id}, ${cfg.initial_budget_minor}, 0,
                 ${totalRosterSize}, 'MANUAL')
            `;
          }
        }

        // Append DRAFT_STARTED event
        const seqRows = await tx<[{ max: number | null }]>`
          SELECT COALESCE(MAX(sequence), -1) + 1 AS max
          FROM draft_events WHERE draft_id = ${draft.id}
        `;
        const seq = seqRows[0]?.max ?? 0;
        await tx`
          INSERT INTO draft_events
            (draft_id, sequence, event_type, payload, created_at)
          VALUES
            (${draft.id}, ${seq}, 'DRAFT_STARTED', '{}', NOW())
        `;
      });

      // Start award timer for this draft
      startAwardTimer(draft.id, sql);

      // Broadcast status change to WS clients
      broadcast(draft.id, {
        type: 'DRAFT_STATUS_CHANGED',
        payload: { draft_id: draft.id, status: 'RUNNING' },
      });

      return reply.send({ draft_id: draft.id, status: 'RUNNING' });
    },
  );

  /**
   * POST /drafts/:draftId/pause
   * Transitions draft RUNNING → PAUSED.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/pause',
    async (req, reply) => {
      const ctx = await requireCommissionerForDraft(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'RUNNING') {
        return reply.status(409).send({
          code: 'CONFLICT',
          message: `Draft is ${draft.status}; can only pause a RUNNING draft`,
        });
      }

      await sql.begin(async (tx) => {
        await tx`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draft.id}`;
        const seqRows = await tx<[{ max: number | null }]>`
          SELECT COALESCE(MAX(sequence), -1) + 1 AS max
          FROM draft_events WHERE draft_id = ${draft.id}
        `;
        const seq = seqRows[0]?.max ?? 0;
        await tx`
          INSERT INTO draft_events (draft_id, sequence, event_type, payload, created_at)
          VALUES (${draft.id}, ${seq}, 'DRAFT_PAUSED', '{}', NOW())
        `;
      });

      stopAwardTimer(draft.id);

      broadcast(draft.id, {
        type: 'DRAFT_STATUS_CHANGED',
        payload: { draft_id: draft.id, status: 'PAUSED' },
      });

      return reply.send({ draft_id: draft.id, status: 'PAUSED' });
    },
  );

  /**
   * POST /drafts/:draftId/resume
   * Transitions draft PAUSED → RUNNING.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/resume',
    async (req, reply) => {
      const ctx = await requireCommissionerForDraft(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'PAUSED') {
        return reply.status(409).send({
          code: 'CONFLICT',
          message: `Draft is ${draft.status}; can only resume a PAUSED draft`,
        });
      }

      await sql.begin(async (tx) => {
        await tx`UPDATE drafts SET status = 'RUNNING' WHERE id = ${draft.id}`;
        const seqRows = await tx<[{ max: number | null }]>`
          SELECT COALESCE(MAX(sequence), -1) + 1 AS max
          FROM draft_events WHERE draft_id = ${draft.id}
        `;
        const seq = seqRows[0]?.max ?? 0;
        await tx`
          INSERT INTO draft_events (draft_id, sequence, event_type, payload, created_at)
          VALUES (${draft.id}, ${seq}, 'DRAFT_RESUMED', '{}', NOW())
        `;
      });

      startAwardTimer(draft.id, sql);

      broadcast(draft.id, {
        type: 'DRAFT_STATUS_CHANGED',
        payload: { draft_id: draft.id, status: 'RUNNING' },
      });

      return reply.send({ draft_id: draft.id, status: 'RUNNING' });
    },
  );
}
