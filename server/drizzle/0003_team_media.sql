-- Migration: Team presentation media (F-MOD-015)
-- Team icon + optional nomination MP3, and a per-draft "already played" flag.

--> statement-breakpoint
ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "icon_url" text,
  ADD COLUMN IF NOT EXISTS "nomination_audio_url" text;

--> statement-breakpoint
ALTER TABLE "draft_team_states"
  ADD COLUMN IF NOT EXISTS "nomination_audio_played" boolean NOT NULL DEFAULT false;
