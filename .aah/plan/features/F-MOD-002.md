## Id
F-MOD-002

## Title
Live Auction Engine with Bid Pipeline

## Module Ref
MOD-002

## Description
MOD-002 implements the real-time auction engine that is the core of the Draft platform. It is the highest-complexity and highest-risk module: every bid, nomination, award, and roster assignment flows through it. The full system context is in `.aah/architecture/architecture-overview.md` §§2–5; the entity schemas for `PlayerAuction`, `BidAttempt`, `DraftEvent`, `DraftTeamState`, `Acquisition`, `RosterEntry`, and `BudgetLedgerEntry` are in `knowledge/data-model.md`; the state machines, bid-atomicity rules, and nomination/resolution sequences are in `knowledge/state-machine-flows.md` §§4, 8, 10, 24–26; and the end-to-end auction command flow is in `.aah/architecture/application-flow.md` §§3–5.

**Stack:** Node.js 20 LTS + TypeScript + Fastify 4.x backend; native `ws` 8.x WebSockets using the sequence-numbered envelope defined in `shared-types/`; PostgreSQL 15 + Drizzle ORM (hybrid raw-SQL for the bid/resolution transaction, query builder for CRUD); React 18 + Vite 5 + TypeScript frontend; Zod 3.x via `shared-types` for all WS command/event validators.

**DB layer** — introduces and owns the following Drizzle schema tables (all append-only; never hard-deleted): `DraftTeamState` (one row per team per draft; `remaining_budget_minor`, roster counts, `control_mode`), `PlayerAuction` (FSM: PENDING → OPEN → CLOSED → AWARDED; `current_bid_minor`, `current_leader_id`, `auction_version`, `rebid_deadline_ts`), `BidAttempt` (every accepted and rejected attempt; `server_receipt_time`, `accepted` bool), `DraftEvent` (append-only audit log; per-draft sequence counter incremented in the same transaction as its row effect), `Acquisition` (winner + `resolution_sequence` + `active` bool), `RosterEntry` (`acquisition_id`, `roster_slot_id`, `active` bool), and `BudgetLedgerEntry` (`amount_minor`, `entry_type=AWARD`, `active` bool). Indexes must cover `(draft_id, status)` on `PlayerAuction`, `(draft_id, sequence)` on `DraftEvent`, and `(draft_id, team_id)` on `DraftTeamState`.

**API layer** — exposes three REST endpoints (`POST /drafts/:id/start`, `POST /drafts/:id/pause`, `POST /drafts/:id/resume`) and the full WS command/event protocol at `wss://{host}/ws/drafts/{draftId}`. All WS commands are routed through a `Map<draft_id, AsyncQueue>` — one command in-flight per draft at a time. The serialized queue is the primary concurrency guard. `server_receipt_time` is stamped as the very first line of the WS message handler, before any `await` or queue enqueue. Each command handler re-reads `auth_epoch` from the DB unconditionally (never from token payload) before executing. The OTel histogram `bid_pipeline_duration_ms` is recorded for every accepted bid command from WS receipt to broadcast, with a p99 target of < 200 ms. Anti-sniping logic: if `server_receipt_time` falls within the configured final-N-seconds window of `rebid_deadline_ts`, the deadline is extended by the configured number of seconds and `anti_snipe_extended: true` is set in the `BID_ACCEPTED` event. Auto-nomination fires when a team's nomination turn expires and their `NominationQueue` is empty: the system selects `argmax(aav_minor)` from available `PlayerDatasetEntry` rows in the frozen dataset and emits `NOMINATION_STARTED` with `system_nominated: true`.

**UI layer** — implements two screens in `web/src/screens/`:

- **Draft Room** (`web/src/screens/draft-room/`): nomination timer display (driven by `deadline_ts` from the server; 100 ms `setInterval`; never determines outcome), current bid display, bid controls (absolute dollar input, +$1 relative bid button, Pass Nomination button), player card for the active auction, and a roster sidebar showing the team's current assignments and remaining budget. The bid controls must display the calculated `max_legal_bid` (server-computed: `remaining_budget_minor - ($1 reserve × other required remaining roster spots)`) and reject locally any absolute bid that exceeds it before sending.
- **Draft Board** (`web/src/screens/draft-board/`): read-only table of all players in the dataset with their `PlayerAuction` status and award price once resolved. Updates in real time from the WS event stream.

The countdown timer component derives its display value solely from `server_receipt_time`-anchored `deadline_ts` values in WS events. Client-side time never influences award decisions.

**Behavioral expectations:**

- Given a draft with status `CREATED` and a FROZEN dataset attached, when the commissioner sends `POST /drafts/:id/start`, then the draft status transitions to `RUNNING`, a `DraftEvent` row is inserted with type `DRAFT_STARTED` in the same transaction, and all connected WS clients receive the state update.
- Given a `RUNNING` draft, when the commissioner sends `POST /drafts/:id/pause`, then the draft transitions to `PAUSED` and a `DRAFT_PAUSED` event is appended; when `POST /drafts/:id/resume` is sent, then the draft transitions back to `RUNNING` and a `DRAFT_RESUMED` event is appended.
- Given a `POST /drafts/:id/start` from a non-commissioner JWT, then the server returns HTTP 403 without modifying draft state.
- Given a `RUNNING` draft in the nomination window, when a team sends a `NOMINATE_COMMAND` with a valid `player_dataset_entry_id` and `opening_bid_minor >= 100`, then a `PlayerAuction` row is created with status `OPEN`, `nomination_deadline_ts` and `second_bid_deadline_ts` are set from `AuctionConfiguration`, a `DraftEvent` with type `NOMINATION_STARTED` is committed in the same transaction, and a `NOMINATION_STARTED` event is broadcast to all connected clients.
- Given a `RUNNING` draft, when the nominating team's queue is empty and their nomination turn expires, then the server auto-nominates `argmax(aav_minor)` from available `PlayerDatasetEntry` rows and broadcasts `NOMINATION_STARTED` with `system_nominated: true`.
- Given a `RUNNING` draft with an `OPEN` `PlayerAuction`, when a client sends `BID_COMMAND` with `bid_type: ABSOLUTE` and a `bid_amount_minor` that is greater than `current_bid_minor` and within `max_legal_bid`, then: (1) `server_receipt_time` is stamped before any `await`, (2) the command is enqueued in the draft's `AsyncQueue`, (3) after dequeue, `auth_epoch` is re-read from the DB, (4) the DB transaction commits an update to `PlayerAuction.current_bid_minor`, an `INSERT` into `BidAttempt` with `accepted=true`, and an `INSERT` into `DraftEvent` with type `BID_ACCEPTED` and an incremented per-draft sequence, (5) in-memory state is updated only after commit, (6) `BID_ACCEPTED` is broadcast to all connected clients.
- Given a `BID_COMMAND` with `bid_type: RELATIVE` where `expected_current_bid_minor` or `expected_auction_version` does not match server state, then the server rejects the command with a `BID_REJECTED` event carrying a stale-state error code, and no DB rows are modified.
- Given a bid whose `server_receipt_time` falls within the anti-snipe window at the end of `rebid_deadline_ts`, then the `PlayerAuction.rebid_deadline_ts` is extended by the configured seconds within the same transaction, and `BID_ACCEPTED.anti_snipe_extended` is `true`.
- Given an `OPEN` `PlayerAuction` whose `rebid_deadline_ts` has elapsed with at least one accepted bid, when the server's timer fires (polled every ~500 ms), then: (1) `PlayerAuction.status` transitions to `AWARDED`, (2) `resolution_sequence` is assigned, (3) an `Acquisition` row is inserted with `active=true`, (4) a `BudgetLedgerEntry` is inserted with `entry_type=AWARD` and `amount_minor = -price_minor`, (5) `DraftTeamState.remaining_budget_minor` is decremented, (6) the lowest-priority unfilled starter slot is identified and a `RosterEntry` row is inserted — or bench if no starter slot is available — all within a single DB transaction, (7) `DraftTeamState.roster_filled_count` is incremented, (8) a `DraftEvent` of type `PLAYER_AWARDED` is committed in the same transaction, (9) in-memory state is updated after commit, (10) `PLAYER_AWARDED` is broadcast to all connected clients.
- Given a team whose remaining roster spots require a `$1` reserve for each, when computing `max_legal_bid`, then `max_legal_bid = remaining_budget_minor - (required_remaining_spots - 1) * 100`, computed server-side in integer arithmetic with no floating point.
- Given a bid whose `bid_amount_minor` exceeds `max_legal_bid` for that team, then the server rejects the command with `BID_REJECTED` and an appropriate error code; no DB rows are modified and the `BidAttempt` row records `accepted=false`.
- Given a `BID_COMMAND` whose JWT carries a `league_id` that does not match the target draft's `league_id`, then the command is rejected with `AUTH_ERROR` before it enters the command queue.
- Given a revoked token (auth_epoch bumped), when any WS command arrives, then the re-read `auth_epoch` from the DB does not match the token payload's `auth_epoch`, and the command is rejected with an `AUTH_EPOCH_INVALID` error.
- Given an accepted bid command, when the `bid_pipeline_duration_ms` OTel histogram is recorded, then the measured duration from WS receipt to broadcast is recorded and the p99 must remain below 200 ms under normal draft load.
- Given the Draft Room screen renders with an active `PlayerAuction`, when a `BID_ACCEPTED` or `PLAYER_AWARDED` event arrives over the WS connection, then the current bid display, countdown timer, and roster sidebar update within one render cycle without a full-page reload.
- Given the Draft Board screen renders, when any `NOMINATION_STARTED`, `BID_ACCEPTED`, or `PLAYER_AWARDED` event arrives, then the affected player's row updates its status and price in place without requiring a manual refresh.
- Given the countdown timer component receives a `deadline_ts` from a server event, then it drives display via `Date.now()` relative to `deadline_ts` on a 100 ms `setInterval`; reaching zero triggers no server action and awards no player.
- Given a client connects with a JWT to `wss://{host}/ws/drafts/{draftId}` and sends `AUTHENTICATE` as the first message, then the server re-reads `auth_epoch` from the DB and either sends `AUTHENTICATED` or closes the connection with code 4401.
- Given `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV` are all set in the environment, when the server boots, then it passes the env checker and starts normally; given any one of these is absent, then the server exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable before any module reads configuration.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-001

## API Contracts

```yaml
produces:
  - operation_id: startDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: pauseDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: resumeDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: ws_BID_ACCEPTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: BID_COMMAND
    response_schema: BID_ACCEPTED

  - operation_id: ws_BID_REJECTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: BID_COMMAND
    response_schema: BID_REJECTED

  - operation_id: ws_NOMINATION_STARTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: NOMINATE_COMMAND
    response_schema: NOMINATION_STARTED

  - operation_id: ws_PLAYER_AWARDED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: PLAYER_AWARDED

  - operation_id: ws_AUTHENTICATED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: AUTHENTICATE
    response_schema: AUTHENTICATED

  - operation_id: ws_PASS_NOMINATION
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: PASS_NOMINATION
    response_schema: NOMINATION_TURN_CHANGED

  - operation_id: ws_NOMINATION_TURN_CHANGED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: NOMINATION_TURN_CHANGED
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

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-002_auction.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-002_auction.test.ts

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
