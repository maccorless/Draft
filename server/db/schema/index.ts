import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  decimal,
  unique,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const membershipRoleEnum = pgEnum('membership_role', [
  'COMMISSIONER',
  'HOST',
  'OWNER',
]);

export const draftStatusEnum = pgEnum('draft_status', [
  'CREATED',
  'RUNNING',
  'PAUSED',
  'COMPLETE',
]);

export const playerAuctionStatusEnum = pgEnum('player_auction_status', [
  'PENDING',
  'OPEN',
  'CLOSED',
  'AWARDED',
]);

export const bidTypeEnum = pgEnum('bid_type', [
  'ABSOLUTE',
  'RELATIVE',
  'NOMINATOR_MATCH',
]);

export const controlModeEnum = pgEnum('control_mode', ['MANUAL', 'AUTO_AGENT']);

export const budgetEntryTypeEnum = pgEnum('budget_entry_type', [
  'AWARD',
  'CORRECTION',
  'WHAMMY',
  'ROLLBACK',
  'COMMISSIONER_ADJUSTMENT',
]);

export const datasetStatusEnum = pgEnum('dataset_status', [
  'DRAFT',
  'VALIDATED',
  'FROZEN',
]);

// ─── League & Configuration ───────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  display_name: text('display_name'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const leagues = pgTable('leagues', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  site_password_hash: text('site_password_hash').notNull(),
  commissioner_password_hash: text('commissioner_password_hash').notNull(),
  commissioner_team_id: uuid('commissioner_team_id'),
  auth_epoch: integer('auth_epoch').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id),
  name: text('name').notNull(),
  team_password_hash: text('team_password_hash').notNull(),
  auth_epoch: integer('auth_epoch').notNull().default(0),
  draft_order: integer('draft_order').notNull(),
  icon_url: text('icon_url'),
  nomination_audio_url: text('nomination_audio_url'),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id')
    .notNull()
    .references(() => users.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id),
  role: membershipRoleEnum('role').notNull(),
});

export const rosterConfigurations = pgTable('roster_configurations', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id)
    .unique(),
  total_roster_size: integer('total_roster_size').notNull(),
  bench_slots: integer('bench_slots').notNull(),
});

export const rosterSlotDefinitions = pgTable('roster_slot_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  config_id: uuid('config_id')
    .notNull()
    .references(() => rosterConfigurations.id),
  position: text('position').notNull(),
  priority: integer('priority').notNull(),
  is_starter: boolean('is_starter').notNull(),
  slot_count: integer('slot_count').notNull(),
});

export const auctionConfigurations = pgTable('auction_configurations', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id)
    .unique(),
  initial_budget_minor: integer('initial_budget_minor').notNull(),
  nomination_timer_ms: integer('nomination_timer_ms').notNull(),
  second_bid_timer_ms: integer('second_bid_timer_ms').notNull(),
  rebid_timer_ms: integer('rebid_timer_ms').notNull(),
  anti_snipe_threshold_ms: integer('anti_snipe_threshold_ms').notNull(),
  anti_snipe_extension_ms: integer('anti_snipe_extension_ms').notNull(),
  min_bid_minor: integer('min_bid_minor').notNull().default(100),
});

export const whammyConfigs = pgTable('whammy_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id)
    .unique(),
  enabled: boolean('enabled').notNull().default(false),
  max_amount_minor: integer('max_amount_minor').notNull(),
  allowed_event_types: text('allowed_event_types').array().notNull().default([]),
  allow_positive: boolean('allow_positive').notNull().default(true),
  allow_negative: boolean('allow_negative').notNull().default(true),
  max_per_team: integer('max_per_team'),
  max_per_draft: integer('max_per_draft'),
  commissioner_approval_required: boolean('commissioner_approval_required').notNull().default(false),
});

// ─── Player Dataset ───────────────────────────────────────────────────────────

export const players = pgTable('players', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  position: text('position').notNull(),
  nfl_team: text('nfl_team').notNull(),
  espn_player_id: text('espn_player_id'),
  bye_week: integer('bye_week'),
  injury_status: text('injury_status'),
  injury_detail: text('injury_detail'),
  injury_updated_at: timestamp('injury_updated_at', { withTimezone: true }),
  prior_season_stats: jsonb('prior_season_stats'),
});

export const draftDatasets = pgTable('draft_datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id),
  draft_id: uuid('draft_id'),
  status: datasetStatusEnum('status').notNull().default('DRAFT'),
  frozen_at: timestamp('frozen_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  primary_aav_source: text('primary_aav_source'),
  secondary_aav_source: text('secondary_aav_source'),
});

// One row per (dataset, player, source) — a player can carry multiple named
// AAV values at once (PRD §10 "Multi-Source AAV"); commissioner picks a
// Primary/Secondary among the sources actually loaded (draft_datasets above).
export const playerAavSources = pgTable('player_aav_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  dataset_id: uuid('dataset_id')
    .notNull()
    .references(() => draftDatasets.id),
  player_id: uuid('player_id')
    .notNull()
    .references(() => players.id),
  aav_minor: integer('aav_minor').notNull(),
  projected_points: decimal('projected_points', { precision: 6, scale: 2 }),
  tier: integer('tier'),
  source: text('source').notNull(),
}, (table) => [
  unique('player_aav_sources_dataset_player_source_unique').on(
    table.dataset_id,
    table.player_id,
    table.source,
  ),
]);

// ─── Draft & Auction ─────────────────────────────────────────────────────────

export const drafts = pgTable('drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  league_id: uuid('league_id')
    .notNull()
    .references(() => leagues.id),
  dataset_id: uuid('dataset_id')
    .notNull()
    .references(() => draftDatasets.id),
  status: draftStatusEnum('status').notNull().default('CREATED'),
  nomination_cursor: integer('nomination_cursor').notNull().default(0),
  scheduled_at: timestamp('scheduled_at', { withTimezone: true }),
  started_at: timestamp('started_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const draftTeamStates = pgTable('draft_team_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  remaining_budget_minor: integer('remaining_budget_minor').notNull(),
  roster_filled_count: integer('roster_filled_count').notNull().default(0),
  required_remaining_spots: integer('required_remaining_spots').notNull(),
  control_mode: controlModeEnum('control_mode').notNull().default('MANUAL'),
  connected_at: timestamp('connected_at', { withTimezone: true }),
  nominator_match_used: boolean('nominator_match_used').notNull().default(false),
  nomination_audio_played: boolean('nomination_audio_played').notNull().default(false),
});

export const playerAuctions = pgTable('player_auctions', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  dataset_player_id: uuid('dataset_player_id')
    .notNull()
    .references(() => players.id),
  status: playerAuctionStatusEnum('status').notNull().default('PENDING'),
  current_bid_minor: integer('current_bid_minor').notNull().default(0),
  current_leader_id: uuid('current_leader_id').references(() => teams.id),
  auction_version: integer('auction_version').notNull().default(0),
  nomination_deadline: timestamp('nomination_deadline', { withTimezone: true }),
  rebid_deadline: timestamp('rebid_deadline', { withTimezone: true }),
  anti_snipe_extension_count: integer('anti_snipe_extension_count')
    .notNull()
    .default(0),
  resolution_sequence: integer('resolution_sequence'),
  nominator_team_id: uuid('nominator_team_id').references(() => teams.id),
});

export const bidAttempts = pgTable('bid_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  player_auction_id: uuid('player_auction_id')
    .notNull()
    .references(() => playerAuctions.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  bid_amount_minor: integer('bid_amount_minor').notNull(),
  bid_type: bidTypeEnum('bid_type').notNull(),
  expected_current_bid_minor: integer('expected_current_bid_minor'),
  expected_auction_version: integer('expected_auction_version'),
  server_receipt_time: timestamp('server_receipt_time', { withTimezone: true })
    .notNull(),
  accepted: boolean('accepted').notNull(),
  rejection_reason: text('rejection_reason'),
});

export const draftEvents = pgTable('draft_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  sequence: integer('sequence').notNull(),
  event_type: text('event_type').notNull(),
  team_id: uuid('team_id').references(() => teams.id),
  player_auction_id: uuid('player_auction_id').references(
    () => playerAuctions.id,
  ),
  payload: jsonb('payload').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Resolution & Ledger ─────────────────────────────────────────────────────

export const acquisitions = pgTable('acquisitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  player_auction_id: uuid('player_auction_id')
    .notNull()
    .references(() => playerAuctions.id),
  price_minor: integer('price_minor').notNull(),
  resolution_sequence: integer('resolution_sequence').notNull(),
  active: boolean('active').notNull().default(true),
  awarded_at: timestamp('awarded_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rosterEntries = pgTable('roster_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  acquisition_id: uuid('acquisition_id')
    .notNull()
    .references(() => acquisitions.id),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  roster_slot_id: uuid('roster_slot_id')
    .notNull()
    .references(() => rosterSlotDefinitions.id),
  active: boolean('active').notNull().default(true),
  assigned_at: timestamp('assigned_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const whammyEventStatusEnum = pgEnum('whammy_event_status', [
  'PENDING_APPROVAL',
  'APPLIED',
  'REJECTED',
  'REVERSED',
]);

export const whammyEvents = pgTable('whammy_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  amount_minor: integer('amount_minor').notNull(),
  description: text('description').notNull(),
  status: whammyEventStatusEnum('status').notNull().default('PENDING_APPROVAL'),
  budget_ledger_entry_id: uuid('budget_ledger_entry_id'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const budgetLedgerEntries = pgTable('budget_ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  acquisition_id: uuid('acquisition_id').references(() => acquisitions.id),
  reference_id: uuid('reference_id'),
  amount_minor: integer('amount_minor').notNull(),
  entry_type: budgetEntryTypeEnum('entry_type').notNull(),
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Auto-Agent & Strategy ────────────────────────────────────────────────────

export const autoAgentConfigs = pgTable('auto_agent_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  willingness_pct: decimal('willingness_pct', { precision: 4, scale: 3 })
    .notNull()
    .default('0.800'),
  enabled: boolean('enabled').notNull().default(false),
  last_transition_at: timestamp('last_transition_at', { withTimezone: true }),
});

export const nominatorMatches = pgTable('nominator_matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  used: boolean('used').notNull().default(false),
  used_at: timestamp('used_at', { withTimezone: true }),
});

export const watchListItems = pgTable('watch_list_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  dataset_player_id: uuid('dataset_player_id')
    .notNull()
    .references(() => players.id),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const nominationQueueItems = pgTable('nomination_queue_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  dataset_player_id: uuid('dataset_player_id')
    .notNull()
    .references(() => players.id),
  queue_position: integer('queue_position').notNull(),
});

export const ownerTargetValues = pgTable('owner_target_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  draft_id: uuid('draft_id')
    .notNull()
    .references(() => drafts.id),
  team_id: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  dataset_player_id: uuid('dataset_player_id')
    .notNull()
    .references(() => players.id),
  target_value_minor: integer('target_value_minor').notNull(),
});
