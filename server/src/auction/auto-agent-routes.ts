/**
 * Auto-Agent REST routes (F-MOD-004):
 *   PUT  /drafts/:draftId/teams/:teamId/auto-agent     — set willingness_pct
 *   PATCH /drafts/:draftId/teams/:teamId/control-mode  — set MANUAL | AUTO_AGENT
 *
 * Both require a valid bearer JWT. auth_epoch is re-read from DB on every request.
 * Per constraint #11: every request also verifies league_id matches the draft's league_id.
 * Per constraint #12: auth_epoch re-read on every command (not just at login).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { setControlMode, upsertAutoAgentConfig } from './auto-agent.js';

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

interface DraftTeamParams {
  draftId: string;
  teamId: string;
}

/**
 * Verify JWT, re-read auth_epoch, verify league_id matches draft, verify caller
 * is either the team's owner or a commissioner.
 */
async function requireTeamOrCommissioner(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftTeamParams }>,
  reply: FastifyReply,
): Promise<{
  claims: TokenClaims;
  draft: { id: string; league_id: string; status: string };
} | null> {
  // 1. Verify JWT
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  // 2. Re-read auth_epoch from DB — constraint #12
  let currentEpoch: number | undefined;
  if (claims.role === 'OWNER' && claims.team_id) {
    const rows = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM teams WHERE id = ${claims.team_id} LIMIT 1
    `;
    currentEpoch = rows[0]?.auth_epoch;
  } else {
    const rows = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
    `;
    currentEpoch = rows[0]?.auth_epoch;
  }

  if (currentEpoch === undefined || claims.auth_epoch !== currentEpoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  // 3. Load draft and verify league_id matches token
  const draftRows = await sql<[{ id: string; league_id: string; status: string }]>`
    SELECT id, league_id, status FROM drafts WHERE id = ${req.params.draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'Draft not found' });
    return null;
  }

  // Multi-draft isolation — constraint #11
  if (draft.league_id !== claims.league_id) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Draft belongs to a different league' });
    return null;
  }

  // 4. Must be the team's owner OR a commissioner
  if (claims.role === 'OWNER') {
    if (claims.team_id !== req.params.teamId) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Can only modify your own team' });
      return null;
    }
  } else if (claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner or team owner required' });
    return null;
  }

  return { claims, draft };
}

export async function registerAutoAgentRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * PUT /drafts/:draftId/teams/:teamId/auto-agent
   * Configure Auto-Agent willingness ceiling for a team.
   * Body: { willingness_pct: number (0–1) }
   */
  server.put<{
    Params: DraftTeamParams;
    Body: { willingness_pct: number };
  }>(
    '/drafts/:draftId/teams/:teamId/auto-agent',
    async (req, reply) => {
      const ctx = await requireTeamOrCommissioner(server, sql, req, reply);
      if (!ctx) return;

      const { willingness_pct } = req.body;
      if (
        typeof willingness_pct !== 'number' ||
        willingness_pct < 0 ||
        willingness_pct > 1
      ) {
        return reply.status(400).send({
          code: 'INVALID_PARAM',
          message: 'willingness_pct must be a number in [0, 1]',
        });
      }

      const result = await upsertAutoAgentConfig(
        req.params.draftId,
        req.params.teamId,
        willingness_pct,
        sql,
      );

      return reply.send(result);
    },
  );

  /**
   * PATCH /drafts/:draftId/teams/:teamId/control-mode
   * Manually set a team's control mode (MANUAL | AUTO_AGENT).
   * Body: { mode: 'MANUAL' | 'AUTO_AGENT' }
   */
  server.patch<{
    Params: DraftTeamParams;
    Body: { mode: string };
  }>(
    '/drafts/:draftId/teams/:teamId/control-mode',
    async (req, reply) => {
      const ctx = await requireTeamOrCommissioner(server, sql, req, reply);
      if (!ctx) return;

      const { mode } = req.body;
      if (mode !== 'MANUAL' && mode !== 'AUTO_AGENT') {
        return reply.status(400).send({
          code: 'INVALID_PARAM',
          message: 'mode must be MANUAL or AUTO_AGENT',
        });
      }

      await setControlMode(
        req.params.draftId,
        req.params.teamId,
        mode,
        'manual',
        sql,
      );

      return reply.send({
        team_id: req.params.teamId,
        control_mode: mode,
      });
    },
  );
}
