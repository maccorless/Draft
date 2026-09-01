/**
 * Migration runner — applies all pending Drizzle migrations.
 * Run with: npm run db:migrate (from server/ directory)
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('ERR_CDR_78_EX_CONFIG: DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

console.log('Running migrations...');
await migrate(db, {
  migrationsFolder: path.join(__dirname, '../drizzle'),
});
console.log('Migrations complete');

await sql.end();
