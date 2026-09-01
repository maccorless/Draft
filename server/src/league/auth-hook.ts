/**
 * Auth preHandler factory — validates the JWT and enforces:
 * 1. The token's league_id matches the route's :leagueId param.
 * 2. The token's auth_epoch matches the league's current auth_epoch.
 *
 * Returns a FastifyRawRequestHookHandler compatible with Fastify's preHandler option.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

import { leagues } from '../../db/schema/index.js';

// Minimum token shape we care about
interface TokenClaims {
  league_id: string;
  auth_epoch: number;
  role: string;
  team_id?: string;
}

type Params = { leagueId: string };

export function requireCommissioner(
  server: FastifyInstance,
  db: PostgresJsDatabase,
) {
  return async function (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    // 1. Verify JWT signature and expiry
    let claims: TokenClaims;
    try {
      claims = await req.jwtVerify<TokenClaims>();
    } catch {
      return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }

    // 2. Token's league_id must match the route param
    const routeLeagueId = req.params.leagueId;
    if (claims.league_id !== routeLeagueId) {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Token scope mismatch' });
    }

    // 3. Check auth_epoch against DB to detect revoked tokens
    const [league] = await db
      .select({ auth_epoch: leagues.auth_epoch })
      .from(leagues)
      .where(eq(leagues.id, routeLeagueId))
      .limit(1);

    if (!league) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
    }

    if (claims.auth_epoch !== league.auth_epoch) {
      return reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    }
  };
}
