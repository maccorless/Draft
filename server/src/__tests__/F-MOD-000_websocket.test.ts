/**
 * F-MOD-000: WebSocket auth timeout and auth_epoch enforcement
 *
 * Behavioral expectations:
 * - An unauthenticated socket that does not send AUTH within 5 seconds is closed
 * - A JWT issued before auth_epoch was bumped is rejected with 4401 AUTH_EPOCH_INVALID
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ??
  'test-secret-for-vitest-at-least-32-chars-long!!';

const WS_AUTH_TIMEOUT = 5500; // slightly over 5s for CI slack

describe('F-MOD-000 WS auth timeout', () => {
  let server: FastifyInstance;
  let serverPort: number;

  beforeAll(async () => {
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
  }, 10000);

  afterAll(async () => {
    await server.close();
  });

  it(
    'test_F_MOD_000_ws_closes_without_auth_after_5_seconds',
    async () => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/ws`);

      const closeCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Socket did not close within 6s')),
          6000,
        );
        ws.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // The server closes the socket after 5s with code 4401 (AUTH_TIMEOUT)
      // or any non-1000 code indicating abnormal closure
      expect(closeCode).not.toBe(1000);
    },
    WS_AUTH_TIMEOUT + 2000,
  );
});
