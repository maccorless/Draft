/**
 * F-MOD-000: WS envelope schema validation
 *
 * Behavioral expectation: the Zod validators enforce the WS envelope shape
 * { seq, draft_id, event_type, payload, server_time }; any message missing a
 * required field fails validation before reaching a command handler.
 */
import { describe, it, expect } from 'vitest';
import { WsEnvelopeSchema, WsAuthMessageSchema } from '../protocol.js';

const VALID_DRAFT_ID = '123e4567-e89b-12d3-a456-426614174000';
const VALID_TIME = '2026-09-01T12:00:00.000Z';

describe('F-MOD-000 WS envelope schema', () => {
  it('test_F_MOD_000_valid_envelope_passes_validation', () => {
    const envelope = {
      seq: 1,
      draft_id: VALID_DRAFT_ID,
      event_type: 'BID_ACCEPTED',
      payload: { amount: 100 },
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('test_F_MOD_000_envelope_missing_seq_fails', () => {
    const envelope = {
      draft_id: VALID_DRAFT_ID,
      event_type: 'BID_ACCEPTED',
      payload: {},
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_missing_draft_id_fails', () => {
    const envelope = {
      seq: 1,
      event_type: 'BID_ACCEPTED',
      payload: {},
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_missing_event_type_fails', () => {
    const envelope = {
      seq: 1,
      draft_id: VALID_DRAFT_ID,
      payload: {},
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_missing_server_time_fails', () => {
    const envelope = {
      seq: 1,
      draft_id: VALID_DRAFT_ID,
      event_type: 'BID_ACCEPTED',
      payload: {},
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_draft_id_must_be_uuid', () => {
    const envelope = {
      seq: 1,
      draft_id: 'not-a-uuid',
      event_type: 'BID_ACCEPTED',
      payload: {},
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_seq_must_be_nonnegative', () => {
    const envelope = {
      seq: -1,
      draft_id: VALID_DRAFT_ID,
      event_type: 'BID_ACCEPTED',
      payload: {},
      server_time: VALID_TIME,
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('test_F_MOD_000_envelope_payload_can_be_any_value', () => {
    // payload is unknown — any value is valid
    for (const payload of [null, 42, 'string', { nested: true }, [1, 2, 3]]) {
      const envelope = {
        seq: 0,
        draft_id: VALID_DRAFT_ID,
        event_type: 'TEST',
        payload,
        server_time: VALID_TIME,
      };
      expect(WsEnvelopeSchema.safeParse(envelope).success).toBe(true);
    }
  });
});

describe('F-MOD-000 WS AUTH message schema', () => {
  it('test_F_MOD_000_valid_auth_message_passes', () => {
    const msg = {
      type: 'AUTH',
      token: 'eyJhbGciOiJIUzI1NiJ9.test.sig',
      league_id: VALID_DRAFT_ID,
    };
    expect(WsAuthMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('test_F_MOD_000_auth_message_wrong_type_fails', () => {
    const msg = {
      type: 'BID',
      token: 'sometoken',
      league_id: VALID_DRAFT_ID,
    };
    expect(WsAuthMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('test_F_MOD_000_auth_message_missing_token_fails', () => {
    const msg = {
      type: 'AUTH',
      league_id: VALID_DRAFT_ID,
    };
    expect(WsAuthMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('test_F_MOD_000_auth_message_league_id_must_be_uuid', () => {
    const msg = {
      type: 'AUTH',
      token: 'sometoken',
      league_id: 'not-a-uuid',
    };
    expect(WsAuthMessageSchema.safeParse(msg).success).toBe(false);
  });
});
