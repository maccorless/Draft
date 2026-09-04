/**
 * Dataset, player, and draft-creation routes (MOD-001 + MOD-007).
 *
 * POST   /leagues/:leagueId/datasets                              → create dataset
 * POST   /leagues/:leagueId/datasets/:datasetId/import/csv       → CSV import (worker_threads)
 * POST   /leagues/:leagueId/datasets/:datasetId/import/excel     → Excel import (worker_threads)
 * POST   /leagues/:leagueId/datasets/:datasetId/import/espn-pdf  → ESPN PDF import (worker_threads)
 * POST   /leagues/:leagueId/datasets/:datasetId/import/fantasypros → FantasyPros API import
 * POST   /leagues/:leagueId/datasets/:datasetId/freeze           → freeze dataset
 * POST   /leagues/:leagueId/drafts                               → create draft
 * GET    /leagues/:leagueId/players                              → list players for active dataset
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

import {
  draftDatasets,
  players,
  playerAavSources,
  drafts,
} from '../../db/schema/index.js';
import { CreateDraftRequestSchema } from '@draft/shared-types';
import { requireCommissioner } from '../league/auth-hook.js';
import { ExcelAdapter } from './adapters/excel.js';
import { EspnPdfAdapter } from './adapters/espn-pdf.js';
import { FantasyProsAdapter } from './adapters/fantasypros.js';
import type { AdapterResult, ImportSource } from './adapters/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled JS path (production)
const WORKER_PATH_JS = join(__dirname, 'csv-worker.js');
// TypeScript source path (dev/test under tsx)
const WORKER_PATH_TS = join(__dirname, 'csv-worker.ts');

interface ParsedRow {
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  projected_points: number | null;
  tier: number | null;
  espn_player_id: string | null;
  bye_week?: number | null;
  injury_status?: string | null;
  injury_detail?: string | null;
}

interface WorkerResult {
  rows: ParsedRow[];
  errors: Array<{ row: number; message: string }>;
}

/**
 * Parses CSV in a worker thread.
 * - In production (compiled): uses csv-worker.js directly.
 * - In dev/test (tsx): uses csv-worker.ts with tsx import hook.
 */
function parseCsvInWorker(csvContent: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const jsExists = existsSync(WORKER_PATH_JS);
    const workerScript = jsExists ? WORKER_PATH_JS : WORKER_PATH_TS;
    const worker = new Worker(workerScript, {
      workerData: { csvContent },
      // When using the .ts source (dev/test), pass tsx/esm so Node can transpile TypeScript
      execArgv: workerScript.endsWith('.ts') ? ['--import', 'tsx/esm'] : [],
    });
    worker.on('message', (result: WorkerResult) => resolve(result));
    worker.on('error', (err) => reject(err));
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`CSV worker exited with code ${code}`));
    });
  });
}

/**
 * Verify a dataset exists, belongs to the given league, and is not FROZEN.
 * Returns the dataset record on success, or sends an HTTP error and returns null.
 */
async function findDataset(
  db: PostgresJsDatabase,
  datasetId: string,
  leagueId: string,
  reply: import('fastify').FastifyReply,
): Promise<{ id: string; status: string } | null> {
  const [dataset] = await db
    .select({ id: draftDatasets.id, status: draftDatasets.status, league_id: draftDatasets.league_id })
    .from(draftDatasets)
    .where(eq(draftDatasets.id, datasetId))
    .limit(1);

  if (!dataset || dataset.league_id !== leagueId) {
    await reply.status(404).send({ code: 'NOT_FOUND', message: 'Dataset not found' });
    return null;
  }
  if (dataset.status === 'FROZEN') {
    await reply.status(409).send({ code: 'CONFLICT', message: 'Dataset is frozen; no further imports allowed' });
    return null;
  }
  return dataset;
}

/**
 * Applies whichever player-intelligence fields a row actually supplies onto
 * the shared players row (not per-source). Absent (undefined) fields are
 * left untouched — a later import from a different source must never clear
 * a previously-set value just because it doesn't carry that field.
 */
async function applyPlayerIntelligence(
  db: PostgresJsDatabase,
  playerId: string,
  row: ParsedRow,
): Promise<void> {
  const patch: Partial<typeof players.$inferInsert> = {};
  if (row.bye_week !== undefined) patch.bye_week = row.bye_week;
  if (row.injury_status !== undefined) patch.injury_status = row.injury_status;
  if (row.injury_detail !== undefined) patch.injury_detail = row.injury_detail;
  if (Object.keys(patch).length === 0) return;

  patch.injury_updated_at = new Date();
  await db.update(players).set(patch).where(eq(players.id, playerId));
}

/**
 * UPSERT a set of parsed rows into players + player_aav_sources.
 * Upsert key is (dataset_id, player_id, source) — one row per player per
 * source per dataset, so importing the same player from a second source
 * adds a new row rather than overwriting the first (F-MOD-016).
 * Returns { rowsImported, importErrors } after processing all rows.
 */
async function upsertRows(
  db: PostgresJsDatabase,
  datasetId: string,
  result: AdapterResult,
  source: ImportSource,
): Promise<{ rowsImported: number; importErrors: Array<{ row: number; message: string }> }> {
  let rowsImported = 0;
  const importErrors = [...result.errors];

  for (const row of result.rows) {
    try {
      let playerId: string;

      if (row.espn_player_id) {
        const [existing] = await db
          .select({ id: players.id })
          .from(players)
          .where(eq(players.espn_player_id, row.espn_player_id))
          .limit(1);

        if (existing) {
          await db.update(players)
            .set({ name: row.name, position: row.position, nfl_team: row.nfl_team })
            .where(eq(players.id, existing.id));
          playerId = existing.id;
        } else {
          const [p] = await db.insert(players)
            .values({ name: row.name, position: row.position, nfl_team: row.nfl_team, espn_player_id: row.espn_player_id })
            .returning({ id: players.id });
          playerId = p!.id;
        }
      } else {
        const existing = await db
          .select({ id: players.id })
          .from(players)
          .where(and(eq(players.name, row.name), eq(players.position, row.position)));

        if (existing.length === 1) {
          playerId = existing[0]!.id;
        } else if (existing.length > 1) {
          importErrors.push({ row: 0, message: `Ambiguous player match for '${row.name}' (${row.position})` });
          continue;
        } else {
          const [p] = await db.insert(players)
            .values({ name: row.name, position: row.position, nfl_team: row.nfl_team })
            .returning({ id: players.id });
          playerId = p!.id;
        }
      }

      await applyPlayerIntelligence(db, playerId, row);

      const existingEntry = await db
        .select({ id: playerAavSources.id })
        .from(playerAavSources)
        .where(and(
          eq(playerAavSources.dataset_id, datasetId),
          eq(playerAavSources.player_id, playerId),
          eq(playerAavSources.source, source),
        ))
        .limit(1);

      if (existingEntry.length === 0) {
        await db.insert(playerAavSources).values({
          dataset_id: datasetId,
          player_id: playerId,
          aav_minor: row.aav_minor,
          projected_points: row.projected_points !== null ? String(row.projected_points) : null,
          tier: row.tier,
          source,
        });
      } else {
        await db.update(playerAavSources)
          .set({ aav_minor: row.aav_minor, projected_points: row.projected_points !== null ? String(row.projected_points) : null, tier: row.tier })
          .where(eq(playerAavSources.id, existingEntry[0]!.id));
      }

      rowsImported++;
    } catch (rowErr) {
      importErrors.push({ row: 0, message: `Error processing '${row.name}': ${String(rowErr)}` });
    }
  }

  return { rowsImported, importErrors };
}

export async function registerPlayerRoutes(
  server: FastifyInstance,
  db: PostgresJsDatabase,
): Promise<void> {
  // Register multipart support for CSV upload
  await server.register(import('@fastify/multipart'), {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  });

  type DatasetParams = { leagueId: string; datasetId: string };
  type LeagueParams = { leagueId: string };

  /**
   * POST /leagues/:leagueId/datasets
   * Creates an empty DraftDataset (status=DRAFT, version=1).
   */
  server.post<{ Params: LeagueParams }>(
    '/leagues/:leagueId/datasets',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const [dataset] = await db
        .insert(draftDatasets)
        .values({ league_id: req.params.leagueId, status: 'DRAFT', version: 1 })
        .returning({
          id: draftDatasets.id,
          status: draftDatasets.status,
          version: draftDatasets.version,
          frozen_at: draftDatasets.frozen_at,
        });

      return reply.status(201).send(dataset);
    },
  );

  /**
   * POST /leagues/:leagueId/datasets/:datasetId/import/csv
   * Parses CSV in a worker thread; UPSERTs players and inserts PlayerDatasetEntry rows.
   */
  server.post<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/import/csv',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;

      // Verify dataset exists, belongs to this league, and is not FROZEN
      const [dataset] = await db
        .select({ id: draftDatasets.id, status: draftDatasets.status, league_id: draftDatasets.league_id })
        .from(draftDatasets)
        .where(eq(draftDatasets.id, datasetId))
        .limit(1);

      if (!dataset || dataset.league_id !== leagueId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Dataset not found' });
      }
      if (dataset.status === 'FROZEN') {
        return reply.status(409).send({ code: 'CONFLICT', message: 'Dataset is frozen; no further imports allowed' });
      }

      // Read multipart file
      // req.file() is added by @fastify/multipart; we cast to access it
      // @fastify/multipart's .file() throws (rather than resolving undefined) on a
      // malformed/empty multipart body — both cases mean "no file uploaded" here.
      let data: import('@fastify/multipart').MultipartFile | undefined;
      try {
        data = await (req as typeof req & { file: () => Promise<import('@fastify/multipart').MultipartFile | undefined> }).file();
      } catch {
        data = undefined;
      }
      if (!data) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'No file uploaded' });
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const csvContent = Buffer.concat(chunks).toString('utf-8');

      // Parse in worker thread — never on the main event loop
      let result: WorkerResult;
      try {
        result = await parseCsvInWorker(csvContent);
      } catch (err) {
        return reply.status(500).send({ code: 'WORKER_ERROR', message: `CSV parsing failed: ${String(err)}` });
      }

      if (result.rows.length === 0 && result.errors.length > 0) {
        return reply.send({ rows_imported: 0, source: 'CSV', errors: result.errors });
      }

      const { rowsImported, importErrors } = await upsertRows(db, datasetId, result, 'CSV');
      return reply.send({ rows_imported: rowsImported, source: 'CSV', errors: importErrors });
    },
  );

  /**
   * POST /leagues/:leagueId/datasets/:datasetId/import/excel
   * Parses an XLSX file in a worker thread; UPSERTs players into the dataset.
   */
  server.post<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/import/excel',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;
      const dataset = await findDataset(db, datasetId, leagueId, reply);
      if (!dataset) return;

      // @fastify/multipart's .file() throws (rather than resolving undefined) on a
      // malformed/empty multipart body — both cases mean "no file uploaded" here.
      let data: import('@fastify/multipart').MultipartFile | undefined;
      try {
        data = await (req as typeof req & { file: () => Promise<import('@fastify/multipart').MultipartFile | undefined> }).file();
      } catch {
        data = undefined;
      }
      if (!data) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'No file uploaded' });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const fileBuffer = Buffer.concat(chunks);

      let result: AdapterResult;
      try {
        result = await new ExcelAdapter().parse(fileBuffer);
      } catch (err) {
        return reply.status(500).send({ code: 'WORKER_ERROR', message: `Excel parsing failed: ${String(err)}` });
      }

      const { rowsImported, importErrors } = await upsertRows(db, datasetId, result, 'EXCEL');
      return reply.send({ rows_imported: rowsImported, source: 'EXCEL', errors: importErrors });
    },
  );

  /**
   * POST /leagues/:leagueId/datasets/:datasetId/import/espn-pdf
   * Parses an ESPN AAV PDF in a worker thread. Defensive — partial errors are
   * collected and returned in ImportResult; the HTTP response is always 200.
   */
  server.post<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/import/espn-pdf',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;
      const dataset = await findDataset(db, datasetId, leagueId, reply);
      if (!dataset) return;

      // @fastify/multipart's .file() throws (rather than resolving undefined) on a
      // malformed/empty multipart body — both cases mean "no file uploaded" here.
      let data: import('@fastify/multipart').MultipartFile | undefined;
      try {
        data = await (req as typeof req & { file: () => Promise<import('@fastify/multipart').MultipartFile | undefined> }).file();
      } catch {
        data = undefined;
      }
      if (!data) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'No file uploaded' });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const fileBuffer = Buffer.concat(chunks);

      // Worker errors are collected, never 500 — defensive parsing contract.
      let result: AdapterResult;
      try {
        result = await new EspnPdfAdapter().parse(fileBuffer);
      } catch (err) {
        // Even a worker crash returns 200 with error details, not 500.
        result = { rows: [], errors: [{ row: 0, message: `PDF parsing failed: ${String(err)}` }] };
      }

      const { rowsImported, importErrors } = await upsertRows(db, datasetId, result, 'ESPN_PDF');
      return reply.send({ rows_imported: rowsImported, source: 'ESPN_PDF', errors: importErrors });
    },
  );

  /**
   * POST /leagues/:leagueId/datasets/:datasetId/import/fantasypros
   * Fetches player projections from FantasyPros API (server-side).
   * Body: { scoring_format: "STD" | "HALF_PPR" | "PPR" }
   */
  server.post<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/import/fantasypros',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;
      const dataset = await findDataset(db, datasetId, leagueId, reply);
      if (!dataset) return;

      const body = req.body as Record<string, unknown>;
      const scoringFormat = body?.['scoring_format'];
      if (!scoringFormat || !['STD', 'HALF_PPR', 'PPR'].includes(String(scoringFormat).toUpperCase())) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'scoring_format must be STD, HALF_PPR, or PPR' });
      }

      let result: AdapterResult;
      try {
        result = await new FantasyProsAdapter().parse({ scoring_format: String(scoringFormat) });
      } catch (err) {
        // Non-2xx from FantasyPros or network error → typed ErrorResponse, no silent fallback.
        return reply.status(502).send({ code: 'FANTASYPROS_ERROR', message: String(err) });
      }

      const { rowsImported, importErrors } = await upsertRows(db, datasetId, result, 'FANTASYPROS');
      return reply.send({ rows_imported: rowsImported, source: 'FANTASYPROS', errors: importErrors });
    },
  );

  /**
   * POST /leagues/:leagueId/datasets/:datasetId/freeze
   * Sets status=FROZEN and records frozen_at.
   */
  server.post<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/freeze',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;

      const [dataset] = await db
        .select({ id: draftDatasets.id, status: draftDatasets.status, league_id: draftDatasets.league_id, version: draftDatasets.version })
        .from(draftDatasets)
        .where(eq(draftDatasets.id, datasetId))
        .limit(1);

      if (!dataset || dataset.league_id !== leagueId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Dataset not found' });
      }

      // Check there's at least one entry
      const entries = await db
        .select({ id: playerAavSources.id })
        .from(playerAavSources)
        .where(eq(playerAavSources.dataset_id, datasetId))
        .limit(1);

      if (entries.length === 0) {
        return reply.status(422).send({ code: 'UNPROCESSABLE', message: 'Cannot freeze an empty dataset' });
      }

      const now = new Date();
      const [updated] = await db
        .update(draftDatasets)
        .set({ status: 'FROZEN', frozen_at: now })
        .where(eq(draftDatasets.id, datasetId))
        .returning({
          id: draftDatasets.id,
          status: draftDatasets.status,
          version: draftDatasets.version,
          frozen_at: draftDatasets.frozen_at,
        });

      return reply.send(updated);
    },
  );

  /**
   * POST /leagues/:leagueId/drafts
   * Creates a Draft referencing a FROZEN dataset.
   * Rejects with 422 if dataset is not FROZEN.
   */
  server.post<{ Params: LeagueParams }>(
    '/leagues/:leagueId/drafts',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const parse = CreateDraftRequestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { dataset_id } = parse.data;
      const leagueId = req.params.leagueId;

      const [dataset] = await db
        .select({ id: draftDatasets.id, status: draftDatasets.status, league_id: draftDatasets.league_id })
        .from(draftDatasets)
        .where(eq(draftDatasets.id, dataset_id))
        .limit(1);

      if (!dataset || dataset.league_id !== leagueId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Dataset not found in this league' });
      }

      if (dataset.status !== 'FROZEN') {
        return reply.status(422).send({
          code: 'DATASET_NOT_FROZEN',
          message: `Dataset status is '${dataset.status}'; must be FROZEN before creating a draft`,
        });
      }

      const [draft] = await db
        .insert(drafts)
        .values({ league_id: leagueId, dataset_id, status: 'CREATED' })
        .returning({
          id: drafts.id,
          league_id: drafts.league_id,
          status: drafts.status,
          dataset_id: drafts.dataset_id,
        });

      return reply.status(201).send(draft);
    },
  );

  /**
   * GET /leagues/:leagueId/players
   * Returns players in the league's active (FROZEN) dataset, with AAV
   * resolved across every loaded source (F-MOD-016). aav_minor/primary_aav_minor
   * are always integers (or null when the player has no row for that source).
   *
   * dataset_entry_id is set equal to player_id: player_aav_sources now holds
   * one row per (player, source) rather than one row per player, so its id is
   * no longer a stable per-player identifier. Every downstream call the
   * frontend makes with this value (nominate, watchlist, queue, target-value)
   * only needs it to uniquely identify a player, which player_id already does.
   */
  server.get<{ Params: LeagueParams }>(
    '/leagues/:leagueId/players',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const leagueId = req.params.leagueId;

      // Find the most recent FROZEN dataset for this league
      const activeDatasets = await db
        .select({ id: draftDatasets.id })
        .from(draftDatasets)
        .where(and(eq(draftDatasets.league_id, leagueId), eq(draftDatasets.status, 'FROZEN')))
        .orderBy(draftDatasets.version);

      if (activeDatasets.length === 0) {
        return reply.send({ players: [] });
      }

      const datasetId = activeDatasets[activeDatasets.length - 1]!.id;
      const [datasetRow] = await db
        .select({
          primary_aav_source: draftDatasets.primary_aav_source,
          secondary_aav_source: draftDatasets.secondary_aav_source,
        })
        .from(draftDatasets)
        .where(eq(draftDatasets.id, datasetId))
        .limit(1);

      const secondarySource = datasetRow?.secondary_aav_source ?? null;

      const rows = await db
        .select({
          player_id: players.id,
          name: players.name,
          position: players.position,
          nfl_team: players.nfl_team,
          bye_week: players.bye_week,
          injury_status: players.injury_status,
          injury_detail: players.injury_detail,
          injury_updated_at: players.injury_updated_at,
          prior_season_stats: players.prior_season_stats,
          source: playerAavSources.source,
          aav_minor: playerAavSources.aav_minor,
          tier: playerAavSources.tier,
          projected_points: playerAavSources.projected_points,
        })
        .from(playerAavSources)
        .innerJoin(players, eq(playerAavSources.player_id, players.id))
        .where(eq(playerAavSources.dataset_id, datasetId))
        .orderBy(players.name);

      // Effective primary: the commissioner's selection, or — until one is
      // made — the sole source loaded so far (matches resolveEffectivePrimarySource
      // in aav-resolution.ts, duplicated here since this route only has a
      // drizzle handle, not the raw postgres.Sql that helper takes).
      const distinctSources = new Set(rows.map((r) => r.source));
      const effectivePrimarySource =
        datasetRow?.primary_aav_source ?? (distinctSources.size === 1 ? [...distinctSources][0]! : null);

      interface PlayerAggregate {
        player_id: string;
        name: string;
        position: string;
        nfl_team: string;
        bye_week: number | null;
        injury_status: string | null;
        injury_detail: string | null;
        injury_updated_at: Date | null;
        prior_season_stats: unknown;
        aav_sources: Array<{ source: string; aav_minor: number; tier: number | null; projected_points: number | null }>;
      }

      const byPlayer = new Map<string, PlayerAggregate>();
      for (const row of rows) {
        let agg = byPlayer.get(row.player_id);
        if (!agg) {
          agg = {
            player_id: row.player_id,
            name: row.name,
            position: row.position,
            nfl_team: row.nfl_team,
            bye_week: row.bye_week,
            injury_status: row.injury_status,
            injury_detail: row.injury_detail,
            injury_updated_at: row.injury_updated_at,
            prior_season_stats: row.prior_season_stats,
            aav_sources: [],
          };
          byPlayer.set(row.player_id, agg);
        }
        agg.aav_sources.push({
          source: row.source,
          aav_minor: Math.trunc(Number(row.aav_minor)),
          tier: row.tier,
          projected_points: row.projected_points !== null ? parseFloat(String(row.projected_points)) : null,
        });
      }

      const playerList = Array.from(byPlayer.values()).map((p) => {
        const primaryEntry = effectivePrimarySource
          ? p.aav_sources.find((s) => s.source === effectivePrimarySource) ?? null
          : null;
        const secondaryEntry = secondarySource
          ? p.aav_sources.find((s) => s.source === secondarySource) ?? null
          : null;

        return {
          player_id: p.player_id,
          dataset_entry_id: p.player_id,
          name: p.name,
          position: p.position,
          nfl_team: p.nfl_team,
          aav_minor: primaryEntry?.aav_minor ?? 0,
          projected_points: primaryEntry?.projected_points ?? null,
          tier: primaryEntry?.tier ?? null,
          primary_aav_minor: primaryEntry?.aav_minor ?? null,
          secondary_aav_minor: secondaryEntry?.aav_minor ?? null,
          aav_sources: p.aav_sources,
          bye_week: p.bye_week,
          injury_status: p.injury_status,
          injury_detail: p.injury_detail,
          injury_updated_at: p.injury_updated_at ? p.injury_updated_at.toISOString() : null,
          prior_season_stats: p.prior_season_stats,
        };
      });

      return reply.send({ players: playerList });
    },
  );

  /**
   * PUT /leagues/:leagueId/datasets/:datasetId/aav-sources
   * Commissioner-only. Sets the dataset's Primary/Secondary AAV source,
   * validated against the source values actually loaded for that dataset.
   */
  const SetAavSourcesBody = z.object({
    primary_aav_source: z.string().min(1),
    secondary_aav_source: z.string().min(1).nullable().optional(),
  });

  server.put<{ Params: DatasetParams }>(
    '/leagues/:leagueId/datasets/:datasetId/aav-sources',
    { preHandler: requireCommissioner(server, db) },
    async (req, reply) => {
      const { leagueId, datasetId } = req.params;

      const [dataset] = await db
        .select({ id: draftDatasets.id, league_id: draftDatasets.league_id })
        .from(draftDatasets)
        .where(eq(draftDatasets.id, datasetId))
        .limit(1);
      if (!dataset || dataset.league_id !== leagueId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Dataset not found' });
      }

      const parsed = SetAavSourcesBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: parsed.error.message });
      }
      const { primary_aav_source, secondary_aav_source } = parsed.data;

      const loadedSources = await db
        .selectDistinct({ source: playerAavSources.source })
        .from(playerAavSources)
        .where(eq(playerAavSources.dataset_id, datasetId));
      const loaded = new Set(loadedSources.map((s) => s.source));

      if (!loaded.has(primary_aav_source)) {
        return reply.status(400).send({
          code: 'SOURCE_NOT_LOADED',
          message: `Source '${primary_aav_source}' has no player_aav_sources rows in this dataset`,
        });
      }
      if (secondary_aav_source && !loaded.has(secondary_aav_source)) {
        return reply.status(400).send({
          code: 'SOURCE_NOT_LOADED',
          message: `Source '${secondary_aav_source}' has no player_aav_sources rows in this dataset`,
        });
      }

      await db
        .update(draftDatasets)
        .set({
          primary_aav_source,
          secondary_aav_source: secondary_aav_source ?? null,
        })
        .where(eq(draftDatasets.id, datasetId));

      return reply.send({
        primary_aav_source,
        secondary_aav_source: secondary_aav_source ?? null,
      });
    },
  );
}
