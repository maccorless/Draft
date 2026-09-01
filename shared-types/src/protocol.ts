import { z } from 'zod';

/**
 * Sequence-numbered WS envelope — every message on the wire uses this shape.
 * The seq counter lets clients detect gaps and request replay.
 */
export const WsEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  draft_id: z.string().uuid(),
  event_type: z.string().min(1),
  payload: z.unknown(),
  server_time: z.string().datetime(),
});

export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

/**
 * AUTH message — first message a client sends on every WS connection.
 * The server closes the socket if this is not received within 5 seconds.
 */
export const WsAuthMessageSchema = z.object({
  type: z.literal('AUTH'),
  token: z.string().min(1),
  league_id: z.string().uuid(),
});

export type WsAuthMessage = z.infer<typeof WsAuthMessageSchema>;

/**
 * ERROR message — server sends when a command is rejected.
 */
export const WsErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  code: z.string().min(1),
  reason: z.string(),
  seq: z.number().int().nonnegative().optional(),
});

export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;
