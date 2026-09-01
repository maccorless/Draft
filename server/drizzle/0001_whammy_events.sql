-- Migration: Add whammy_events table, extend whammy_configs, add reference_id to budget_ledger_entries
-- F-MOD-009: Commissioner Whammy: Budget Entertainment Events

--> statement-breakpoint
ALTER TABLE "whammy_configs"
  ADD COLUMN IF NOT EXISTS "allow_positive" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "allow_negative" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_per_team" integer,
  ADD COLUMN IF NOT EXISTS "max_per_draft" integer,
  ADD COLUMN IF NOT EXISTS "commissioner_approval_required" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."whammy_event_status" AS ENUM('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'REVERSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whammy_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "draft_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "amount_minor" integer NOT NULL,
  "description" text NOT NULL,
  "status" "whammy_event_status" DEFAULT 'PENDING_APPROVAL' NOT NULL,
  "budget_ledger_entry_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "whammy_events" ADD CONSTRAINT "whammy_events_draft_id_drafts_id_fk"
    FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "whammy_events" ADD CONSTRAINT "whammy_events_team_id_teams_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
ALTER TABLE "budget_ledger_entries"
  ADD COLUMN IF NOT EXISTS "reference_id" uuid;
