-- Migration: ESPN transfer workflow + real SendGrid report delivery
-- (F-MOD-006-rework-01, PRD §37, data-model.md §19.2-19.4/19.7)

--> statement-breakpoint
CREATE TYPE "export_job_status" AS ENUM ('PENDING', 'VALIDATED', 'GENERATED', 'FAILED');
--> statement-breakpoint
CREATE TYPE "reconciliation_item_status" AS ENUM ('PENDING', 'CONFIRMED', 'AMBIGUOUS', 'FAILED');
--> statement-breakpoint
CREATE TYPE "report_delivery_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_EMAIL_DISABLED');
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "commissioner_email" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "owner_email" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_team_mappings" (
	"league_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"team_id" uuid NOT NULL,
	"external_team_id" text,
	"external_team_name" text,
	"verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "provider_team_mappings_pk" UNIQUE("league_id","provider_code","team_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" "export_job_status" DEFAULT 'PENDING' NOT NULL,
	"artifact_uri" text,
	"artifact_checksum" text,
	"validation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_jobs_draft_provider_unique" UNIQUE("draft_id","provider_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_job_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"recommended_target_slot" text,
	"status" "reconciliation_item_status" DEFAULT 'PENDING' NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"team_id" uuid,
	"recipient_email" text NOT NULL,
	"status" "report_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"sent_at" timestamp with time zone,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_team_mappings" ADD CONSTRAINT "provider_team_mappings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_team_mappings" ADD CONSTRAINT "provider_team_mappings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_export_job_id_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_delivery_attempts" ADD CONSTRAINT "report_delivery_attempts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_delivery_attempts" ADD CONSTRAINT "report_delivery_attempts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
