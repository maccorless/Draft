/**
 * Dev-only helpers: truncate slices of the schema so seed-data.ts can
 * repopulate a clean database without wiping data that shouldn't reset on
 * every test run. Never used in production (see server/src/dev/routes.ts).
 *
 * Three layers (see server/db/seed-data.ts):
 *   1. Core league — leagues/teams/roster+auction config. Never wiped by
 *      these helpers; only `npm run db:seed`'s first run (or a manual
 *      wipeAllTables) creates it.
 *   2. Player/AAV master data (a FROZEN DraftDataset) — wiped by
 *      wipePlayerData, which also wipes layer 3 since drafts reference a
 *      dataset_id that's about to disappear.
 *   3. The draft instance itself (bids, rosters, ledger, ...) — wiped by
 *      wipeDraftInstance for a fast "reset the draft" test-data action.
 */
import type postgres from 'postgres';

// Every table that hangs off a specific drafts.id row.
const DRAFT_INSTANCE_TABLES = [
  'report_delivery_attempts',
  'reconciliation_items',
  'export_jobs',
  'owner_target_values',
  'do_not_draft_items',
  'nomination_queue_items',
  'watch_list_items',
  'nominator_matches',
  'auto_agent_configs',
  'budget_ledger_entries',
  'whammy_events',
  'roster_entries',
  'acquisitions',
  'draft_events',
  'bid_attempts',
  'player_auctions',
  'draft_team_states',
  'drafts',
];

// Player/AAV master data — depends on nothing in DRAFT_INSTANCE_TABLES, but
// draft_datasets/players are referenced BY it, so instance rows must go first.
const PLAYER_DATA_TABLES = ['player_aav_sources', 'draft_datasets', 'players'];

async function truncate(sql: postgres.Sql, tables: string[]): Promise<void> {
  const names = tables.map((t) => `"${t}"`).join(', ');
  await sql.unsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

export async function wipeAllTables(sql: postgres.Sql): Promise<void> {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  if (tables.length === 0) return;
  await truncate(sql, tables.map((t) => t.tablename));
}

/** Wipes only the draft instance (layer 3) — keeps league, teams, players, and the dataset. */
export async function wipeDraftInstance(sql: postgres.Sql): Promise<void> {
  await truncate(sql, DRAFT_INSTANCE_TABLES);
}

/** Wipes player/AAV master data and, transitively, the draft instance built on top of it. */
export async function wipePlayerData(sql: postgres.Sql): Promise<void> {
  await truncate(sql, DRAFT_INSTANCE_TABLES);
  await truncate(sql, PLAYER_DATA_TABLES);
}
