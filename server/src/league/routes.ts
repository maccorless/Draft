import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/bcrypt';

import {
  leagues,
  teams,
  rosterConfigurations,
  rosterSlotDefinitions,
  auctionConfigurations,
} from '../../db/schema/index.js';
import {
  CreateLeagueRequestSchema,
  CreateTeamRequestSchema,
  RosterConfigRequestSchema,
  AuctionConfigRequestSchema,
} from '@draft/shared-types';
import { requireCommissioner } from './auth-hook.js';

const BCRYPT_WORK_FACTOR = 12;

export async function registerLeagueRoutes(
  server: FastifyInstance,
  db: PostgresJsDatabase,
): Promise<void> {
  /**
   * POST /leagues
   * Public — no auth required. Creates a league and hashes both passwords.
   * auth_epoch starts at 1 (not 0) per spec.
   */
  server.post('/leagues', async (req, reply) => {
    const parse = CreateLeagueRequestSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
    }
    const { name, site_password, commissioner_password } = parse.data;

    const [siteHash, commHash] = await Promise.all([
      hash(site_password, BCRYPT_WORK_FACTOR),
      hash(commissioner_password, BCRYPT_WORK_FACTOR),
    ]);

    const [league] = await db
      .insert(leagues)
      .values({
        name,
        site_password_hash: siteHash,
        commissioner_password_hash: commHash,
        auth_epoch: 1,
      })
      .returning({ id: leagues.id, name: leagues.name });

    return reply.status(201).send(league);
  });

  /**
   * GET /leagues/:leagueId
   * Commissioner JWT required.
   */
  server.get<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const [league] = await db
        .select({ id: leagues.id, name: leagues.name })
        .from(leagues)
        .where(eq(leagues.id, req.params.leagueId))
        .limit(1);

      if (!league) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
      }
      return reply.send(league);
    },
  );

  /**
   * POST /leagues/:leagueId/teams
   * Commissioner JWT required.
   */
  server.post<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/teams',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = CreateTeamRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { name, team_password, draft_order } = parse.data;
      const leagueId = req.params.leagueId;

      // Verify league exists (preHandler already validates token scope)
      const [league] = await db
        .select({ id: leagues.id })
        .from(leagues)
        .where(eq(leagues.id, leagueId))
        .limit(1);

      if (!league) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
      }

      const teamHash = await hash(team_password, BCRYPT_WORK_FACTOR);

      const [team] = await db
        .insert(teams)
        .values({
          league_id: leagueId,
          name,
          team_password_hash: teamHash,
          draft_order,
        })
        .returning({ id: teams.id, name: teams.name, draft_order: teams.draft_order });

      return reply.status(201).send(team);
    },
  );

  /**
   * GET /leagues/:leagueId/teams
   * Any valid JWT for this league.
   */
  server.get<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/teams',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const teamList = await db
        .select({
          id: teams.id,
          name: teams.name,
          draft_order: teams.draft_order,
        })
        .from(teams)
        .where(eq(teams.league_id, req.params.leagueId))
        .orderBy(teams.draft_order);

      return reply.send({ teams: teamList });
    },
  );

  /**
   * PUT /leagues/:leagueId/config/roster
   * Commissioner JWT required.
   * Validates: total_roster_size = sum(slot_count) + bench_slots
   */
  server.put<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/config/roster',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = RosterConfigRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { bench_slots, slots } = parse.data;
      const leagueId = req.params.leagueId;

      const total_roster_size =
        slots.reduce((sum, s) => sum + s.slot_count, 0) + bench_slots;

      // Upsert: delete existing slot definitions, then upsert config
      const existing = await db
        .select({ id: rosterConfigurations.id })
        .from(rosterConfigurations)
        .where(eq(rosterConfigurations.league_id, leagueId))
        .limit(1);

      let configId: string;

      if (existing.length > 0) {
        configId = existing[0]!.id;
        // Delete old slot definitions
        await db
          .delete(rosterSlotDefinitions)
          .where(eq(rosterSlotDefinitions.config_id, configId));
        // Update config
        await db
          .update(rosterConfigurations)
          .set({ total_roster_size, bench_slots })
          .where(eq(rosterConfigurations.id, configId));
      } else {
        const [cfg] = await db
          .insert(rosterConfigurations)
          .values({ league_id: leagueId, total_roster_size, bench_slots })
          .returning({ id: rosterConfigurations.id });
        configId = cfg!.id;
      }

      // Insert new slot definitions
      if (slots.length > 0) {
        await db.insert(rosterSlotDefinitions).values(
          slots.map((s) => ({
            config_id: configId,
            position: s.position,
            priority: s.priority,
            is_starter: s.is_starter,
            slot_count: s.slot_count,
          })),
        );
      }

      return reply.status(200).send();
    },
  );

  /**
   * PUT /leagues/:leagueId/config/auction
   * Commissioner JWT required. All values stored as integers.
   */
  server.put<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/config/auction',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = AuctionConfigRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const {
        initial_budget_minor,
        nomination_timer_ms,
        second_bid_timer_ms,
        rebid_timer_ms,
        anti_snipe_threshold_ms = 0,
        anti_snipe_extension_ms = 0,
        min_bid_minor = 100,
      } = parse.data;
      const leagueId = req.params.leagueId;

      const existing = await db
        .select({ id: auctionConfigurations.id })
        .from(auctionConfigurations)
        .where(eq(auctionConfigurations.league_id, leagueId))
        .limit(1);

      const values = {
        league_id: leagueId,
        initial_budget_minor: Math.trunc(initial_budget_minor),
        nomination_timer_ms: Math.trunc(nomination_timer_ms),
        second_bid_timer_ms: Math.trunc(second_bid_timer_ms),
        rebid_timer_ms: Math.trunc(rebid_timer_ms),
        anti_snipe_threshold_ms: Math.trunc(anti_snipe_threshold_ms),
        anti_snipe_extension_ms: Math.trunc(anti_snipe_extension_ms),
        min_bid_minor: Math.trunc(min_bid_minor),
      };

      if (existing.length > 0) {
        await db
          .update(auctionConfigurations)
          .set(values)
          .where(eq(auctionConfigurations.id, existing[0]!.id));
      } else {
        await db.insert(auctionConfigurations).values(values);
      }

      return reply.status(200).send();
    },
  );
}
