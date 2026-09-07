-- Migration: Whammy definitions + auto-trigger support (F-MOD-009-rework-01,
-- PRD §33, state-machine-flows.md §16, data-model.md §18.2-18.3)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whammy_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "league_id" uuid NOT NULL REFERENCES "leagues"("id"),
  "name" text NOT NULL,
  "type" text NOT NULL,
  "budget_delta_minor" integer,
  "trigger_rule_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "display_message" text NOT NULL,
  "offline_action_text" text,
  "weight" integer NOT NULL DEFAULT 1,
  "active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
ALTER TABLE "whammy_events" ALTER COLUMN "team_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "whammy_events" ADD COLUMN IF NOT EXISTS "definition_id" uuid REFERENCES "whammy_definitions"("id");
--> statement-breakpoint
ALTER TABLE "whammy_events" ADD COLUMN IF NOT EXISTS "trigger_event_sequence" integer;
