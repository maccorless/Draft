ALTER TABLE "auction_configurations"
  ADD COLUMN "anti_snipe_mode" varchar(20) NOT NULL DEFAULT 'INFORMATIONAL',
  ADD COLUMN "anti_snipe_qualifying_bids" integer NOT NULL DEFAULT 3,
  ADD COLUMN "anti_snipe_penalty_duration_auctions" integer NOT NULL DEFAULT 3,
  ADD COLUMN "anti_snipe_penalty_min_seconds_required" integer NOT NULL DEFAULT 5;

ALTER TABLE "draft_team_states"
  ADD COLUMN "anti_snipe_strike_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "anti_snipe_penalty_auctions_remaining" integer NOT NULL DEFAULT 0,
  ADD COLUMN "anti_snipe_penalty_min_seconds_required" integer;
