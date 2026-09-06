## Id

F-MOD-008

## Title

Owner Strategy Tools and War Room Screen

## Module Ref

MOD-008

## Description

This module delivers the owner-facing private strategy layer and the War Room second-screen view for the Draft platform (Node.js 20 + Fastify 4.x backend, React 18 + Vite 5 frontend, PostgreSQL + Drizzle ORM, Zod-validated shared-types). The authoritative entity definitions are in `.aah/architecture/data-model.md` §3 (OwnerTargetValue, WatchListItem, NominationQueueItem, NominatorMatch) and the full module context is in `.aah/architecture/module-map.yaml` (id: MOD-008). Application flow context is in `.aah/architecture/application-flow.md`.

**What the module does end to end:**

Three Drizzle-managed tables are added: `OwnerTargetValue` (private integer target bids per player per team per draft), `WatchListItem` (team's manually curated interest list; never auto-nominates), and `NominationQueueItem` (ordered auto-nominate queue; lowest `queue_position` is nominated first when it is the owner's turn). All three are scoped to `(draft_id, team_id)` and are keyed by `draft_id` — no module-level singletons — consistent with the isolation rule in `resolved-standards.yaml` (EXTRACTED-007).

Five REST endpoints are implemented under `server/src/draft/strategy.ts` and registered on the Fastify instance with the existing JWT `preHandler` auth hook (auth_epoch re-read from DB on every command, as established by MOD-000). Every endpoint enforces that `token.team_id == :teamId` before reading or writing; a mismatch returns 403. League isolation is additionally enforced: `token.league_id` must match `draft.league_id` on every request (dual-layer isolation per architecture-overview.md §5).

The War Room screen (`web/src/screens/war-room/`) is a second-screen view for the same owner. It opens a standard WS connection to the same draft endpoint that the Draft Room uses, sending the same JWT in the AUTH message. The server identifies `team_id` from the token, adds the new socket to the existing `Set<ws>` for that team in `DraftClientSession`, and fans out all broadcasts identically — no special War Room handshake or endpoint is needed (confirmed by `MOD-008-api-schema.yaml` `x-websocket-events` note and by the module-map `api` layer: "same DraftEvent stream as Draft Room; no extra endpoints"). The War Room screen renders: live bid display (current player, current bid, time remaining from `deadline_ts`), player tiers derived from dataset AAVs, historical bid analytics (awarded players with prices, per-team spend from `DraftTeamState`), and a budget tracker per team.

The strategy panel (`web/src/screens/draft-room/StrategyPanel.tsx`) is a sidebar in the Draft Room that renders the Target Values table, Watch List, and Nomination Queue for the logged-in owner. Target values are fetched from the REST API and displayed alongside each player's AAV from the frozen dataset; if no target is set for a player, no "My Target" column is shown for that row (EXTRACTED-019). Watch List and Nomination Queue are also fetched from REST and updated via REST; the Nomination Queue supports drag-to-reorder (sending `reorderNominationQueue` with the new `ordered_player_ids` array).

All `target_value_minor` data is read from and written to the DB only for the authenticated team's session. It is never included in any WS broadcast payload. The `OwnerTargetValue` table has no WS event associated with it.

**Behavioral expectations:**

- Given an owner sends `GET /drafts/:draftId/teams/:teamId/target-values` with a valid JWT where `token.team_id == :teamId`, when the handler runs, then the response contains only that team's `OwnerTargetValue` rows for that draft and the HTTP status is 200; the payload is never present in any WS broadcast to any other team.
- Given an owner sends `PUT /drafts/:draftId/teams/:teamId/target-values` with a valid `SetTargetValuesRequest` body, when the handler runs, then the rows are upserted (insert or update by `(draft_id, team_id, dataset_player_id)`) and a 200 is returned; no WS event is emitted.
- Given a request where `token.team_id != :teamId` in the URL (attempting to read or write another team's target values), when the handler runs, then the server returns 403 and no data is read or written.
- Given an owner sends `POST /drafts/:draftId/teams/:teamId/watchlist` with a valid `player_id`, when the handler runs, then a `WatchListItem` row is created and 201 is returned; the Watch List item never causes an automatic nomination regardless of the draft's nomination state.
- Given an owner sends `DELETE /drafts/:draftId/teams/:teamId/watchlist/:playerId`, when the handler runs, then the row is deleted (or returns 204 if already absent); no nomination is affected.
- Given an owner sends `GET /drafts/:draftId/teams/:teamId/watchlist`, when the handler runs, then all `WatchListItem` rows for that team/draft are returned with `player_id`, `player_name`, and `position`.
- Given an owner sends `PUT /drafts/:draftId/teams/:teamId/nomination-queue` with `ordered_player_ids`, when the handler runs, then `queue_position` values are updated to match the submitted order (position 0 = first to nominate) and 200 is returned.
- Given an owner sends `GET /drafts/:draftId/teams/:teamId/nomination-queue`, when the handler runs, then items are returned ordered by ascending `queue_position`.
- Given it is a team's nomination turn and their `NominationQueue` is non-empty, when the nomination timer expires without an explicit `NOMINATE_PLAYER` command, then the server (MOD-002's auto-nominate logic, triggered by this module's data) nominates the player at position 0 of the queue; this module's responsibility is only to supply the ordered queue rows.
- Given an owner opens the War Room in a second browser tab with the same JWT, when the WS AUTH message is processed, then the server adds the new socket to the existing `Set<ws>` for `team_id` in `DraftClientSession` (MOD-003 behavior); the War Room screen receives the full state snapshot on connect and all subsequent `DraftEvent` broadcasts in the same seq-numbered envelope format defined in `shared-types/src/protocol.ts`.
- Given the War Room screen is open while an auction is live, when a `BID_ACCEPTED` or `PLAYER_AWARDED` event arrives over WS, then the live bid display updates within one render cycle to show the current player name, current bid in dollars, and a countdown derived from `deadline_ts`; the lag from server broadcast to visible UI update must be below 200ms on a local network (matching the bid pipeline target in architecture-overview.md §2).
- Given the War Room screen is open, when it renders, then it displays: (a) the current active `PlayerAuction` with bid and timer, (b) a per-team budget tracker sourced from the `DraftTeamState` payload in the snapshot, (c) historical awarded players with prices from prior `PLAYER_AWARDED` events received since connect or replayed from the event tail in the snapshot, and (d) player tiers grouped by dataset AAV bands from the snapshot's player list.
- Given the Draft Room's strategy panel sidebar is rendered for an authenticated owner, when it loads, then it calls `getTargetValues`, `getWatchList`, and `getNominationQueue` in parallel and renders each list; an empty list renders as an empty state with an add-player affordance, not an error.
- Given the strategy panel is rendered and the owner has no target value set for a player visible in the panel, when that player row renders, then no "My Target" cell or column is shown for that row (per EXTRACTED-019).
- Given the server boots, when `NODE_ENV`, `DATABASE_URL`, and `JWT_SECRET` are checked by the startup env checker (registered in MOD-000), then if any variable is absent the server exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable; this module adds no new env variables but reads all three transitively through Drizzle and the JWT plugin.

**Post-launch gap-review additions (War Room enrichment):**

The following extend the War Room screen (`web/src/screens/war-room/index.tsx`) and its two supporting read endpoints (`server/src/draft/war-room.ts`). They wire up or surface data that already exists server-side; only the recent-activity response payload gains new fields — no new tables and no new WS event types are introduced by this module.

- **Do Not Draft tab.** The "My Preparation" panel gains a fourth tab, alongside Watch/Queue/Targets, that calls the existing `GET/POST/DELETE /drafts/:draftId/teams/:teamId/do-not-draft` endpoints (owned and already implemented by F-MOD-014's `server/src/draft/do-not-draft.ts`; this module only adds the War Room UI and consumes them — see `## API Contracts` `consumes`). Given the tab is opened, when it loads, then it calls the list endpoint and renders each entry with a remove control; an empty list renders an empty state, not an error. Given the active auction's player is not already on the team's Do Not Draft list, when the tab is open, then a "+ Do Not Draft <player>" affordance is shown, mirroring the existing add-affordance pattern used by the Watch/Queue tabs; adding or removing never triggers a nomination and is never broadcast (per F-MOD-014's privacy posture, same as `OwnerTargetValue`).
- **Market Context: AAV-baseline comparison and remaining-by-tier.** The Market Context panel (Zone: Market Context) adds (a) an actual-spend-vs-AAV comparison — total `price_minor` actually paid across `recent` activity rows vs. the sum of each row's primary-source `aav_minor` at time of sale, shown as both a dollar difference and a percentage (e.g. "Actual vs ESPN +4.4%") — and (b) a "remaining players by tier" breakdown, grouped from the already-fetched dataset player list (`GET /leagues/:leagueId/players`) filtered to players not yet awarded (the same `drafted` set the panel already derives from `ws.recentAwards`), counted per `tier`. Both are computed client-side from data already fetched by the screen; no new endpoint is required. Given no players have been awarded yet, when Market Context renders, then the AAV-baseline comparison shows $0 / 0% rather than an error or NaN.
- **Recent Activity: unique bidders and AAV difference.** `GET /drafts/:draftId/activity` (`server/src/draft/war-room.ts`) is extended to return, per recent-activity row, `unique_bidder_count` (distinct `team_id` values among accepted `BidAttempt` rows for that `PlayerAuction`, the same `COUNT(DISTINCT team_id)` computation `server/src/auction/engine.ts` already performs for the `PLAYER_AWARDED` event payload's `unique_bidder_count`) and `aav_diff_minor` (`price_minor` minus that player's primary-source `aav_minor` at resolution time, joined the same way `resolveEffectivePrimarySource`/`player_aav_sources` is already joined elsewhere in this file). The War Room activity list renders both: "`N` bids · `M` bidders" and a signed AAV-difference amount next to the sale price. Given a player was awarded with zero competing bids beyond the opener, when the activity list renders that row, then `unique_bidder_count` is 1 (the winner), not 0, matching the existing `PLAYER_AWARDED`-event convention.
- **Player Intelligence: prior-season stats.** Zone A (Player Intelligence) renders the active player's `prior_season_stats` (already returned by `GET /leagues/:leagueId/players`, already fetched into the screen's `players` state, and already rendered by the Draft Room's player detail popover, `web/src/components/PlayerDetailPopover.tsx`) using the same key/value list presentation that popover already uses. Given the active player's `prior_season_stats` is null or an empty object, when Zone A renders, then the prior-season-stats block is omitted entirely, not shown as an empty table (matching the popover's existing convention).
- **Comparable Remaining: projection and My Target columns.** The "Comparable Remaining" table (Zone B) adds a "Proj" column (`projected_points`, already present per row in the fetched player list) and a "My Target" column showing the viewing team's `target_value_minor` for that row's player when one exists in the already-fetched `targets` state, blank otherwise (never a `$0` placeholder, consistent with EXTRACTED-019's "no column when unset" convention already applied elsewhere in this module).
- **Watch List: AAV, customized-Target flag, status columns.** The Watch tab's list adds the player's `aav_minor` (already returned by `GET /drafts/:draftId/teams/:teamId/watchlist` — the endpoint already includes it; only the UI was not rendering it), a flag indicating the viewing team has a customized target for that player (cross-referenced against the already-fetched `targets` state, not a new field), and the player's injury/availability status (already present per player in the fetched player list as `injury_status`). No backend change is required for this item.
- **Nomination Queue: opening price and availability columns.** The Queue tab's list adds an opening-price column (the draft's configured `min_bid_minor` from `GET /drafts/:draftId/config`, already fetched by the screen but not yet stored/used — one value applies to every queued player, since opening price is a draft-wide auction setting, not a per-player one) and an availability column (whether the player has already been drafted, from the same `drafted` set derived from `ws.recentAwards` that other panels already use). No backend change is required.
- **Targets tab toggle.** The Targets tab adds a two-state toggle: "Customized only" (current/default behavior, listing only rows the team has set a `target_value_minor` for) and "All tracked players" (every dataset player, showing target value where set and blank where not). Given the toggle is set to "All tracked players", when the tab renders, then it merges the fetched `targets` rows with the full player list by `dataset_player_id`, and a player with no target set shows no target-value cell (per EXTRACTED-019), not a `$0` cell.
- **League Roster/Budget Grid: position-focus highlighting.** When an auction is active (`auction.position` known), the grid optionally highlights (a) teams with an open compatible starter slot for that position and (b) the team(s) with the highest `remaining_budget_minor`, using data the grid already has (`rosterSlots`, `rosterGrid`). This is visual emphasis only — it never reorders rows, and it is included only insofar as it composes cleanly with the grid's existing rendering; it must not block or complicate the higher-priority items above.
- **Whammy toast/notification.** When a WHAMMY_APPLIED-class `DraftEvent` (added by MOD-002's rework to the same WS event stream this screen already connects to via `useAuctionSocket`) arrives over the War Room's WS connection, the screen shows a dismissible toast/notification describing the effect, mirroring however the Draft Room (a separate module) surfaces the same event — this module does not define the event shape or trigger logic, only consumes and displays it. Given the WS connection has not yet been extended with this event (i.e. MOD-002's rework has not landed), when no such event is ever received, then no toast ever renders and nothing else in the screen is affected — this is additive, not a dependency gate.
- **Anti-snipe penalty indicator.** When a penalty-status signal for a team (added by MOD-002's rework anti-snipe rework to the same WS stream) arrives, the War Room surfaces a small indicator (e.g. on that team's row in the Roster/Budget Grid) showing the affected team is under a bid penalty, for as long as the signal indicates the penalty is active. This module consumes and displays the signal only; it never computes penalty eligibility, duration, or mode — that logic and its qualifying-bid counter live entirely in MOD-002's rework.

## Layers

- db
- api
- ui

## Dependencies

- F-MOD-002

## API Contracts

```yaml
produces:
  - operation_id: getTargetValues
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: null
    response_schema: TargetValueList

  - operation_id: setTargetValues
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: SetTargetValuesRequest
    response_schema: null

  - operation_id: getWatchList
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: null
    response_schema: WatchListResponse

  - operation_id: addToWatchList
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: WatchListAddRequest
    response_schema: null

  - operation_id: removeFromWatchList
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: null
    response_schema: null

  - operation_id: getNominationQueue
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: null
    response_schema: NominationQueueResponse

  - operation_id: reorderNominationQueue
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: ReorderQueueRequest
    response_schema: null

  - operation_id: getRecentActivity
    schema_file: schema/MOD-008-api-schema.yaml
    request_schema: null
    response_schema: RecentActivityResponse
    note: >
      Gap-review extension: GET /drafts/:draftId/activity (server/src/draft/war-room.ts)
      response rows gain unique_bidder_count and aav_diff_minor. Existing fields
      (acquisition_id, player_name, position, price_minor, resolution_sequence,
      team_id, team_name, awarded_at, bid_count) are unchanged.

consumes:
  - operation_id: listDoNotDraft
    schema_file: schema/MOD-014-api-schema.yaml
    request_schema: "(none)"
    response_schema: DoNotDraftListResponse

  - operation_id: addDoNotDraft
    schema_file: schema/MOD-014-api-schema.yaml
    request_schema: AddDoNotDraftRequest
    response_schema: DoNotDraftEntry

  - operation_id: removeDoNotDraft
    schema_file: schema/MOD-014-api-schema.yaml
    request_schema: "(none)"
    response_schema: "204 No Content"
```

## Required Env Variables

- DATABASE_URL — PostgreSQL connection string
- JWT_SECRET — JWT signing key
- NODE_ENV — Runtime environment

## Lint Config

Before writing any application code, for each root below: create its manifest first, then run
`aah run core.scaffold.project ensure-lint-config --project-path "$PROJECT_DIR" --package-root <root> --install`
— it reads the manifest to pick the linter, writes the config, adds the linter to dev dependencies
and installs it, and never clobbers an existing config. Where a source path is given, copy that file
into the root first, then run the same command. Commit the configs with this module.

- server — default
- web — default

## Test Config

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-008_owner_strategy.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-008_owner_strategy.test.ts

## Constraints

## Applicable Standards
- Total rules: 68
- Critical:
  - EXTRACTED-022
  - EXTRACTED-046
  - TS-SEC-001
  - TS-SEC-002
  - RX-SEC-001
  - RX-SEC-002
  - PG-SEC-001
- High:
  - EXTRACTED-001
  - EXTRACTED-002
  - EXTRACTED-003
  - EXTRACTED-004
  - EXTRACTED-005
  - EXTRACTED-006
  - EXTRACTED-007
  - EXTRACTED-008
  - EXTRACTED-010
  - EXTRACTED-011
  - EXTRACTED-012
  - EXTRACTED-013
  - EXTRACTED-014
  - EXTRACTED-015
  - EXTRACTED-020
  - EXTRACTED-021
  - EXTRACTED-023
  - EXTRACTED-024
  - EXTRACTED-025
  - EXTRACTED-026
  - EXTRACTED-029
  - EXTRACTED-032
  - EXTRACTED-033
  - EXTRACTED-034
  - EXTRACTED-035
  - EXTRACTED-036
  - EXTRACTED-038
  - EXTRACTED-040
  - EXTRACTED-041
  - EXTRACTED-042
  - EXTRACTED-043
  - EXTRACTED-044
  - EXTRACTED-045
  - TS-TYPE-001
  - TS-TYPE-002
  - TS-TEST-001
  - TS-ERR-001
  - RX-ARCH-001
  - RX-ARCH-002
  - RX-A11Y-001
  - PG-SEC-002
  - PG-PERF-001
  - PG-PERF-002
  - PG-DATA-001
  - PG-DATA-002
- Medium:
  - EXTRACTED-009
  - EXTRACTED-016
  - EXTRACTED-017
  - EXTRACTED-018
  - EXTRACTED-019
  - EXTRACTED-027
  - EXTRACTED-028
  - EXTRACTED-030
  - EXTRACTED-031
  - EXTRACTED-037
  - EXTRACTED-039
  - TS-TYPE-003
  - RX-A11Y-002
  - RX-PERF-001
  - PG-PERF-003
- Low:
  - TS-CONV-001

## Status
done
