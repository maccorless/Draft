-- Migration: Commissioner League Setup and Readiness Checklist (F-MOD-010)
-- Adds league identity/scheduling/status fields, an optional Host login
-- credential, and a per-team starting-budget override.

--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "host_password_hash" text;
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "logo_url" text;
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "name_lock" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "scheduled_draft_start_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "status_message" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "starting_budget_override_minor" integer;
