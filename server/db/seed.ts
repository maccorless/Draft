/**
 * Development seed — populates a local DB with one test league, 12 teams,
 * a FROZEN DraftDataset with Player rows, and an AuctionConfiguration.
 *
 * Run with: npm run db:seed (from server/ directory)
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { hash } from '@node-rs/bcrypt';

import {
  leagues,
  teams,
  auctionConfigurations,
  rosterConfigurations,
  rosterSlotDefinitions,
  draftDatasets,
  players,
  playerDatasetEntries,
} from './schema/index.js';

const BCRYPT_WORK_FACTOR = 12;
const SITE_PASSWORD = 'draft2026!';
const COMMISSIONER_PASSWORD = 'commissioner2026!';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('ERR_CDR_78_EX_CONFIG: DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

console.log('Seeding database...');

// ─── League ──────────────────────────────────────────────────────────────────

const sitePasswordHash = await hash(SITE_PASSWORD, BCRYPT_WORK_FACTOR);
const commPasswordHash = await hash(COMMISSIONER_PASSWORD, BCRYPT_WORK_FACTOR);

const [league] = await db
  .insert(leagues)
  .values({
    name: 'Test Fantasy League 2026',
    site_password_hash: sitePasswordHash,
    commissioner_password_hash: commPasswordHash,
    auth_epoch: 0,
  })
  .returning();

console.log(`Created league: ${league.id}`);

// ─── Roster Configuration ─────────────────────────────────────────────────────

const [rosterConfig] = await db
  .insert(rosterConfigurations)
  .values({
    league_id: league.id,
    total_roster_size: 16,
    bench_slots: 6,
  })
  .returning();

// Standard fantasy football roster: QB(1), RB(2), WR(2), TE(1), FLEX(1), K(1), DEF(1), BN(6) = 15... add DST
await db.insert(rosterSlotDefinitions).values([
  { config_id: rosterConfig.id, position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
  { config_id: rosterConfig.id, position: 'RB', priority: 2, is_starter: true, slot_count: 2 },
  { config_id: rosterConfig.id, position: 'WR', priority: 3, is_starter: true, slot_count: 2 },
  { config_id: rosterConfig.id, position: 'TE', priority: 4, is_starter: true, slot_count: 1 },
  { config_id: rosterConfig.id, position: 'FLEX', priority: 5, is_starter: true, slot_count: 1 },
  { config_id: rosterConfig.id, position: 'K', priority: 6, is_starter: true, slot_count: 1 },
  { config_id: rosterConfig.id, position: 'DEF', priority: 7, is_starter: true, slot_count: 1 },
  { config_id: rosterConfig.id, position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
]);

// ─── Auction Configuration ───────────────────────────────────────────────────

await db.insert(auctionConfigurations).values({
  league_id: league.id,
  initial_budget_minor: 20000, // $200.00
  nomination_timer_ms: 90000,  // 90 seconds
  second_bid_timer_ms: 30000,  // 30 seconds
  rebid_timer_ms: 15000,        // 15 seconds
  anti_snipe_threshold_ms: 5000, // last 5 seconds
  anti_snipe_extension_ms: 10000, // extend by 10 seconds
  min_bid_minor: 100,            // $1.00
});

// ─── 12 Teams ────────────────────────────────────────────────────────────────

const TEAM_NAMES = [
  'Alpha Wolves', 'Beta Bears', 'Gamma Gorillas', 'Delta Dogs',
  'Epsilon Eagles', 'Zeta Zebras', 'Eta Hawks', 'Theta Tigers',
  'Iota Iguanas', 'Kappa Kings', 'Lambda Lions', 'Mu Mustangs',
];

const TEAM_PASSWORD = 'team123!';
const teamPasswordHash = await hash(TEAM_PASSWORD, BCRYPT_WORK_FACTOR);

const insertedTeams = await db
  .insert(teams)
  .values(
    TEAM_NAMES.map((name, i) => ({
      league_id: league.id,
      name,
      team_password_hash: teamPasswordHash,
      auth_epoch: 0,
      draft_order: i + 1,
    })),
  )
  .returning();

console.log(`Created ${insertedTeams.length} teams`);

// ─── Players ─────────────────────────────────────────────────────────────────

const SAMPLE_PLAYERS = [
  { name: 'Patrick Mahomes', position: 'QB', nfl_team: 'KC', espn_player_id: '3139477' },
  { name: 'Josh Allen', position: 'QB', nfl_team: 'BUF', espn_player_id: '3918298' },
  { name: 'Christian McCaffrey', position: 'RB', nfl_team: 'SF', espn_player_id: '3054211' },
  { name: 'CeeDee Lamb', position: 'WR', nfl_team: 'DAL', espn_player_id: '4362628' },
  { name: 'Tyreek Hill', position: 'WR', nfl_team: 'MIA', espn_player_id: '3054277' },
  { name: 'Travis Kelce', position: 'TE', nfl_team: 'KC', espn_player_id: '15847' },
  { name: 'Ja\'Marr Chase', position: 'WR', nfl_team: 'CIN', espn_player_id: '4362915' },
  { name: 'Austin Ekeler', position: 'RB', nfl_team: 'LAR', espn_player_id: '3054030' },
  { name: 'Davante Adams', position: 'WR', nfl_team: 'NYJ', espn_player_id: '16922' },
  { name: 'Sam LaPorta', position: 'TE', nfl_team: 'DET', espn_player_id: '4430026' },
  { name: 'Justin Jefferson', position: 'WR', nfl_team: 'MIN', espn_player_id: '4262921' },
  { name: 'Bijan Robinson', position: 'RB', nfl_team: 'ATL', espn_player_id: '4710345' },
  { name: 'Lamar Jackson', position: 'QB', nfl_team: 'BAL', espn_player_id: '3916387' },
  { name: 'Stefon Diggs', position: 'WR', nfl_team: 'HOU', espn_player_id: '2576434' },
  { name: 'Tony Pollard', position: 'RB', nfl_team: 'TEN', espn_player_id: '3929630' },
  { name: 'Mark Andrews', position: 'TE', nfl_team: 'BAL', espn_player_id: '3899779' },
  { name: 'Harrison Butker', position: 'K', nfl_team: 'KC', espn_player_id: '3054055' },
  { name: 'Evan McPherson', position: 'K', nfl_team: 'CIN', espn_player_id: '4035507' },
  { name: 'San Francisco 49ers', position: 'DEF', nfl_team: 'SF', espn_player_id: null },
  { name: 'Dallas Cowboys', position: 'DEF', nfl_team: 'DAL', espn_player_id: null },
];

const insertedPlayers = await db
  .insert(players)
  .values(SAMPLE_PLAYERS.map((p) => ({ ...p, espn_player_id: p.espn_player_id ?? undefined })))
  .returning();

// ─── DraftDataset (FROZEN) ───────────────────────────────────────────────────

const [dataset] = await db
  .insert(draftDatasets)
  .values({
    league_id: league.id,
    status: 'FROZEN',
    frozen_at: new Date(),
    version: 1,
  })
  .returning();

// AAV values in minor units ($1 = 100)
const AAV_BY_PLAYER: Record<string, number> = {
  'Patrick Mahomes': 4500,
  'Josh Allen': 4200,
  'Christian McCaffrey': 7000,
  'CeeDee Lamb': 6500,
  'Tyreek Hill': 5500,
  'Travis Kelce': 4000,
  "Ja'Marr Chase": 5800,
  'Austin Ekeler': 2200,
  'Davante Adams': 3200,
  'Sam LaPorta': 1800,
  'Justin Jefferson': 6000,
  'Bijan Robinson': 5200,
  'Lamar Jackson': 3800,
  'Stefon Diggs': 2800,
  'Tony Pollard': 2500,
  'Mark Andrews': 2600,
  'Harrison Butker': 500,
  'Evan McPherson': 450,
  'San Francisco 49ers': 800,
  'Dallas Cowboys': 600,
};

await db.insert(playerDatasetEntries).values(
  insertedPlayers.map((p) => ({
    dataset_id: dataset.id,
    player_id: p.id,
    aav_minor: AAV_BY_PLAYER[p.name] ?? 100,
    tier: Math.ceil(Math.random() * 5),
    source: 'CSV' as const,
  })),
);

console.log(`Created dataset ${dataset.id} with ${insertedPlayers.length} players`);
console.log('\nSeed complete!');
console.log(`  Site password:         ${SITE_PASSWORD}`);
console.log(`  Commissioner password: ${COMMISSIONER_PASSWORD}`);
console.log(`  Team password:         ${TEAM_PASSWORD} (same for all teams)`);

await sql.end();
