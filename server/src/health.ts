import type { FastifyInstance } from 'fastify';

/**
 * GET /health — liveness probe.
 * Returns 200 { status: "ok", ts: "<ISO-8601>" } regardless of DB state.
 * No auth required. Must respond within 50ms.
 */
export async function registerHealthRoute(server: FastifyInstance): Promise<void> {
  // Exempt health from rate limiting
  server.get(
    '/health',
    {
      config: { rateLimit: false },
    },
    async (_req, reply) => {
      return reply.send({
        status: 'ok',
        ts: new Date().toISOString(),
      });
    },
  );
}
