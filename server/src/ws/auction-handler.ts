/**
 * WS auction handler — endpoint: /ws/drafts/:draftId
 *
 * Critical invariants:
 * 1. server_receipt_time = new Date() is the FIRST LINE of the message handler.
 * 2. auth_epoch is re-read from DB on every command (never from token payload).
 * 3. All mutating commands go through the per-draft AsyncQueue.
 * 4. Multi-draft isolation: verify draft.league_id === token.league_id on every command.
 * 5. On AUTHENTICATE: send STATE_SNAPSHOT + replay missed DraftEvents (F-MOD-003).
 * 6. Multi-window identity: multiple tabs share one logical team session (F-MOD-003).
 * 7. Grace timer: on last WS close, start timer; if fires, transition to AUTO_AGENT (F-MOD-004).
 * 8. Reconnect does NOT restore MANUAL control — owner must explicitly send RESUME_MANUAL.
 */
import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import type WebSocket from 'ws';

import postgres from 'postgres';

import {
  getOrCreateRuntime,
  readAuthEpoch,
  processBidCommand,
  processNominateCommand,
  processPassNomination,
  registerTeamSession,
  unregisterTeamSession,
  broadcast,
  type TokenClaims,
} from '../auction/engine.js';
import { buildDraftStateSnapshot } from '../session/routes.js';
import {
  handleGraceExpiry,
  setControlMode,
  upsertAutoAgentConfig,
  triggerAutoAgentBidsOnNomination,
  triggerAutoAgentBidsOnLeaderChange,
} from '../auction/auto-agent.js';

interface DraftParams {
  draftId: string;
}

const AUTH_TIMEOUT_MS = 5000;
/** Grace period before AUTO_AGENT takeover after all WS connections drop. */
const GRACE_PERIOD_MS = 30_000;

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

      let authenticated = false;
      let sessionClaims: TokenClaims | null = null;
      let sessionTeamId: string | null = null;

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

          const payload = msgObj.payload as { token?: string; last_seen_sequence?: number } | undefined;
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

          // Verify the draft belongs to this token's league (multi-draft isolation — constraint #11)
          const draftRows = await sql<[{ league_id: string; status: string }]>`
            SELECT league_id, status FROM drafts WHERE id = ${draftId} LIMIT 1
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

          // Re-read auth_epoch from DB — constraint #12
          const currentEpoch = await readAuthEpoch(sql, claims);
          if (currentEpoch === null || claims.auth_epoch !== currentEpoch) {
            socket.close(4401, 'AUTH_EPOCH_INVALID');
            return;
          }

          clearTimeout(authTimer);
          authenticated = true;
          sessionClaims = claims;
          sessionTeamId = claims.team_id ?? claims.league_id; // commissioner uses league_id as identity

          // ─── Check if team is reconnecting within grace period ─────────────
          const rt = getOrCreateRuntime(draftId);
          const wasInGrace = rt.graceTimers.has(sessionTeamId);

          // ─── Register in multi-window session tracking ─────────────────────
          registerTeamSession(
            draftId,
            sessionTeamId,
            socket as unknown as WebSocket,
            GRACE_PERIOD_MS,
            // Grace expired callback — runs in queue for atomicity with other commands
            (dId, tId) => {
              getOrCreateRuntime(dId).queue.enqueue(async () => {
                await handleGraceExpiry(dId, tId, sql);
              });
            },
          );

          // If team had a grace timer running, broadcast TEAM_RECONNECTED
          // (control_mode stays AUTO_AGENT if it was already set — no auto-resume)
          if (wasInGrace) {
            // Broadcast reconnect event to all clients
            getOrCreateRuntime(draftId).queue.enqueue(async () => {
              const teamStateRows = await sql<[{ control_mode: string }]>`
                SELECT control_mode FROM draft_team_states
                WHERE draft_id = ${draftId} AND team_id = ${sessionTeamId!}
                LIMIT 1
              `;
              const currentMode = teamStateRows[0]?.control_mode ?? 'MANUAL';

              // Insert TEAM_RECONNECTED event
              try {
                await sql.begin(async (tx) => {
                  const seqRows = await tx<[{ max: number | null }]>`
                    SELECT COALESCE(MAX(sequence), -1) + 1 AS max
                    FROM draft_events WHERE draft_id = ${draftId}
                  `;
                  const seq = seqRows[0]?.max ?? 0;
                  await tx`
                    INSERT INTO draft_events
                      (draft_id, sequence, event_type, team_id, payload, created_at)
                    VALUES
                      (${draftId}, ${seq}, 'TEAM_RECONNECTED', ${sessionTeamId!},
                       ${JSON.stringify({ triggered_by: 'owner', control_mode: currentMode })}::jsonb, NOW())
                  `;
                });
              } catch (err) {
                console.error('[ws] TEAM_RECONNECTED event insert failed:', err);
              }

              broadcast(draftId, {
                type: 'TEAM_RECONNECTED',
                payload: { team_id: sessionTeamId!, triggered_by: 'owner' },
              });
            });
          }

          // ─── Build and send STATE_SNAPSHOT ────────────────────────────────
          const hasLastSeen = typeof payload?.last_seen_sequence === 'number';
          const lastSeenSeq: number = hasLastSeen ? (payload!.last_seen_sequence as number) : -1;

          const missedEvents = hasLastSeen ? await sql<Array<{
            sequence: number;
            event_type: string;
            team_id: string | null;
            player_auction_id: string | null;
            payload: unknown;
            created_at: Date;
          }>>`
            SELECT sequence, event_type, team_id, player_auction_id, payload, created_at
            FROM draft_events
            WHERE draft_id = ${draftId} AND sequence > ${lastSeenSeq}
            ORDER BY sequence ASC
          ` : [];

          const snapshot = await buildDraftStateSnapshot(sql, draftId, draft.status);
          snapshot.missed_events_replayed = missedEvents.length;

          socket.send(JSON.stringify({ type: 'STATE_SNAPSHOT', payload: snapshot }));

          for (const ev of missedEvents) {
            socket.send(JSON.stringify({
              type: ev.event_type,
              payload: {
                ...(ev.payload as Record<string, unknown>),
                sequence: ev.sequence,
                team_id: ev.team_id,
                player_auction_id: ev.player_auction_id,
                created_at: ev.created_at instanceof Date
                  ? ev.created_at.toISOString()
                  : ev.created_at,
                _replayed: true,
              },
            }));
          }

          return;
        }

        // ─── Authenticated commands ───────────────────────────────────────────
        if (!sessionClaims) return;

        const claims = sessionClaims;

        // Re-read auth_epoch on EVERY command — constraint #2
        getOrCreateRuntime(draftId).queue.enqueue(async () => {
          const currentEpoch = await readAuthEpoch(sql, claims);
          if (currentEpoch === null || claims.auth_epoch !== currentEpoch) {
            socket.send(JSON.stringify({
              type: 'ERROR',
              payload: { code: 'AUTH_EPOCH_INVALID', reason: 'Token has been revoked' },
            }));
            socket.close(4401, 'AUTH_EPOCH_INVALID');
            return;
          }

          const type = msgObj.type;
          const commandPayload = msgObj.payload as Record<string, unknown> ?? {};

          if (type === 'BID_COMMAND') {
            const teamId = claims.team_id;
            if (!teamId) {
              socket.send(JSON.stringify({
                type: 'BID_REJECTED',
                payload: {
                  player_auction_id: commandPayload['player_auction_id'] ?? '',
                  code: 'NO_TEAM',
                  reason: 'Commissioner cannot bid',
                },
              }));
              return;
            }
            const result = await processBidCommand({
              draftId,
              teamId,
              leagueId: claims.league_id,
              serverReceiptTime,
              sql,
              command: {
                player_auction_id: String(commandPayload['player_auction_id'] ?? ''),
                bid_amount_minor: Number(commandPayload['bid_amount_minor'] ?? 0),
                bid_type: String(commandPayload['bid_type'] ?? 'ABSOLUTE') as 'ABSOLUTE' | 'RELATIVE' | 'NOMINATOR_MATCH',
                expected_current_bid_minor: commandPayload['expected_current_bid_minor'] !== undefined
                  ? Number(commandPayload['expected_current_bid_minor'])
                  : undefined,
                expected_auction_version: commandPayload['expected_auction_version'] !== undefined
                  ? Number(commandPayload['expected_auction_version'])
                  : undefined,
              },
            });

            // Trigger auto-agent bids for teams that just lost the lead
            if (result.accepted && result.leadingTeamId === teamId) {
              await triggerAutoAgentBidsOnLeaderChange(
                draftId,
                claims.league_id,
                result.playerAuctionId,
                result.bidAmountMinor!,
                teamId,
                sql,
              );
            }
          } else if (type === 'NOMINATE_COMMAND') {
            const teamId = claims.team_id ?? claims.league_id;
            const nominateResult = await processNominateCommand({
              draftId,
              teamId,
              leagueId: claims.league_id,
              serverReceiptTime,
              sql,
              command: {
                player_dataset_entry_id: String(commandPayload['player_dataset_entry_id'] ?? ''),
                opening_bid_minor: Number(commandPayload['opening_bid_minor'] ?? 100),
              },
            });

            // Trigger auto-agent bids for all AUTO_AGENT teams except the nominator
            if (nominateResult.succeeded && nominateResult.auctionId) {
              await triggerAutoAgentBidsOnNomination(
                draftId,
                claims.league_id,
                nominateResult.auctionId,
                nominateResult.openingBidMinor!,
                nominateResult.nominatorTeamId!,
                sql,
              );
            }
          } else if (type === 'PASS_NOMINATION') {
            const teamId = claims.team_id;
            if (teamId) {
              await processPassNomination(draftId, teamId, claims.league_id, sql);
            }
          } else if (type === 'SET_AUTO_AGENT_CONFIG') {
            // Owner sets willingness_pct
            const teamId = claims.team_id;
            if (!teamId) {
              socket.send(JSON.stringify({
                type: 'ERROR',
                payload: { code: 'NO_TEAM', reason: 'Commissioner cannot set auto-agent config' },
              }));
              return;
            }
            const willingnessPct = Number(commandPayload['willingness_pct'] ?? -1);
            if (willingnessPct < 0 || willingnessPct > 1) {
              socket.send(JSON.stringify({
                type: 'ERROR',
                payload: { code: 'INVALID_PARAM', reason: 'willingness_pct must be in [0, 1]' },
              }));
              return;
            }
            const cfgResult = await upsertAutoAgentConfig(draftId, teamId, willingnessPct, sql);
            socket.send(JSON.stringify({
              type: 'AUTO_AGENT_CONFIG_UPDATED',
              payload: cfgResult,
            }));
          } else if (type === 'RESUME_MANUAL') {
            // Owner explicitly restores MANUAL control — constraint #7
            const teamId = claims.team_id;
            if (!teamId) {
              socket.send(JSON.stringify({
                type: 'ERROR',
                payload: { code: 'NO_TEAM', reason: 'Commissioner cannot resume manual control' },
              }));
              return;
            }
            await setControlMode(draftId, teamId, 'MANUAL', 'owner', sql);
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
        if (sessionTeamId) {
          unregisterTeamSession(
            draftId,
            sessionTeamId,
            socket as unknown as WebSocket,
            GRACE_PERIOD_MS,
            (dId, tId) => {
              getOrCreateRuntime(dId).queue.enqueue(async () => {
                await handleGraceExpiry(dId, tId, sql);
              });
            },
          );
        } else {
          const rt = getOrCreateRuntime(draftId);
          rt.clients.delete(socket as unknown as WebSocket);
        }
      });

      socket.on('error', () => {
        clearTimeout(authTimer);
        if (sessionTeamId) {
          unregisterTeamSession(
            draftId,
            sessionTeamId,
            socket as unknown as WebSocket,
            GRACE_PERIOD_MS,
            (dId, tId) => {
              getOrCreateRuntime(dId).queue.enqueue(async () => {
                await handleGraceExpiry(dId, tId, sql);
              });
            },
          );
        } else {
          const rt = getOrCreateRuntime(draftId);
          rt.clients.delete(socket as unknown as WebSocket);
        }
      });
    },
  );
}
