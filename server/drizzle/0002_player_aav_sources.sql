-- Migration: Multi-source AAV (player_aav_sources) + player intelligence fields
-- F-MOD-016: Multi-source AAV and player intelligence data

--> statement-breakpoint
ALTER TABLE "players"
  ADD COLUMN IF NOT EXISTS "bye_week" integer,
  ADD COLUMN IF NOT EXISTS "injury_status" text,
  ADD COLUMN IF NOT EXISTS "injury_detail" text,
  ADD COLUMN IF NOT EXISTS "injury_updated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "prior_season_stats" jsonb;

--> statement-breakpoint
ALTER TABLE "draft_datasets"
  ADD COLUMN IF NOT EXISTS "primary_aav_source" text,
  ADD COLUMN IF NOT EXISTS "secondary_aav_source" text;

--> statement-breakpoint
ALTER TABLE "player_dataset_entries" RENAME TO "player_aav_sources";

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "player_aav_sources" ADD CONSTRAINT "player_aav_sources_dataset_player_source_unique"
    UNIQUE ("dataset_id", "player_id", "source");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
-- Repoint dataset_player_id FKs from player_aav_sources.id to players.id: a
-- PlayerAuction/WatchListItem/etc. identifies "this player in this draft's
-- dataset" — once player_aav_sources holds one row per (player, source)
-- instead of one row per player, its id is no longer a stable per-player
-- identity, so these FKs move to players.id (the original data-model design).
ALTER TABLE "player_auctions" DROP CONSTRAINT IF EXISTS "player_auctions_dataset_player_id_player_dataset_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "watch_list_items" DROP CONSTRAINT IF EXISTS "watch_list_items_dataset_player_id_player_dataset_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "nomination_queue_items" DROP CONSTRAINT IF EXISTS "nomination_queue_items_dataset_player_id_player_dataset_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "owner_target_values" DROP CONSTRAINT IF EXISTS "owner_target_values_dataset_player_id_player_dataset_entries_id_fk";

--> statement-breakpoint
-- Translate existing data: each dataset_player_id currently holds a
-- player_aav_sources.id (formerly player_dataset_entries.id); the old schema
-- had exactly one row per (dataset, player), so this join is 1:1 and lossless.
UPDATE "player_auctions" pa
SET "dataset_player_id" = pas."player_id"
FROM "player_aav_sources" pas
WHERE pa."dataset_player_id" = pas."id";
--> statement-breakpoint
UPDATE "watch_list_items" w
SET "dataset_player_id" = pas."player_id"
FROM "player_aav_sources" pas
WHERE w."dataset_player_id" = pas."id";
--> statement-breakpoint
UPDATE "nomination_queue_items" n
SET "dataset_player_id" = pas."player_id"
FROM "player_aav_sources" pas
WHERE n."dataset_player_id" = pas."id";
--> statement-breakpoint
UPDATE "owner_target_values" o
SET "dataset_player_id" = pas."player_id"
FROM "player_aav_sources" pas
WHERE o."dataset_player_id" = pas."id";

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "player_auctions" ADD CONSTRAINT "player_auctions_dataset_player_id_players_id_fk"
    FOREIGN KEY ("dataset_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "watch_list_items" ADD CONSTRAINT "watch_list_items_dataset_player_id_players_id_fk"
    FOREIGN KEY ("dataset_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "nomination_queue_items" ADD CONSTRAINT "nomination_queue_items_dataset_player_id_players_id_fk"
    FOREIGN KEY ("dataset_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "owner_target_values" ADD CONSTRAINT "owner_target_values_dataset_player_id_players_id_fk"
    FOREIGN KEY ("dataset_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
