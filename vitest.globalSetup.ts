/**
 * Global test setup — runs once before all test files.
 * Truncates the test database to prevent accumulated test data from
 * degrading performance (e.g. bcrypt O(n) in /auth/site).
 */
import postgres from 'postgres';

export async function setup() {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL || !DATABASE_URL.includes('draft_test')) {
    // Only truncate the designated test database — never prod or dev
    console.warn('[globalSetup] Skipping truncate: DATABASE_URL is not draft_test');
    return;
  }
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    // Truncate leagues with CASCADE — all dependent tables follow via FK cascades
    await sql`TRUNCATE TABLE leagues, draft_datasets RESTART IDENTITY CASCADE`;
  } catch (err) {
    // Some tables may not exist yet — that's fine, skip them
    console.warn('[globalSetup] Truncate warning (non-fatal):', (err as Error).message?.slice(0, 120));
  } finally {
    await sql.end();
  }
}
