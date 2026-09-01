/**
 * F-MOD-000: Database schema — all required entity tables exist after migration
 *
 * Behavioral expectation: given DATABASE_URL is set and npm run db:migrate
 * completes, then every entity table from the Drizzle schema exists in Postgres
 * and is selectable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ??
  'test-secret-for-vitest-at-least-32-chars-long!!';

// Tables required by behavioral expectation
const REQUIRED_TABLES = [
  'leagues',
  'teams',
  'memberships',
  'drafts',
  'player_auctions',
  'bid_attempts',
  'draft_events',
  'draft_team_states',
  'acquisitions',
  'roster_entries',
  'budget_ledger_entries',
  'roster_configurations',
  'roster_slot_definitions',
  'auction_configurations',
  'auto_agent_configs',
  'draft_datasets',
  'players',
  'whammy_configs',
];

describe('F-MOD-000 database schema', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await sql.end();
  });

  for (const table of REQUIRED_TABLES) {
    it(`test_F_MOD_000_table_${table}_exists_and_selectable`, async () => {
      // SELECT from the table — must not throw
      const result = await sql`
        SELECT COUNT(*) as count FROM ${sql(table)} LIMIT 0
      `;
      // If table doesn't exist, this will throw
      expect(result).toBeDefined();
    });
  }
});
