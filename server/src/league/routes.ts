import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { hash } from '@node-rs/bcrypt';
import { randomBytes } from 'node:crypto';

import {
  leagues,
  teams,
  rosterConfigurations,
  rosterSlotDefinitions,
  auctionConfigurations,
  whammyConfigs,
  draftDatasets,
  playerAavSources,
  autoAgentConfigs,
  drafts,
} from '../../db/schema/index.js';
import {
  CreateLeagueRequestSchema,
  CreateTeamRequestSchema,
  RosterConfigRequestSchema,
  AuctionConfigRequestSchema,
  UpdateLeagueRequestSchema,
  UpdateTeamRequestSchema,
  GeneratePasswordsRequestSchema,
  WhammyConfigRequestSchema,
} from '@draft/shared-types';
import { requireCommissioner, requireLeagueMember } from './auth-hook.js';

const BCRYPT_WORK_FACTOR = 12;

/** Cryptographically random password: 16 hex chars from 8 random bytes. */
function generateRandomPassword(): string {
  return randomBytes(8).toString('hex');
}

function leagueSummaryColumns() {
  return {
    id: leagues.id,
    name: leagues.name,
    logo_url: leagues.logo_url,
    name_lock: leagues.name_lock,
    scheduled_draft_start_at: leagues.scheduled_draft_start_at,
    status_message: leagues.status_message,
  };
}

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
   * Any valid league member (COMMISSIONER or OWNER) — the owner-facing
   * Pre-Draft Lobby (MOD-014) reads status_message and
   * scheduled_draft_start_at from this endpoint, so it cannot be
   * commissioner-only (F-MOD-010).
   */
  server.get<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId',
    { preHandler: requireLeagueMember(server, db) },
    async (req, reply) => {
      const [league] = await db
        .select(leagueSummaryColumns())
        .from(leagues)
        .where(eq(leagues.id, req.params.leagueId))
        .limit(1);

      if (!league) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
      }
      return reply.send({
        ...league,
        scheduled_draft_start_at: league.scheduled_draft_start_at
          ? league.scheduled_draft_start_at.toISOString()
          : null,
      });
    },
  );

  /**
   * PUT /leagues/:leagueId
   * Commissioner JWT required. Updates league identity, name-lock,
   * scheduled draft start time, and status message (F-MOD-010).
   */
  server.put<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = UpdateLeagueRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const leagueId = req.params.leagueId;
      const patch: Partial<typeof leagues.$inferInsert> = {};
      if (parse.data.name !== undefined) patch.name = parse.data.name;
      if (parse.data.logo_url !== undefined) patch.logo_url = parse.data.logo_url;
      if (parse.data.name_lock !== undefined) patch.name_lock = parse.data.name_lock;
      if (parse.data.status_message !== undefined) patch.status_message = parse.data.status_message;
      if (parse.data.scheduled_draft_start_at !== undefined) {
        patch.scheduled_draft_start_at = parse.data.scheduled_draft_start_at
          ? new Date(parse.data.scheduled_draft_start_at)
          : null;
      }

      const [updated] = await db
        .update(leagues)
        .set(patch)
        .where(eq(leagues.id, leagueId))
        .returning(leagueSummaryColumns());

      if (!updated) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
      }

      return reply.send({
        ...updated,
        scheduled_draft_start_at: updated.scheduled_draft_start_at
          ? updated.scheduled_draft_start_at.toISOString()
          : null,
      });
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
          icon_url: teams.icon_url,
          nomination_audio_url: teams.nomination_audio_url,
          starting_budget_override_minor: teams.starting_budget_override_minor,
          name_lock: teams.name_lock,
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

      // Insert the commissioner's explicit slot definitions.
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

      // Auto-manage the bench slot definition. The auction engine's
      // assignRosterSlot (server/src/auction/engine.ts) needs an actual
      // roster_slot_definitions row (is_starter=false) to have somewhere to
      // assign an overflow/bench pick to — without one, a player bought
      // after every starter slot is full is still awarded and paid for, but
      // silently gets no roster_entries row at all (assignRosterSlot returns
      // null and the insert is skipped). The commissioner configures bench
      // capacity via the separate bench_slots count, not by adding their own
      // 'BN' row, so this endpoint materializes that row for them.
      if (bench_slots > 0) {
        await db.insert(rosterSlotDefinitions).values({
          config_id: configId,
          position: 'BN',
          priority: 9999,
          is_starter: false,
          slot_count: bench_slots,
        });
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

  /**
   * PUT /leagues/:leagueId/teams/:teamId
   * Commissioner JWT required. Updates a team's starting-budget override,
   * name-lock, and/or draft position (F-MOD-010). draft_order is the single
   * source of truth for MOD-002's nomination-turn rotation, not display-only.
   */
  server.put<{ Params: { leagueId: string; teamId: string } }>(
    '/leagues/:leagueId/teams/:teamId',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = UpdateTeamRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { leagueId, teamId } = req.params;

      const [existing] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.league_id, leagueId)))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this league' });
      }

      const patch: Partial<typeof teams.$inferInsert> = {};
      if (parse.data.starting_budget_override_minor !== undefined) {
        patch.starting_budget_override_minor = parse.data.starting_budget_override_minor;
      }
      if (parse.data.name_lock !== undefined) patch.name_lock = parse.data.name_lock;
      if (parse.data.draft_order !== undefined) patch.draft_order = parse.data.draft_order;

      const [updated] = await db
        .update(teams)
        .set(patch)
        .where(eq(teams.id, teamId))
        .returning({
          id: teams.id,
          name: teams.name,
          draft_order: teams.draft_order,
          starting_budget_override_minor: teams.starting_budget_override_minor,
          name_lock: teams.name_lock,
          icon_url: teams.icon_url,
          nomination_audio_url: teams.nomination_audio_url,
        });

      return reply.send(updated);
    },
  );

  /**
   * POST /leagues/:leagueId/passwords/generate
   * Commissioner JWT required. Generates (or sets, if custom_password is
   * supplied) the commissioner/host/team password, bumps the affected
   * scope's auth_epoch (constraint #12 — the only revocation mechanism),
   * and returns the plaintext exactly once (F-MOD-010).
   */
  server.post<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/passwords/generate',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = GeneratePasswordsRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { scope, team_id, custom_password } = parse.data;
      const leagueId = req.params.leagueId;
      const plaintext = custom_password ?? generateRandomPassword();
      const passwordHash = await hash(plaintext, BCRYPT_WORK_FACTOR);

      if (scope === 'TEAM') {
        if (!team_id) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'team_id required for scope=TEAM' });
        }
        const [team] = await db
          .select({ id: teams.id, auth_epoch: teams.auth_epoch })
          .from(teams)
          .where(and(eq(teams.id, team_id), eq(teams.league_id, leagueId)))
          .limit(1);
        if (!team) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this league' });
        }
        await db
          .update(teams)
          .set({ team_password_hash: passwordHash, auth_epoch: team.auth_epoch + 1 })
          .where(eq(teams.id, team_id));
        return reply.send({ scope, team_id, password: plaintext });
      }

      if (scope === 'COMMISSIONER') {
        const [league] = await db
          .select({ auth_epoch: leagues.auth_epoch })
          .from(leagues)
          .where(eq(leagues.id, leagueId))
          .limit(1);
        if (!league) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
        }
        await db
          .update(leagues)
          .set({ commissioner_password_hash: passwordHash, auth_epoch: league.auth_epoch + 1 })
          .where(eq(leagues.id, leagueId));
        return reply.send({ scope, team_id: null, password: plaintext });
      }

      // scope === 'HOST'
      const [league] = await db
        .select({ auth_epoch: leagues.auth_epoch })
        .from(leagues)
        .where(eq(leagues.id, leagueId))
        .limit(1);
      if (!league) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
      }
      await db
        .update(leagues)
        .set({ host_password_hash: passwordHash, auth_epoch: league.auth_epoch + 1 })
        .where(eq(leagues.id, leagueId));
      return reply.send({ scope, team_id: null, password: plaintext });
    },
  );

  /**
   * PUT /leagues/:leagueId/config/whammy
   * Commissioner JWT required. Upserts the league's single WhammyConfig row
   * — MOD-009 only ever read this table; this is its write path (F-MOD-010).
   */
  server.put<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/config/whammy',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = WhammyConfigRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const leagueId = req.params.leagueId;
      const {
        enabled,
        allow_positive = true,
        allow_negative = true,
        max_amount_minor = 0,
        max_per_team = null,
        max_per_draft = null,
        commissioner_approval_required = false,
        allowed_event_types = [],
      } = parse.data;

      const existing = await db
        .select({ id: whammyConfigs.id })
        .from(whammyConfigs)
        .where(eq(whammyConfigs.league_id, leagueId))
        .limit(1);

      const values = {
        league_id: leagueId,
        enabled,
        allow_positive,
        allow_negative,
        max_amount_minor: Math.trunc(max_amount_minor),
        max_per_team,
        max_per_draft,
        commissioner_approval_required,
        allowed_event_types,
      };

      if (existing.length > 0) {
        await db
          .update(whammyConfigs)
          .set(values)
          .where(eq(whammyConfigs.id, existing[0]!.id));
      } else {
        await db.insert(whammyConfigs).values(values);
      }

      return reply.status(200).send();
    },
  );

  /**
   * GET /leagues/:leagueId/readiness
   * Commissioner JWT required. One deterministic PASS/FAIL row per PRD §41
   * pre-draft readiness item this project models (F-MOD-010).
   */
  server.get<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/readiness',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const leagueId = req.params.leagueId;
      const items: Array<{ key: string; label: string; status: 'PASS' | 'FAIL'; detail: string | null }> = [];

      const teamList = await db
        .select({ id: teams.id, draft_order: teams.draft_order, icon_url: teams.icon_url })
        .from(teams)
        .where(eq(teams.league_id, leagueId));
      items.push({
        key: 'team_count',
        label: 'Team count',
        status: teamList.length === 12 ? 'PASS' : 'FAIL',
        detail: `${teamList.length} of 12 teams`,
      });

      const [rosterConfig] = await db
        .select({ id: rosterConfigurations.id, total_roster_size: rosterConfigurations.total_roster_size, bench_slots: rosterConfigurations.bench_slots })
        .from(rosterConfigurations)
        .where(eq(rosterConfigurations.league_id, leagueId))
        .limit(1);
      let rosterValid = false;
      if (rosterConfig) {
        // Bench is also a real roster_slot_definitions row (is_starter=false) —
        // the auction engine's assignRosterSlot (server/src/auction/engine.ts)
        // requires it to exist to have a roster_slot_id to assign bench picks
        // to. Sum only the starter rows here and add bench_slots once, rather
        // than double-counting the bench row's own slot_count on top of it.
        const slots = await db
          .select({ slot_count: rosterSlotDefinitions.slot_count, is_starter: rosterSlotDefinitions.is_starter })
          .from(rosterSlotDefinitions)
          .where(eq(rosterSlotDefinitions.config_id, rosterConfig.id));
        const starterSlots = slots.filter((s) => s.is_starter);
        const starterSum = starterSlots.reduce((acc, s) => acc + s.slot_count, 0);
        rosterValid = starterSlots.length > 0 && starterSum + rosterConfig.bench_slots === rosterConfig.total_roster_size;
      }
      items.push({
        key: 'roster_config',
        label: 'Roster configuration',
        status: rosterValid ? 'PASS' : 'FAIL',
        detail: rosterConfig ? null : 'No roster configuration set',
      });

      const [auctionConfig] = await db
        .select({ initial_budget_minor: auctionConfigurations.initial_budget_minor })
        .from(auctionConfigurations)
        .where(eq(auctionConfigurations.league_id, leagueId))
        .limit(1);
      const budgetFeasible = Boolean(
        auctionConfig && rosterConfig && auctionConfig.initial_budget_minor >= rosterConfig.total_roster_size * 100,
      );
      items.push({
        key: 'budget_feasible',
        label: 'Budget feasibility',
        status: budgetFeasible ? 'PASS' : 'FAIL',
        detail: auctionConfig ? null : 'No auction configuration set',
      });

      items.push({
        key: 'timer_config',
        label: 'Timer configuration',
        status: auctionConfig ? 'PASS' : 'FAIL',
        detail: auctionConfig ? null : 'Nomination/second-bid/rebid timers not configured',
      });

      const activeDatasets = await db
        .select({ id: draftDatasets.id, status: draftDatasets.status, version: draftDatasets.version, primary_aav_source: draftDatasets.primary_aav_source })
        .from(draftDatasets)
        .where(eq(draftDatasets.league_id, leagueId))
        .orderBy(draftDatasets.version);
      const latestDataset = activeDatasets[activeDatasets.length - 1] ?? null;

      items.push({
        key: 'dataset_frozen',
        label: 'Dataset frozen',
        status: latestDataset?.status === 'FROZEN' ? 'PASS' : 'FAIL',
        detail: latestDataset ? `Dataset status: ${latestDataset.status}` : 'No dataset created',
      });

      let unresolvedAmbiguous = true;
      let aavSourceSelected = false;
      if (latestDataset) {
        const sources = await db
          .selectDistinct({ source: playerAavSources.source })
          .from(playerAavSources)
          .where(eq(playerAavSources.dataset_id, latestDataset.id));
        unresolvedAmbiguous = sources.length === 0;
        aavSourceSelected = Boolean(latestDataset.primary_aav_source) || sources.length === 1;
      }
      items.push({
        key: 'dataset_no_ambiguous',
        label: 'No unresolved ambiguous players',
        status: latestDataset && !unresolvedAmbiguous ? 'PASS' : 'FAIL',
        detail: latestDataset ? null : 'No dataset created',
      });
      items.push({
        key: 'aav_source_selected',
        label: 'AAV source selected',
        status: aavSourceSelected ? 'PASS' : 'FAIL',
        detail: aavSourceSelected ? null : 'No Primary AAV source selected',
      });

      const draftRows = await db
        .select({ id: drafts.id })
        .from(drafts)
        .where(eq(drafts.league_id, leagueId));
      let autoAgentDefaultsSet = false;
      if (draftRows.length > 0 && teamList.length > 0) {
        const draftId = draftRows[draftRows.length - 1]!.id;
        const configs = await db
          .select({ team_id: autoAgentConfigs.team_id })
          .from(autoAgentConfigs)
          .where(eq(autoAgentConfigs.draft_id, draftId));
        autoAgentDefaultsSet = configs.length >= teamList.length;
      }
      items.push({
        key: 'auto_agent_defaults',
        label: 'Auto-Agent defaults',
        status: autoAgentDefaultsSet ? 'PASS' : 'FAIL',
        detail: autoAgentDefaultsSet ? null : 'Auto-Agent defaults not established for every team',
      });

      const allTeamsHaveMedia = teamList.length > 0 && teamList.every((t) => Boolean(t.icon_url));
      items.push({
        key: 'team_media',
        label: 'Team presentation media',
        status: allTeamsHaveMedia ? 'PASS' : 'FAIL',
        detail: allTeamsHaveMedia ? null : 'One or more teams have no icon set',
      });

      const [whammyConfig] = await db
        .select({ id: whammyConfigs.id, enabled: whammyConfigs.enabled })
        .from(whammyConfigs)
        .where(eq(whammyConfigs.league_id, leagueId))
        .limit(1);
      items.push({
        key: 'whammy_config',
        label: 'Whammy configuration',
        status: whammyConfig ? 'PASS' : 'FAIL',
        detail: whammyConfig ? null : 'Whammy not configured or intentionally disabled',
      });

      const all_ready = items.every((i) => i.status === 'PASS');
      return reply.send({ items, all_ready });
    },
  );
}
