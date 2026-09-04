-- Migration: per-team name-lock flag (F-MOD-010)
-- Distinct from leagues.name_lock (added in 0006) — this one lets the
-- commissioner prevent a specific team's owner from renaming their team.

--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "name_lock" boolean NOT NULL DEFAULT false;
