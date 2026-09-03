import { z } from 'zod';

// ─── WS Client Commands ───────────────────────────────────────────────────────

/** First message on every /ws/drafts/:draftId connection */
export const WsAuthenticateCommandSchema = z.object({
  type: z.literal('AUTHENTICATE'),
  payload: z.object({
    token: z.string().min(1),
  }),
});
export type WsAuthenticateCommand = z.infer<typeof WsAuthenticateCommandSchema>;

export const BidCommandSchema = z.object({
  type: z.literal('BID_COMMAND'),
  payload: z.object({
    player_auction_id: z.string().uuid(),
    bid_amount_minor: z.number().int().min(100),
    bid_type: z.enum(['ABSOLUTE', 'RELATIVE', 'NOMINATOR_MATCH']),
    /** Required for RELATIVE and NOMINATOR_MATCH */
    expected_current_bid_minor: z.number().int().optional(),
    /** Required for RELATIVE and NOMINATOR_MATCH */
    expected_auction_version: z.number().int().optional(),
  }),
});
export type BidCommand = z.infer<typeof BidCommandSchema>;

export const NominateCommandSchema = z.object({
  type: z.literal('NOMINATE_COMMAND'),
  payload: z.object({
    player_dataset_entry_id: z.string().uuid(),
    opening_bid_minor: z.number().int().min(100),
  }),
});
export type NominateCommand = z.infer<typeof NominateCommandSchema>;

export const PassNominationCommandSchema = z.object({
  type: z.literal('PASS_NOMINATION'),
  payload: z.object({}).optional(),
});
export type PassNominationCommand = z.infer<typeof PassNominationCommandSchema>;

// Union of all WS client commands (after authentication)
export const AuctionClientCommandSchema = z.discriminatedUnion('type', [
  BidCommandSchema,
  NominateCommandSchema,
  PassNominationCommandSchema,
]);
export type AuctionClientCommand = z.infer<typeof AuctionClientCommandSchema>;

// ─── WS Server Events ─────────────────────────────────────────────────────────

export const BidAcceptedEventSchema = z.object({
  type: z.literal('BID_ACCEPTED'),
  payload: z.object({
    player_auction_id: z.string().uuid(),
    bid_amount_minor: z.number().int(),
    leading_team_id: z.string().uuid(),
    auction_version: z.number().int(),
    rebid_deadline_ts: z.number().int(),
    anti_snipe_extended: z.boolean(),
  }),
});
export type BidAcceptedEvent = z.infer<typeof BidAcceptedEventSchema>;

export const BidRejectedEventSchema = z.object({
  type: z.literal('BID_REJECTED'),
  payload: z.object({
    player_auction_id: z.string().uuid(),
    code: z.string(),
    reason: z.string(),
  }),
});
export type BidRejectedEvent = z.infer<typeof BidRejectedEventSchema>;

export const NominationStartedEventSchema = z.object({
  type: z.literal('NOMINATION_STARTED'),
  payload: z.object({
    player_auction_id: z.string().uuid(),
    player_name: z.string(),
    position: z.string(),
    nfl_team: z.string(),
    tier: z.number().int().nullable(),
    aav_minor: z.number().int(),
    projected_points: z.number().nullable(),
    nominator_team_id: z.string().uuid(),
    opening_bid_minor: z.number().int(),
    nomination_deadline_ts: z.number().int(),
    second_bid_deadline_ts: z.number().int(),
    system_nominated: z.boolean(),
  }),
});
export type NominationStartedEvent = z.infer<typeof NominationStartedEventSchema>;

export const PlayerAwardedEventSchema = z.object({
  type: z.literal('PLAYER_AWARDED'),
  payload: z.object({
    player_auction_id: z.string().uuid(),
    player_name: z.string(),
    winning_team_id: z.string().uuid(),
    price_minor: z.number().int(),
    roster_slot: z.string(),
    resolution_sequence: z.number().int(),
  }),
});
export type PlayerAwardedEvent = z.infer<typeof PlayerAwardedEventSchema>;

export const NominationTurnChangedEventSchema = z.object({
  type: z.literal('NOMINATION_TURN_CHANGED'),
  payload: z.object({
    current_nominator_team_id: z.string().uuid(),
    nomination_deadline_ts: z.number().int(),
  }),
});
export type NominationTurnChangedEvent = z.infer<typeof NominationTurnChangedEventSchema>;

export const DraftStatusChangedEventSchema = z.object({
  type: z.literal('DRAFT_STATUS_CHANGED'),
  payload: z.object({
    draft_id: z.string().uuid(),
    status: z.enum(['RUNNING', 'PAUSED', 'COMPLETE']),
  }),
});
export type DraftStatusChangedEvent = z.infer<typeof DraftStatusChangedEventSchema>;

export const DraftStatusResponseSchema = z.object({
  draft_id: z.string().uuid(),
  status: z.enum(['CREATED', 'RUNNING', 'PAUSED', 'COMPLETE']),
});
export type DraftStatusResponse = z.infer<typeof DraftStatusResponseSchema>;
