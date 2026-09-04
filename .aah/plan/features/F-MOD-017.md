## Id
- F-MOD-017

## Title
- Auction close card and player detail popover

## Module Ref
- MOD-017

## Description
Two Draft Room enhancements, neither of which exists anywhere in the codebase today, built in
React 18 + TypeScript against the existing `web/src/screens/draft-room/index.tsx` component and its
`useAuctionSocket` hook (`web/src/lib/useAuctionSocket.ts`): (1) an ephemeral **Auction Close Card**
per PRD.md §29, and (2) a dismissible **player detail popover** per
`screen-information-architecture.md` §3 ("Draft Room — Optional Expandable Player Detail").

This project is a brownfield iteration-2 gap-fill module: there is no `design-spec.yaml` or
wireframe set for it (those files do not exist in `.aah/architecture/`). Follow the CSS
custom-property design language already established in `web/src/screens/draft-room/draft-room.css`
and `web/src/screens/war-room/war-room.css` (`var(--color-*)`, `var(--space-*)`, `var(--radius-*)`,
`var(--font-*)`, `var(--text-*)`) — do not introduce new hardcoded colors/spacing/fonts, and do not
invent a design system that isn't already in use.

**(1) Auction Close Card.** Triggered by the `PLAYER_AWARDED` WS broadcast that
`web/src/screens/draft-room/index.tsx` already reacts to (see `ws.recentAwards`, populated by the
`PLAYER_AWARDED` case in `useAuctionSocket.ts` around line 193, which also already updates
`state.teams[winning_team_id].remaining_budget_minor`). Show it non-blockingly (an overlay/toast,
not a route change or modal that steals focus) for ~2-4 seconds per PRD.md §29, then auto-dismiss,
while nomination flow continues underneath exactly as it does today when `auction` becomes `null`
and the "Your turn to nominate" / "Waiting for the next nomination…" states render
(`draft-room/index.tsx` around line 269-310) — the card must never delay or block that render.

Required fields per PRD.md §29: player, winning team, winning price, Primary AAV difference,
accepted-bid count, unique-bidder count, and the winning team's remaining budget. Today's
`PLAYER_AWARDED` payload (`server/src/auction/engine.ts`, constructed ~line 958-974 and broadcast
~line 1007-1017) carries only `player_name`, `winning_team_id`, `price_minor`, `roster_slot`, and
`resolution_sequence` — it has none of the AAV/bid-count/bidder-count/budget fields. The bid ladder
the client keeps client-side (`bidLadder` in `useAuctionSocket.ts`) is capped at 10 entries and is
cleared to `[]` on `PLAYER_AWARDED`, so it cannot reliably supply accepted-bid count or
unique-bidder count for auctions with more bids than that cap — these must be computed
server-side, inside the same resolution transaction in `engine.ts` that already has `auctionId`
and `draftId` in scope (`COUNT(*)` and `COUNT(DISTINCT team_id)` over accepted `bid_attempts` rows
for that `player_auction_id`, per the `BidAttempt` schema in `data-model.md` §3.3), and added to the
`PLAYER_AWARDED` payload alongside the winning team's post-award `remaining_budget_minor` (already
computed in the same transaction) and the auction's AAV (`aav_minor` on the auction being resolved
— pre-MOD-016 this is the dataset's single AAV value; treat it as "Primary AAV" so the diff
computation does not need to change once MOD-016's primary/secondary AAV source selection lands).
The close card computes and displays the AAV difference as `price_minor - aav_minor` (over/under).

**(2) Player detail popover.** Clicking the active player's name (the element rendered with
`data-testid="active-player-name"` in `draft-room/index.tsx`) opens a dismissible side panel or
popover — per the IA spec, containing prior-season stats, projections, injury detail/freshness, all
visible AAVs, the owner's Target if set, tier, and comparable remaining players. Dismissing it must
not disrupt the underlying auction state or disable the bid controls (`draft-room__bid-controls`)
rendered beneath/behind it.

Ground each field in what the codebase already exposes today, since prior-season stats, injury
detail/freshness, and multi-source AAVs are MOD-016 fields that do not exist yet (MOD-017 depends
only on MOD-002, not MOD-016):
- **Available today, populate now:** tier and AAV, from the same `CurrentAuction` shape
  (`auction.tier`, `auction.aav_minor`) the Draft Room and War Room already read; projected points
  (`auction.projected_points`), rendered the same way War Room's existing Zone A "Player
  Intelligence" panel does it (`web/src/screens/war-room/index.tsx` ~line 312-358, `.toFixed(1)`);
  owner's Target, by calling the existing `GET /drafts/:id/teams/:teamId/target-values` endpoint
  (MOD-008) exactly as War Room's `refreshTargets`/`myTarget` does (`war-room/index.tsx`
  ~line 180-197) — omit the Target row entirely when no custom target is set, matching the existing
  "avoid a redundant My Target" convention; comparable remaining players, selected mechanically the
  same way War Room's `tierBoard`/Draft Room's `scarcity` already do (same `position` + same `tier`
  from the `players` dataset list, excluding already-drafted names via `ws.recentAwards`).
- **Not available yet, structure for MOD-016 to slot in without a rewrite:** prior-season stats,
  injury detail/freshness, and any AAV sources beyond the single `aav_minor` value. Render the
  popover's content as a list/section per field group (not a single flat string) so that when
  MOD-016 lands its `players.prior_season_stats`, `injury_status`/`injury_detail`/
  `injury_updated_at`, and multi-row `player_aav_sources` data, those sections can be filled in
  without restructuring the component. State plainly in the popover (or simply omit the row) when a
  MOD-016 field is not yet present rather than rendering a placeholder implying it's missing data
  for this specific player.

**Behavioral expectations:**
- Given a `PLAYER_AWARDED` broadcast arrives on the Draft Room's WS connection, when the client
  processes it, then an Auction Close Card renders showing the player name, winning team name,
  winning price, Primary AAV difference, accepted-bid count, unique-bidder count, and the winning
  team's remaining budget.
- Given the Auction Close Card is showing, when 2-4 seconds elapse, then it auto-dismisses without
  any user interaction required.
- Given the Auction Close Card is showing, when the next `NOMINATION_STARTED` (or
  `NOMINATION_TURN_CHANGED`) broadcast arrives, then the Draft Room's active-auction / nomination
  UI renders immediately and is not delayed, blocked, or hidden by the card.
- Given the resolution transaction in `server/src/auction/engine.ts` awards a player, when it
  commits, then the broadcast `PLAYER_AWARDED` payload includes `accepted_bid_count` (count of
  accepted `bid_attempts` rows for that `player_auction_id`), `unique_bidder_count` (count of
  distinct `team_id` among those accepted attempts), the awarded auction's AAV, and the winning
  team's post-award `remaining_budget_minor` — each computed within that same transaction, not
  derived from the client's capped `bidLadder`.
- Given an auction closes with more than 10 total bids, when the close card renders, then the
  accepted-bid count and unique-bidder count still reflect the true totals (proving they are not
  sourced from the 10-entry client-side `bidLadder`).
- Given an active player is on screen in the Draft Room, when the owner clicks that player's name,
  then a dismissible detail panel/popover opens showing tier, AAV, projections, the owner's Target
  (only if one is set for that player), and a mechanically-selected list of comparable remaining
  players (same position and tier, not yet drafted).
- Given the detail popover is open, when the owner dismisses it, then the popover closes and the
  Draft Room's bid controls (+$1, custom bid, Match) remain visible and interactive with no loss of
  in-progress state (e.g., a partially typed custom bid amount).
- Given MOD-016's player-intelligence fields (prior-season stats, injury detail/freshness, multi-source
  AAVs) are not yet present on the player/auction data the popover reads, when the popover renders,
  then it shows only the fields available today (tier, AAV, projections, Target, comparables) without
  rendering broken/placeholder rows for the missing fields, and its structure allows those fields to
  be added later without a rewrite.
- Given the detail popover or close card is rendered, when interacted with via keyboard, then the
  dismiss control is a semantic, keyboard-operable element (e.g. `<button>`), not a bare
  `<div onClick>`.

## Layers
- api
- ui

## Dependencies
- F-MOD-002

## Test Config

- command: DATABASE_URL=postgres://draft:draft_local_dev@localhost:5432/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! npx vitest run --project node server/src/__tests__/F-MOD-017_close_card_and_popover.test.ts --project web web/src/__tests__/F-MOD-017_close_card_and_popover.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-017_close_card_and_popover.test.ts
  - web/src/__tests__/F-MOD-017_close_card_and_popover.test.tsx

## Lint Config

## Constraints

## Required Env Variables

## Status
done
