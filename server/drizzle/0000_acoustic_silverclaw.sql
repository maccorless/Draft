DO $$ BEGIN
 CREATE TYPE "public"."bid_type" AS ENUM('ABSOLUTE', 'RELATIVE', 'NOMINATOR_MATCH');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."budget_entry_type" AS ENUM('AWARD', 'CORRECTION', 'WHAMMY', 'ROLLBACK');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."control_mode" AS ENUM('MANUAL', 'AUTO_AGENT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."dataset_status" AS ENUM('DRAFT', 'VALIDATED', 'FROZEN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."draft_status" AS ENUM('CREATED', 'RUNNING', 'PAUSED', 'COMPLETE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."membership_role" AS ENUM('COMMISSIONER', 'HOST', 'OWNER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."player_auction_status" AS ENUM('PENDING', 'OPEN', 'CLOSED', 'AWARDED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acquisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_auction_id" uuid NOT NULL,
	"price_minor" integer NOT NULL,
	"resolution_sequence" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auction_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"initial_budget_minor" integer NOT NULL,
	"nomination_timer_ms" integer NOT NULL,
	"second_bid_timer_ms" integer NOT NULL,
	"rebid_timer_ms" integer NOT NULL,
	"anti_snipe_threshold_ms" integer NOT NULL,
	"anti_snipe_extension_ms" integer NOT NULL,
	"min_bid_minor" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "auction_configurations_league_id_unique" UNIQUE("league_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"willingness_pct" numeric(4, 3) DEFAULT '0.800' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_transition_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bid_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"player_auction_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"bid_amount_minor" integer NOT NULL,
	"bid_type" "bid_type" NOT NULL,
	"expected_current_bid_minor" integer,
	"expected_auction_version" integer,
	"server_receipt_time" timestamp with time zone NOT NULL,
	"accepted" boolean NOT NULL,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"acquisition_id" uuid,
	"amount_minor" integer NOT NULL,
	"entry_type" "budget_entry_type" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"draft_id" uuid,
	"status" "dataset_status" DEFAULT 'DRAFT' NOT NULL,
	"frozen_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"team_id" uuid,
	"player_auction_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draft_team_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"remaining_budget_minor" integer NOT NULL,
	"roster_filled_count" integer DEFAULT 0 NOT NULL,
	"required_remaining_spots" integer NOT NULL,
	"control_mode" "control_mode" DEFAULT 'MANUAL' NOT NULL,
	"connected_at" timestamp with time zone,
	"nominator_match_used" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"status" "draft_status" DEFAULT 'CREATED' NOT NULL,
	"nomination_cursor" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"site_password_hash" text NOT NULL,
	"commissioner_password_hash" text NOT NULL,
	"commissioner_team_id" uuid,
	"auth_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"league_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nomination_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"dataset_player_id" uuid NOT NULL,
	"queue_position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nominator_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "owner_target_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"dataset_player_id" uuid NOT NULL,
	"target_value_minor" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"dataset_player_id" uuid NOT NULL,
	"status" "player_auction_status" DEFAULT 'PENDING' NOT NULL,
	"current_bid_minor" integer DEFAULT 0 NOT NULL,
	"current_leader_id" uuid,
	"auction_version" integer DEFAULT 0 NOT NULL,
	"nomination_deadline" timestamp with time zone,
	"rebid_deadline" timestamp with time zone,
	"anti_snipe_extension_count" integer DEFAULT 0 NOT NULL,
	"resolution_sequence" integer,
	"nominator_team_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_dataset_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"aav_minor" integer NOT NULL,
	"projected_points" numeric(6, 2),
	"tier" integer,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" text NOT NULL,
	"nfl_team" text NOT NULL,
	"espn_player_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"total_roster_size" integer NOT NULL,
	"bench_slots" integer NOT NULL,
	CONSTRAINT "roster_configurations_league_id_unique" UNIQUE("league_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"acquisition_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"roster_slot_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_slot_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"position" text NOT NULL,
	"priority" integer NOT NULL,
	"is_starter" boolean NOT NULL,
	"slot_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"team_password_hash" text NOT NULL,
	"auth_epoch" integer DEFAULT 0 NOT NULL,
	"draft_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watch_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"dataset_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whammy_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_amount_minor" integer NOT NULL,
	"allowed_event_types" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "whammy_configs_league_id_unique" UNIQUE("league_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_player_auction_id_player_auctions_id_fk" FOREIGN KEY ("player_auction_id") REFERENCES "public"."player_auctions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auction_configurations" ADD CONSTRAINT "auction_configurations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auto_agent_configs" ADD CONSTRAINT "auto_agent_configs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auto_agent_configs" ADD CONSTRAINT "auto_agent_configs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bid_attempts" ADD CONSTRAINT "bid_attempts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bid_attempts" ADD CONSTRAINT "bid_attempts_player_auction_id_player_auctions_id_fk" FOREIGN KEY ("player_auction_id") REFERENCES "public"."player_auctions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bid_attempts" ADD CONSTRAINT "bid_attempts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_ledger_entries" ADD CONSTRAINT "budget_ledger_entries_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_ledger_entries" ADD CONSTRAINT "budget_ledger_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_ledger_entries" ADD CONSTRAINT "budget_ledger_entries_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_datasets" ADD CONSTRAINT "draft_datasets_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_player_auction_id_player_auctions_id_fk" FOREIGN KEY ("player_auction_id") REFERENCES "public"."player_auctions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_team_states" ADD CONSTRAINT "draft_team_states_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draft_team_states" ADD CONSTRAINT "draft_team_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drafts" ADD CONSTRAINT "drafts_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drafts" ADD CONSTRAINT "drafts_dataset_id_draft_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."draft_datasets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nomination_queue_items" ADD CONSTRAINT "nomination_queue_items_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nomination_queue_items" ADD CONSTRAINT "nomination_queue_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nomination_queue_items" ADD CONSTRAINT "nomination_queue_items_dataset_player_id_player_dataset_entries_id_fk" FOREIGN KEY ("dataset_player_id") REFERENCES "public"."player_dataset_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nominator_matches" ADD CONSTRAINT "nominator_matches_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nominator_matches" ADD CONSTRAINT "nominator_matches_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owner_target_values" ADD CONSTRAINT "owner_target_values_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owner_target_values" ADD CONSTRAINT "owner_target_values_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owner_target_values" ADD CONSTRAINT "owner_target_values_dataset_player_id_player_dataset_entries_id_fk" FOREIGN KEY ("dataset_player_id") REFERENCES "public"."player_dataset_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_auctions" ADD CONSTRAINT "player_auctions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_auctions" ADD CONSTRAINT "player_auctions_dataset_player_id_player_dataset_entries_id_fk" FOREIGN KEY ("dataset_player_id") REFERENCES "public"."player_dataset_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_auctions" ADD CONSTRAINT "player_auctions_current_leader_id_teams_id_fk" FOREIGN KEY ("current_leader_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_auctions" ADD CONSTRAINT "player_auctions_nominator_team_id_teams_id_fk" FOREIGN KEY ("nominator_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_dataset_entries" ADD CONSTRAINT "player_dataset_entries_dataset_id_draft_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."draft_datasets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_dataset_entries" ADD CONSTRAINT "player_dataset_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_configurations" ADD CONSTRAINT "roster_configurations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_slot_id_roster_slot_definitions_id_fk" FOREIGN KEY ("roster_slot_id") REFERENCES "public"."roster_slot_definitions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_slot_definitions" ADD CONSTRAINT "roster_slot_definitions_config_id_roster_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."roster_configurations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watch_list_items" ADD CONSTRAINT "watch_list_items_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watch_list_items" ADD CONSTRAINT "watch_list_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watch_list_items" ADD CONSTRAINT "watch_list_items_dataset_player_id_player_dataset_entries_id_fk" FOREIGN KEY ("dataset_player_id") REFERENCES "public"."player_dataset_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whammy_configs" ADD CONSTRAINT "whammy_configs_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
