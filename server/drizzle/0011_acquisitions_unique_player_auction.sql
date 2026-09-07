-- Migration: unique constraint on acquisitions.player_auction_id (code-review
-- P1 fix — defense in depth against double-resolving the same player
-- auction; the app-level fix is an atomic conditional UPDATE in
-- awardAuction, this is the DB-level backstop).

--> statement-breakpoint
ALTER TABLE "acquisitions" ADD CONSTRAINT "acquisitions_player_auction_id_unique" UNIQUE ("player_auction_id");
