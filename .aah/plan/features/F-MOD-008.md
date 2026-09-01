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
implementing
