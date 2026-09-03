/**
 * Dev-only tooling — registered by main.ts only when NODE_ENV !== 'production'.
 *
 * POST /dev/reseed — wipes every table and reseeds one test league (see
 * server/db/seed-data.ts). Backs the "Reload Test Data" button in the
 * Commissioner Console's League Setup section. No auth: it must work even
 * when the caller's session belongs to a league this call is about to erase.
 */
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

import { wipeAllTables } from '../../db/wipe.js';
import { seedDevData } from '../../db/seed-data.js';

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
}
