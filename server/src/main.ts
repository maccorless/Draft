// Env check MUST be first — exits before any other module reads env vars.
import './config/env-check.cjs';

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';

import { drafts } from '../db/schema/index.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerHealthRoute } from './health.js';
import { registerWsHandler } from './ws/handler.js';
import { registerLeagueRoutes } from './league/routes.js';
import { registerPlayerRoutes } from './player/routes.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

// ─── Database ────────────────────────────────────────────────────────────────

const sql = postgres(process.env['DATABASE_URL']!, { max: 10 });
export const db = drizzle(sql);

// ─── Crash recovery ──────────────────────────────────────────────────────────
// Per constraint: RUNNING drafts must become PAUSED before accepting connections.
// This runs BEFORE Fastify starts listening.
async function recoverRunningDrafts(): Promise<void> {
  const running = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.status, 'RUNNING'));

  if (running.length === 0) return;

  // Update each RUNNING draft to PAUSED and append a DRAFT_PAUSED event.
  // All in one transaction per draft to satisfy the atomicity requirement.
  for (const draft of running) {
    await sql.begin(async (tx) => {
      // Update draft status
      await tx`
        UPDATE drafts SET status = 'PAUSED' WHERE id = ${draft.id}
      `;
      // Get next sequence number for this draft
      const [seq] = await tx<[{ max: number | null }]>`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS max
        FROM draft_events WHERE draft_id = ${draft.id}
      `;
      // Append DRAFT_PAUSED event
      await tx`
        INSERT INTO draft_events (draft_id, sequence, event_type, payload, created_at)
        VALUES (${draft.id}, ${seq.max ?? 0}, 'DRAFT_PAUSED', '{}', NOW())
      `;
    });
  }

  console.log(
    `Crash recovery: ${running.length} RUNNING draft(s) set to PAUSED`,
  );
}

// ─── Fastify setup ───────────────────────────────────────────────────────────

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
  });

  await server.register(fastifyJwt, {
    secret: process.env['JWT_SECRET']!,
  });

  // global: false — rate-limit is opt-in per route; auth routes apply it via config
  await server.register(fastifyRateLimit, {
    global: false,
    max: 5,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => {
      // The plugin throws the return value, so it must be an Error.
      const err = new Error(
        `Rate limit exceeded. Please wait ${context.after} before retrying.`,
      ) as Error & { statusCode: number; code: string };
      err.statusCode = 429;
      err.code = 'RATE_LIMIT_EXCEEDED';
      return err;
    },
  });

  await server.register(fastifyWebsocket);

  // Error handler — returns { code, message } for HTTP errors
  server.setErrorHandler((error, _req, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  await registerHealthRoute(server);
  await registerAuthRoutes(server, db);
  await registerLeagueRoutes(server, db);
  await registerPlayerRoutes(server, db);
  await registerWsHandler(server, db);

  return server;
}

// ─── Entry point (skip when imported for tests) ───────────────────────────────

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  await recoverRunningDrafts();

  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

export { recoverRunningDrafts };
