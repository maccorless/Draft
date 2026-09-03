/**
 * Development seed CLI — see seed-data.ts for what gets created.
 * Run with: npm run db:seed (from server/ directory)
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { seedDevData } from './seed-data.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('ERR_CDR_78_EX_CONFIG: DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

console.log('Seeding database...');

const result = await seedDevData(db);

console.log('\nSeed complete!');
console.log(`  League ID:             ${result.leagueId}`);
console.log(`  Draft ID:              ${result.draftId}`);
console.log(`  Teams:                 ${result.teamCount}`);
console.log(`  Players:               ${result.playerCount}`);
console.log(`  Site password:         ${result.sitePassword}`);
console.log(`  Commissioner password: ${result.commissionerPassword}`);
console.log(`  Team password:         ${result.teamPassword} (same for all teams)`);

await sql.end();
