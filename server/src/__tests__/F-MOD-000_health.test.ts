/**
 * F-MOD-000: GET /health returns correct response
 *
 * Behavioral expectation: given the server is running, when GET /health is
 * called, it returns HTTP 200 { "status": "ok", "ts": "<ISO-8601>" } within
 * 50ms regardless of database state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Stub minimal env before importing server
process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars';

describe('F-MOD-000 GET /health', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('test_F_MOD_000_health_returns_200', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
  });

  it('test_F_MOD_000_health_returns_ok_status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });
    const body = response.json<{ status: string; ts: string }>();
    expect(body.status).toBe('ok');
  });

  it('test_F_MOD_000_health_returns_iso_timestamp', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });
    const body = response.json<{ status: string; ts: string }>();
    // Must be a valid ISO-8601 datetime
    expect(new Date(body.ts).toISOString()).toBe(body.ts);
  });

  it('test_F_MOD_000_health_responds_quickly', async () => {
    const start = Date.now();
    await server.inject({ method: 'GET', url: '/health' });
    const elapsed = Date.now() - start;
    // Fastify inject is synchronous/in-memory, should be well under 50ms
    expect(elapsed).toBeLessThan(50);
  });
});
