/**
 * Dev-only helper: truncates every application table so seed-data.ts can
 * repopulate a clean database. Never used in production (see server/src/dev/routes.ts).
 */
import type postgres from 'postgres';

export async function wipeAllTables(sql: postgres.Sql): Promise<void> {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  if (tables.length === 0) return;

  const names = tables.map((t) => `"${t.tablename}"`).join(', ');
  await sql.unsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}
