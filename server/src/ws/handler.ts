import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type WebSocket from 'ws';
import { eq } from 'drizzle-orm';

import { leagues, teams } from '../../db/schema/index.js';
import { WsAuthMessageSchema } from '@draft/shared-types';

const AUTH_TIMEOUT_MS = 5000; // 5 seconds

export async function registerWsHandler(
  server: FastifyInstance,
  db: PostgresJsDatabase,
): Promise<void> {
  // @fastify/websocket@11 passes the raw WebSocket directly (no SocketStream wrapper)
  server.get('/ws', { websocket: true }, (socket: WebSocket) => {
    // Start auth timeout — close socket if AUTH not received within 5 seconds
    const authTimer = setTimeout(() => {
      if (socket.readyState === socket.OPEN) {
        socket.close(4401, 'AUTH_TIMEOUT');
      }
    }, AUTH_TIMEOUT_MS);

    let authenticated = false;

    socket.on('message', async (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString());

        if (!authenticated) {
          // Only process AUTH message when not yet authenticated
          const parse = WsAuthMessageSchema.safeParse(data);
          if (!parse.success) {
            socket.close(4400, 'INVALID_AUTH_MESSAGE');
            return;
          }

          const { token, league_id } = parse.data;

          // Verify JWT
          let payload: {
            league_id: string;
            team_id?: string;
            role: string;
            auth_epoch: number;
          };
          try {
            payload = server.jwt.verify<typeof payload>(token);
          } catch {
            socket.close(4401, 'INVALID_TOKEN');
            return;
          }

          if (payload.league_id !== league_id) {
            socket.close(4401, 'LEAGUE_MISMATCH');
            return;
          }

          // Re-read auth_epoch from DB (never trust cached token value)
          const currentEpoch = await readAuthEpoch(db, payload);
          if (currentEpoch === null || payload.auth_epoch !== currentEpoch) {
            socket.close(4401, 'AUTH_EPOCH_INVALID');
            return;
          }

          // Auth successful
          clearTimeout(authTimer);
          authenticated = true;

          socket.send(JSON.stringify({ type: 'AUTHENTICATED' }));
          return;
        }

        // Authenticated message handling (stub — later modules fill this in)
        // All command handlers go through here
      } catch {
        // Malformed JSON
        if (!authenticated) {
          socket.close(4400, 'MALFORMED_MESSAGE');
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
    });

    socket.on('error', () => {
      clearTimeout(authTimer);
    });
  });
}

/**
 * Re-read auth_epoch from Postgres for the given JWT payload.
 * Returns null if the league/team row doesn't exist.
 */
async function readAuthEpoch(
  db: PostgresJsDatabase,
  payload: { league_id: string; team_id?: string; role: string },
): Promise<number | null> {
  if (payload.role === 'OWNER' && payload.team_id) {
    const [team] = await db
      .select({ auth_epoch: teams.auth_epoch })
      .from(teams)
      .where(eq(teams.id, payload.team_id))
      .limit(1);
    return team?.auth_epoch ?? null;
  }

  // COMMISSIONER / HOST — check league auth_epoch
  const [league] = await db
    .select({ auth_epoch: leagues.auth_epoch })
    .from(leagues)
    .where(eq(leagues.id, payload.league_id))
    .limit(1);
  return league?.auth_epoch ?? null;
}
