import { z } from 'zod';

// ─── League ───────────────────────────────────────────────────────────────────

export const CreateLeagueRequestSchema = z.object({
  name: z.string().min(1),
  site_password: z.string().min(1),
  commissioner_password: z.string().min(1),
});

export type CreateLeagueRequest = z.infer<typeof CreateLeagueRequestSchema>;

export const LeagueSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type LeagueSummary = z.infer<typeof LeagueSummarySchema>;

// ─── Teams ────────────────────────────────────────────────────────────────────

export const CreateTeamRequestSchema = z.object({
  name: z.string().min(1),
  team_password: z.string().min(1),
  draft_order: z.number().int().min(1),
});

export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;

export const TeamSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  draft_order: z.number().int(),
});

export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const TeamListResponseSchema = z.object({
  teams: z.array(TeamSummarySchema),
});

export type TeamListResponse = z.infer<typeof TeamListResponseSchema>;

// ─── Roster Config ────────────────────────────────────────────────────────────

export const RosterSlotConfigItemSchema = z.object({
  position: z.string().min(1),
  priority: z.number().int().min(1),
  is_starter: z.boolean(),
  slot_count: z.number().int().min(1),
});

export const RosterConfigRequestSchema = z.object({
  bench_slots: z.number().int().min(0),
  slots: z.array(RosterSlotConfigItemSchema).min(1),
});

export type RosterConfigRequest = z.infer<typeof RosterConfigRequestSchema>;

// ─── Auction Config ───────────────────────────────────────────────────────────

export const AuctionConfigRequestSchema = z.object({
  initial_budget_minor: z.number().int().min(1),
  nomination_timer_ms: z.number().int().min(1),
  second_bid_timer_ms: z.number().int().min(1),
  rebid_timer_ms: z.number().int().min(1),
  anti_snipe_threshold_ms: z.number().int().min(0).optional(),
  anti_snipe_extension_ms: z.number().int().min(0).optional(),
  min_bid_minor: z.number().int().min(1).optional(),
});

export type AuctionConfigRequest = z.infer<typeof AuctionConfigRequestSchema>;

// ─── Dataset ──────────────────────────────────────────────────────────────────

export const DatasetSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['DRAFT', 'VALIDATED', 'FROZEN']),
  version: z.number().int(),
  frozen_at: z.string().datetime().nullable().optional(),
});

export type DatasetSummary = z.infer<typeof DatasetSummarySchema>;

export const ImportErrorSchema = z.object({
  row: z.number().int(),
  message: z.string(),
});

export const ImportResultSchema = z.object({
  rows_imported: z.number().int(),
  source: z.enum(['CSV', 'EXCEL', 'ESPN_PDF', 'FANTASYPROS']).optional(),
  errors: z.array(ImportErrorSchema),
});

export type ImportResult = z.infer<typeof ImportResultSchema>;

// ─── Draft ────────────────────────────────────────────────────────────────────

export const CreateDraftRequestSchema = z.object({
  dataset_id: z.string().uuid(),
});

export type CreateDraftRequest = z.infer<typeof CreateDraftRequestSchema>;

export const CreateDraftResponseSchema = z.object({
  id: z.string().uuid(),
  league_id: z.string().uuid(),
  status: z.literal('CREATED'),
  dataset_id: z.string().uuid(),
});

export type CreateDraftResponse = z.infer<typeof CreateDraftResponseSchema>;

// ─── Players ──────────────────────────────────────────────────────────────────

export const PlayerAavSourceEntrySchema = z.object({
  source: z.enum(['CSV', 'EXCEL', 'ESPN_PDF', 'FANTASYPROS']),
  aav_minor: z.number().int(),
  tier: z.number().int().nullable().optional(),
  projected_points: z.number().nullable().optional(),
});

export const PlayerEntrySchema = z.object({
  player_id: z.string().uuid(),
  dataset_entry_id: z.string().uuid(),
  name: z.string(),
  position: z.string(),
  nfl_team: z.string().optional(),
  aav_minor: z.number().int(),
  projected_points: z.number().nullable().optional(),
  tier: z.number().int().nullable().optional(),
  // Added by F-MOD-016 (Multi-Source AAV + player intelligence).
  primary_aav_minor: z.number().int().nullable().optional(),
  secondary_aav_minor: z.number().int().nullable().optional(),
  aav_sources: z.array(PlayerAavSourceEntrySchema).optional(),
  bye_week: z.number().int().nullable().optional(),
  injury_status: z.string().nullable().optional(),
  injury_detail: z.string().nullable().optional(),
  injury_updated_at: z.string().datetime().nullable().optional(),
  prior_season_stats: z.unknown().nullable().optional(),
});

export const PlayerListResponseSchema = z.object({
  players: z.array(PlayerEntrySchema),
});

export type PlayerListResponse = z.infer<typeof PlayerListResponseSchema>;

// ─── Multi-Source AAV selection (F-MOD-016) ────────────────────────────────────

export const SetAavSourcesRequestSchema = z.object({
  primary_aav_source: z.enum(['CSV', 'EXCEL', 'ESPN_PDF', 'FANTASYPROS']),
  secondary_aav_source: z.enum(['CSV', 'EXCEL', 'ESPN_PDF', 'FANTASYPROS']).nullable().optional(),
});

export type SetAavSourcesRequest = z.infer<typeof SetAavSourcesRequestSchema>;

export const AavSourceSelectionResponseSchema = z.object({
  primary_aav_source: z.string(),
  secondary_aav_source: z.string().nullable(),
});

export type AavSourceSelectionResponse = z.infer<typeof AavSourceSelectionResponseSchema>;
