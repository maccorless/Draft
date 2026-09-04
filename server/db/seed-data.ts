/**
 * Reusable dev-seed logic: one test league, 12 teams, a FROZEN DraftDataset
 * with real 2026 player/AAV data, an AuctionConfiguration, and a CREATED draft
 * ready to start.
 *
 * Player data comes from data/players-2026.csv, generated from the real 2026
 * salary-cap cheatsheet in data/cheatsheet.csv — see scripts/build-players-csv.js.
 * Regenerate with: node scripts/build-players-csv.js (from repo root)
 *
 * Called by:
 *  - server/db/seed.ts (CLI: npm run db:seed)
 *  - server/src/dev/routes.ts (POST /dev/reseed, non-production only)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { hash } from '@node-rs/bcrypt';

import {
  leagues,
  teams,
  auctionConfigurations,
  rosterConfigurations,
  rosterSlotDefinitions,
  draftDatasets,
  players,
  playerAavSources,
  drafts,
} from './schema/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BCRYPT_WORK_FACTOR = 12;
const SITE_PASSWORD = 'draft2026!';
const COMMISSIONER_PASSWORD = 'commissioner2026!';
const TEAM_PASSWORD = 'team123!';

const TEAM_NAMES = [
  'Alpha Wolves', 'Beta Bears', 'Gamma Gorillas', 'Delta Dogs',
  'Epsilon Eagles', 'Zeta Zebras', 'Eta Hawks', 'Theta Tigers',
  'Iota Iguanas', 'Kappa Kings', 'Lambda Lions', 'Mu Mustangs',
];

export interface SeedResult {
  leagueId: string;
  draftId: string;
  datasetId: string;
  teamCount: number;
  playerCount: number;
  sitePassword: string;
  commissionerPassword: string;
  teamPassword: string;
}

interface CsvPlayerRow {
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  tier: number | null;
}

function loadPlayersCsv(): CsvPlayerRow[] {
  const csvPath = join(__dirname, '../../data/players-2026.csv');
  const lines = readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const header = lines[0]!.split(',');
  const idx = {
    name: header.indexOf('name'),
    position: header.indexOf('position'),
    nfl_team: header.indexOf('nfl_team'),
    aav_minor: header.indexOf('aav_minor'),
    tier: header.indexOf('tier'),
  };

  return lines.slice(1).map((line) => {
    const fields = line.split(',');
    return {
      name: fields[idx.name]!.trim(),
      position: fields[idx.position]!.trim(),
      nfl_team: fields[idx.nfl_team]!.trim(),
      aav_minor: parseInt(fields[idx.aav_minor]!.trim(), 10),
      tier: fields[idx.tier]?.trim() ? parseInt(fields[idx.tier]!.trim(), 10) : null,
    };
  });
}

export async function seedDevData(db: PostgresJsDatabase): Promise<SeedResult> {
  // ─── League ──────────────────────────────────────────────────────────────
  const [sitePasswordHash, commPasswordHash, teamPasswordHash] = await Promise.all([
    hash(SITE_PASSWORD, BCRYPT_WORK_FACTOR),
    hash(COMMISSIONER_PASSWORD, BCRYPT_WORK_FACTOR),
    hash(TEAM_PASSWORD, BCRYPT_WORK_FACTOR),
  ]);

  const [league] = await db
    .insert(leagues)
    .values({
      name: 'Test Fantasy League 2026',
      site_password_hash: sitePasswordHash,
      commissioner_password_hash: commPasswordHash,
      auth_epoch: 0,
    })
    .returning();

  // ─── Roster Configuration ────────────────────────────────────────────────
  const [rosterConfig] = await db
    .insert(rosterConfigurations)
    .values({
      league_id: league!.id,
      total_roster_size: 15,
      bench_slots: 6,
    })
    .returning();

  // Standard fantasy football roster: QB(1) + RB(2) + WR(2) + TE(1) + FLEX(1) + K(1) + DEF(1) + BN(6) = 15
  await db.insert(rosterSlotDefinitions).values([
    { config_id: rosterConfig!.id, position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
    { config_id: rosterConfig!.id, position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
    { config_id: rosterConfig!.id, position: 'WR', priority: 3, is_starter: true, slot_count: 2 },
    { config_id: rosterConfig!.id, position: 'TE', priority: 4, is_starter: true, slot_count: 1 },
    { config_id: rosterConfig!.id, position: 'FLEX', priority: 5, is_starter: true, slot_count: 1 },
    { config_id: rosterConfig!.id, position: 'K', priority: 6, is_starter: true, slot_count: 1 },
    { config_id: rosterConfig!.id, position: 'DEF', priority: 7, is_starter: true, slot_count: 1 },
    { config_id: rosterConfig!.id, position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
  ]);

  // ─── Auction Configuration ───────────────────────────────────────────────
  await db.insert(auctionConfigurations).values({
    league_id: league!.id,
    initial_budget_minor: 20000, // $200.00
    nomination_timer_ms: 90000,  // 90 seconds
    second_bid_timer_ms: 30000,  // 30 seconds
    rebid_timer_ms: 15000,        // 15 seconds
    anti_snipe_threshold_ms: 5000, // last 5 seconds
    anti_snipe_extension_ms: 10000, // extend by 10 seconds
    min_bid_minor: 100,            // $1.00
  });

  // ─── 12 Teams ─────────────────────────────────────────────────────────────
  const insertedTeams = await db
    .insert(teams)
    .values(
      TEAM_NAMES.map((name, i) => ({
        league_id: league!.id,
        name,
        team_password_hash: teamPasswordHash,
        auth_epoch: 0,
        draft_order: i + 1,
      })),
    )
    .returning();

  // ─── Players ──────────────────────────────────────────────────────────────
  // Loaded from data/players-2026.csv (generated from the real 2026 salary-cap
  // cheatsheet in data/cheatsheet.csv — see scripts/build-players-csv.js).
  const csvPlayers = loadPlayersCsv();

  const insertedPlayers = await db
    .insert(players)
    .values(csvPlayers.map((p) => ({ name: p.name, position: p.position, nfl_team: p.nfl_team })))
    .returning();

  // ─── DraftDataset (FROZEN) ────────────────────────────────────────────────
  const [dataset] = await db
    .insert(draftDatasets)
    .values({
      league_id: league!.id,
      status: 'FROZEN',
      frozen_at: new Date(),
      version: 1,
      primary_aav_source: 'CSV',
    })
    .returning();

  // insertedPlayers is returned in the same order as the VALUES list we inserted
  // (PostgreSQL preserves row order for a single multi-row INSERT ... RETURNING),
  // so it lines up positionally with csvPlayers for aav_minor/tier lookup.
  await db.insert(playerAavSources).values(
    insertedPlayers.map((p, i) => ({
      dataset_id: dataset!.id,
      player_id: p.id,
      aav_minor: csvPlayers[i]!.aav_minor,
      tier: csvPlayers[i]!.tier,
      source: 'CSV' as const,
    })),
  );

  // ─── Draft (CREATED) ──────────────────────────────────────────────────────
  const [draft] = await db
    .insert(drafts)
    .values({
      league_id: league!.id,
      dataset_id: dataset!.id,
      status: 'CREATED',
    })
    .returning();

  return {
    leagueId: league!.id,
    draftId: draft!.id,
    datasetId: dataset!.id,
    teamCount: insertedTeams.length,
    playerCount: insertedPlayers.length,
    sitePassword: SITE_PASSWORD,
    commissionerPassword: COMMISSIONER_PASSWORD,
    teamPassword: TEAM_PASSWORD,
  };
}
