ALTER TABLE "bid_attempts"
  ADD COLUMN "client_click_time_ms" integer,
  ADD COLUMN "client_displayed_bid_minor" integer,
  ADD COLUMN "client_auction_version" integer;
