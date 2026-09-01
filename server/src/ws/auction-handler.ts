/**
 * WS auction handler — endpoint: /ws/drafts/:draftId
 *
 * Critical invariants:
 * 1. server_receipt_time = new Date() is the FIRST LINE of the message handler.
 * 2. auth_epoch is re-read from DB on every command (never from token payload).
 * 3. All mutating commands go through the per-draft AsyncQueue.
 * 4. Multi-draft isolation: verify draft.league_id === token.league_id on every command.
 */
import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { SocketStream } from '@fastify/websocket';

import postgres from 'postgres';

import {
  getOrCreateRuntime,
  readAuthEpoch,
  processBidCommand,
  processNominateCommand,
  processPassNomination,
  type TokenClaims,
} from '../auction/engine.js';

interface DraftParams {
  draftId: string;
}

const AUTH_TIMEOUT_MS = 5000;

export async function registerAuctionWsHandler(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  server.get<{ Params: DraftParams }>(
    '/ws/drafts/:draftId',
    { websocket: true },
    (connection: SocketStream, req: FastifyRequest<{ Params: DraftParams }>) => {
      const socket = connection.socket;
      const draftId = req.params.draftId;

      // Register this connection with the draft's runtime
      const rt = getOrCreateRuntime(draftId);
      rt.clients.add(socket as unknown as import('ws').WebSocket);

      let authenticated = false;
      let sessionClaims: TokenClaims | null = null;

      // Auth timeout — close if AUTHENTICATE not received within 5s
      const authTimer = setTimeout(() => {
        if (socket.readyState === socket.OPEN) {
          socket.close(4401, 'AUTH_TIMEOUT');
        }
      }, AUTH_TIMEOUT_MS);

      socket.on('message', async (raw: Buffer | string) => {
        // ─── CONSTRAINT 1: server_receipt_time MUST be first line ────────────
        const serverReceiptTime = new Date();

        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          if (!authenticated) {
            socket.close(4400, 'MALFORMED_MESSAGE');
          }
          return;
        }

        const msgObj = msg as { type?: string; payload?: unknown };

        // ─── AUTHENTICATE (first message) ─────────────────────────────────────
        if (!authenticated) {
          if (msgObj.type !== 'AUTHENTICATE') {
            socket.close(4400, 'EXPECTED_AUTHENTICATE');
            return;
          }

          const payload = msgObj.payload as { token?: string } | undefined;
          const token = payload?.token;
          if (!token) {
            socket.close(4401, 'MISSING_TOKEN');
            return;
          }

          // Verify JWT signature
          let claims: TokenClaims;
          try {
            claims = server.jwt.verify<TokenClaims>(token);
          } catch {
            socket.close(4401, 'INVALID_TOKEN');
            return;
          }

          // Verify the draft belongs to this token's league (multi-draft isolation)
          const draftRows = await sql<[{ league_id: string }]>`
            SELECT league_id FROM drafts WHERE id = ${draftId} LIMIT 1
          `;
          const draft = draftRows[0];
          if (!draft) {
            socket.close(4400, 'DRAFT_NOT_FOUND');
            return;
          }
          if (draft.league_id !== claims.league_id) {
            socket.close(4401, 'LEAGUE_MISMATCH');
            return;
          }

          // Re-read auth_epoch from DB — CONSTRAINT 2
          const currentEpoch = await readAuthEpoch(sql, claims);
          if (currentEpoch === null || claims.auth_epoch !== currentEpoch) {
            socket.close(4401, 'AUTH_EPOCH_INVALID');
            return;
          }

          clearTimeout(authTimer);
          authenticated = true;
          sessionClaims = claims;

          socket.send(JSON.stringify({ type: 'AUTHENTICATED' }));
          return;
        }

        // ─── Authenticated commands ───────────────────────────────────────────
        if (!sessionClaims) return;

        const claims = sessionClaims;

        // Re-read auth_epoch on EVERY command — CONSTRAINT 2
        rt.queue.enqueue(async () => {
          const currentEpoch = await readAuthEpoch(sql, claims);
          if (currentEpoch === null || claims.auth_epoch !== currentEpoch) {
            socket.send(JSON.stringify({
              type: 'ERROR',
              payload: { code: 'AUTH_EPOCH_INVALID', reason: 'Token has been revoked' },
            }));
            socket.close(4401, 'AUTH_EPOCH_INVALID');
            return;
          }

          // Route command
          const type = msgObj.type;
          const payload = msgObj.payload as Record<string, unknown> ?? {};

          if (type === 'BID_COMMAND') {
            const teamId = claims.team_id;
            if (!teamId) {
              socket.send(JSON.stringify({
                type: 'BID_REJECTED',
                payload: {
                  player_auction_id: payload['player_auction_id'] ?? '',
                  code: 'NO_TEAM',
                  reason: 'Commissioner cannot bid',
                },
              }));
              return;
            }
            await processBidCommand({
              draftId,
              teamId,
              leagueId: claims.league_id,
              serverReceiptTime,
              sql,
              command: {
                player_auction_id: String(payload['player_auction_id'] ?? ''),
                bid_amount_minor: Number(payload['bid_amount_minor'] ?? 0),
                bid_type: String(payload['bid_type'] ?? 'ABSOLUTE') as 'ABSOLUTE' | 'RELATIVE' | 'NOMINATOR_MATCH',
                expected_current_bid_minor: payload['expected_current_bid_minor'] !== undefined
                  ? Number(payload['expected_current_bid_minor'])
                  : undefined,
                expected_auction_version: payload['expected_auction_version'] !== undefined
                  ? Number(payload['expected_auction_version'])
                  : undefined,
              },
            });
          } else if (type === 'NOMINATE_COMMAND') {
            const teamId = claims.team_id ?? claims.league_id; // fallback for commissioner
            await processNominateCommand({
              draftId,
              teamId: teamId,
              leagueId: claims.league_id,
              serverReceiptTime,
              sql,
              command: {
                player_dataset_entry_id: String(payload['player_dataset_entry_id'] ?? ''),
                opening_bid_minor: Number(payload['opening_bid_minor'] ?? 100),
              },
            });
          } else if (type === 'PASS_NOMINATION') {
            const teamId = claims.team_id;
            if (teamId) {
              await processPassNomination(draftId, teamId, claims.league_id, sql);
            }
          } else {
            socket.send(JSON.stringify({
              type: 'ERROR',
              payload: { code: 'UNKNOWN_COMMAND', reason: `Unknown command type: ${type}` },
            }));
          }
        });
      });

      socket.on('close', () => {
        clearTimeout(authTimer);
        rt.clients.delete(socket as unknown as import('ws').WebSocket);
      });

      socket.on('error', () => {
        clearTimeout(authTimer);
        rt.clients.delete(socket as unknown as import('ws').WebSocket);
      });
    },
  );
}
