import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { hash, verify } from '@node-rs/bcrypt';

import { leagues, teams } from '../../db/schema/index.js';
import {
  SiteAuthRequestSchema,
  LeagueAuthRequestSchema,
} from '@draft/shared-types';

const JWT_EXPIRES_IN = 172800; // 48 hours in seconds
const BCRYPT_WORK_FACTOR = 12;

export async function registerAuthRoutes(
  server: FastifyInstance,
  db: PostgresJsDatabase,
): Promise<void> {
  /**
   * POST /auth/site
   * Accepts site_password; returns list of league name+id pairs.
   * Rate-limited to 5 requests/IP/min.
   */
  server.post('/auth/site', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parse = SiteAuthRequestSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
      });
    }

    const { site_password } = parse.data;

    // Fetch all leagues — we compare password against each
    const allLeagues = await db
      .select({
        id: leagues.id,
        name: leagues.name,
        site_password_hash: leagues.site_password_hash,
      })
      .from(leagues);

    // Verify against each league's site password hash
    const matched: Array<{ id: string; name: string }> = [];
    for (const league of allLeagues) {
      const ok = await verify(site_password, league.site_password_hash);
      if (ok) {
        matched.push({ id: league.id, name: league.name });
      }
    }

    if (matched.length === 0) {
      return reply.status(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid site password',
      });
    }

    return reply.send({ leagues: matched });
  });

  /**
   * POST /auth/league/:id
   * Accepts role (COMMISSIONER or OWNER), optional team_id, password.
   * Returns a JWT with { league_id, team_id, role, auth_epoch }.
   */
  server.post<{ Params: { id: string } }>(
    '/auth/league/:id',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parse = LeagueAuthRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
        });
      }

      const { role, team_id, password } = parse.data;
      const league_id = req.params.id;

      const [league] = await db
        .select()
        .from(leagues)
        .where(eq(leagues.id, league_id))
        .limit(1);

      if (!league) {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'League not found',
        });
      }

      if (role === 'COMMISSIONER') {
        const ok = await verify(password, league.commissioner_password_hash);
        if (!ok) {
          return reply.status(401).send({
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid commissioner password',
          });
        }

        const payload = {
          league_id,
          role: 'COMMISSIONER' as const,
          auth_epoch: league.auth_epoch,
        };

        const token = server.jwt.sign(payload, {
          expiresIn: JWT_EXPIRES_IN,
        });

        return reply.send({ token, expires_in: JWT_EXPIRES_IN });
      }

      // OWNER role — requires team_id
      if (!team_id) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'team_id required for OWNER role',
        });
      }

      const [team] = await db
        .select()
        .from(teams)
        .where(eq(teams.id, team_id))
        .limit(1);

      if (!team || team.league_id !== league_id) {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Team not found in this league',
        });
      }

      const ok = await verify(password, team.team_password_hash);
      if (!ok) {
        return reply.status(401).send({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid team password',
        });
      }

      const payload = {
        league_id,
        team_id,
        role: 'OWNER' as const,
        auth_epoch: team.auth_epoch,
      };

      const token = server.jwt.sign(payload, {
        expiresIn: JWT_EXPIRES_IN,
      });

      return reply.send({ token, expires_in: JWT_EXPIRES_IN });
    },
  );
}

/** Utility to hash a password — exported for use in seed.ts */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_WORK_FACTOR);
}
