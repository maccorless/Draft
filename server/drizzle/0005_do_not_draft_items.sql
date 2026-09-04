-- Migration: Do Not Draft (F-MOD-014, PRD §12.3, data-model.md §10.4)
-- Per-team, per-draft private list of players a team's Auto-Agent must never
-- bid on. Never broadcast — same privacy posture as owner_target_values.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "do_not_draft_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "drafts"("id"),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "dataset_player_id" uuid NOT NULL REFERENCES "players"("id"),
  CONSTRAINT "do_not_draft_items_draft_team_player_unique" UNIQUE ("draft_id", "team_id", "dataset_player_id")
);
