/**
 * Dev-only tooling — registered by main.ts only when NODE_ENV !== 'production'.
 * No auth on any of these: they must work even when the caller's session
 * belongs to data one of these calls is about to erase.
 *
 * POST /dev/reseed — wipes every table and reseeds one test league (see
 * server/db/seed-data.ts). Backs "Reload Test Data" (the nuclear option).
 *
 * POST /dev/reset-draft — wipes only the draft instance (bids, rosters,
 * ledger, ...) and creates a fresh CREATED draft against the existing
 * dataset. Leaves league/teams/players untouched. Backs "Reset Draft".
 *
 * POST /dev/reload-players — wipes the draft instance AND the player/AAV
 * dataset, then reloads both from data/players-2026.csv. Leaves
 * league/teams untouched. Backs "Reload Player Data".
 */
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

import { wipeAllTables, wipeDraftInstance, wipePlayerData } from '../../db/wipe.js';
import { seedDevData, seedPlayerDataset, seedFreshDraft } from '../../db/seed-data.js';
import { leagues, teams, draftDatasets } from '../../db/schema/index.js';
import { desc, eq } from 'drizzle-orm';

// Dev tooling assumes exactly one league exists locally (per CLAUDE.md's
// single-test-league dev setup) — these scoped resets don't need a league_id
// from the caller, they just look up the one league that's there.
async function currentLeagueId(db: PostgresJsDatabase): Promise<string> {
  const [league] = await db.select({ id: leagues.id }).from(leagues).limit(1);
  if (!league) throw new Error('No league found — run npm run db:seed first');
  return league.id;
}

export async function registerDevRoutes(
  server: FastifyInstance,
  db: PostgresJsDatabase,
  sql: postgres.Sql,
): Promise<void> {
  server.post('/dev/reseed', { config: { rateLimit: false } }, async (_req, reply) => {
    await wipeAllTables(sql);
    const result = await seedDevData(db);
    return reply.send(result);
  });

  server.post('/dev/reset-draft', { config: { rateLimit: false } }, async (_req, reply) => {
    const leagueId = await currentLeagueId(db);
    const [dataset] = await db
      .select({ id: draftDatasets.id })
      .from(draftDatasets)
      .where(eq(draftDatasets.league_id, leagueId))
      .orderBy(desc(draftDatasets.version))
      .limit(1);
    if (!dataset) {
      return reply.code(409).send({ error: 'No player dataset found — reload player data first' });
    }
    const teamRows = await db.select({ id: teams.id }).from(teams).where(eq(teams.league_id, leagueId));

    await wipeDraftInstance(sql);
    const draft = await seedFreshDraft(db, leagueId, dataset.id, teamRows.map((t) => t.id));
    return reply.send({ leagueId, draftId: draft.draftId });
  });

  server.post('/dev/reload-players', { config: { rateLimit: false } }, async (_req, reply) => {
    const leagueId = await currentLeagueId(db);
    const teamRows = await db.select({ id: teams.id }).from(teams).where(eq(teams.league_id, leagueId));

    await wipePlayerData(sql);
    const dataset = await seedPlayerDataset(db, leagueId);
    const draft = await seedFreshDraft(db, leagueId, dataset.datasetId, teamRows.map((t) => t.id));
    return reply.send({
      leagueId,
      draftId: draft.draftId,
      datasetId: dataset.datasetId,
      playerCount: dataset.playerCount,
    });
  });
}
