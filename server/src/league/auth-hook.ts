/**
 * Auth preHandler factory — validates the JWT and enforces:
 * 1. The token's league_id matches the route's :leagueId param.
 * 2. The token's auth_epoch matches the current auth_epoch for its scope
 *    (leagues.auth_epoch for COMMISSIONER/HOST, teams.auth_epoch for OWNER).
 *
 * Returns a FastifyRawRequestHookHandler compatible with Fastify's preHandler option.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';

import { leagues, teams } from '../../db/schema/index.js';

// Minimum token shape we care about
interface TokenClaims {
  league_id: string;
  auth_epoch: number;
  role: string;
  team_id?: string;
}

type Params = { leagueId: string };

/**
 * Verifies the JWT, checks league scope, and re-checks the claim's
 * auth_epoch against the DB for its own scope (never trusts the token's
 * copy) — the only revocation mechanism (CLAUDE.md constraint #12).
 * Returns the verified claims on success, or null after sending an error.
 */
async function verifyAndCheckEpoch(
  db: PostgresJsDatabase,
  req: FastifyRequest<{ Params: Params }>,
  reply: FastifyReply,
): Promise<TokenClaims | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  const routeLeagueId = req.params.leagueId;
  if (claims.league_id !== routeLeagueId) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Token scope mismatch' });
    return null;
  }

  if (claims.role === 'OWNER') {
    if (!claims.team_id) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Owner token missing team_id' });
      return null;
    }
    const [team] = await db
      .select({ auth_epoch: teams.auth_epoch })
      .from(teams)
      .where(and(eq(teams.id, claims.team_id), eq(teams.league_id, routeLeagueId)))
      .limit(1);
    if (!team) {
      reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this league' });
      return null;
    }
    if (claims.auth_epoch !== team.auth_epoch) {
      reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
      return null;
    }
    return claims;
  }

  const [league] = await db
    .select({ auth_epoch: leagues.auth_epoch })
    .from(leagues)
    .where(eq(leagues.id, routeLeagueId))
    .limit(1);

  if (!league) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
    return null;
  }

  if (claims.auth_epoch !== league.auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  return claims;
}

export function requireCommissioner(
  server: FastifyInstance,
  db: PostgresJsDatabase,
) {
  return async function (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    const claims = await verifyAndCheckEpoch(db, req, reply);
    if (!claims) return;

    if (claims.role !== 'COMMISSIONER') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    }
  };
}

/**
 * Any valid league member (COMMISSIONER, HOST, or OWNER) — same scope/epoch
 * checks as requireCommissioner, but does not require the COMMISSIONER role.
 * Used by presentation/read endpoints an owner's Lobby needs (e.g. GET
 * /leagues/:leagueId's status_message and scheduled_draft_start_at), never
 * by commissioner-mutation endpoints.
 */
export function requireLeagueMember(
  server: FastifyInstance,
  db: PostgresJsDatabase,
) {
  return async function (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    const claims = await verifyAndCheckEpoch(db, req, reply);
    if (!claims) return;
  };
}
