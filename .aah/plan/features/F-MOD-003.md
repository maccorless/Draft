## Id

F-MOD-003

## Title

WebSocket Session Reconnect and Multi-Draft Isolation

## Module Ref

MOD-003

## Description

MOD-003 implements WebSocket session management on top of the auction engine established by MOD-002. It has two primary jobs: (1) restore exact draft state for any client that reconnects after a drop or server restart, and (2) enforce strict per-draft isolation so that two concurrent drafts on different leagues cannot bleed state into each other. The full system context is described in `.aah/architecture/architecture-overview.md` §2 and §5, the reconnect sequence is specified in `.aah/architecture/application-flow.md` §7, and the entity shapes this module reads (DraftTeamState, PlayerAuction, DraftEvent) are defined in `knowledge/data-model.md`.

**Backend — server/src/session/** (Node.js 20 + Fastify 4.x + TypeScript):

The in-memory session registry is `DraftClientSession`: a `Map<draft_id, Map<team_id, Set<ws>>>`. On every new WebSocket connection the handler verifies the JWT using `@fastify/jwt`, then immediately re-reads `auth_epoch` from PostgreSQL (never from the token payload) to detect revocation per the pattern established in MOD-000 and repeated here on every command — described in `.aah/architecture/application-flow.md` §2. If the epoch is valid, the server queries the full current draft state and the DraftEvent tail since the client's `last_seen_sequence`, sends a `STATE_SNAPSHOT` event, and replays missed events in sequence order before registering the client in the broadcast set.

Multi-window identity: multiple browser tabs belonging to the same `team_id` are tracked as a `Set<ws>` under the same team key. Every broadcast fans out to all members of the set, so tabs stay synchronized without special handling by the caller.

Per-command isolation: every command handler independently verifies that the command's `draft_id` routes to the correct draft AND that the JWT's `league_id` equals `draft.league_id`. These are two independent checks — routing alone is not the isolation mechanism (see `knowledge/CLAUDE.md` constraint #11 and `.aah/architecture/architecture-overview.md` §5). A mismatch on either returns `{type: "ERROR", code: "AUTH_ERROR"}` and the command is dropped without touching any draft state. All draft state, command queues, and broadcast groups remain keyed by `draft_id`, never a module-level singleton.

**REST endpoints** (added to the existing Fastify server — see `.aah/architecture/schema/MOD-003-api-schema.yaml` for the full OpenAPI spec):

- `GET /leagues/{leagueId}/drafts` — lists all drafts for a league; used by the lobby screen to populate the reconnect/join flow.
- `GET /drafts/{draftId}/state` — returns a full `DraftStateSnapshot` (REST fallback; the WS `STATE_SNAPSHOT` is the preferred delivery path).

**Frontend — web/src/ws/** (React 18 + Vite 5 + TypeScript):

The WS client lives in `web/src/ws/`. On WebSocket close, the client immediately shows a "Reconnecting..." banner in the Draft Room and War Room screens and begins exponential-backoff reconnect attempts: 1 s, 2 s, 4 s, capped at 5 s, cycling until the connection is restored. On reconnect, the client sends `{type: AUTHENTICATE, payload: {token, last_seen_sequence}}`. Once the server confirms and delivers the snapshot, the banner is dismissed and the draft state is restored to exactly what it was before the drop. If the reconnected draft is `PAUSED` with reason `SERVER_RESTART`, the client replaces the reconnect banner with "Draft paused — waiting for commissioner."

The Commissioner Console receives a pause notification component that displays when the draft status is `PAUSED` and `paused_reason` is `SERVER_RESTART`, giving the commissioner an explicit signal before they resume.

**Behavioral expectations:**

- Given a client has an active WS connection and drops it (tab close, network loss), when the client reconnects and sends `AUTHENTICATE` with its `last_seen_sequence`, then the server responds with a `STATE_SNAPSHOT` containing all current `DraftTeamState[]`, the active `PlayerAuction` (or null), `auction_version`, `rebid_deadline_ts`, and the count of replayed events, and the client displays the correct draft state with no manual action.
- Given a reconnecting client sends `last_seen_sequence` for events it already received, when the server computes missed events by querying `DraftEvent WHERE sequence > last_seen_sequence ORDER BY sequence ASC`, then only genuinely missed events are replayed and none are duplicated.
- Given any team member opens a second browser tab (same JWT, same `team_id`), when the server receives the second AUTH, then it adds the new ws to the existing `Set<ws>` under that `team_id`, and every subsequent broadcast reaches both tabs simultaneously.
- Given a broadcast is sent for a draft (BID_ACCEPTED, PLAYER_AWARDED, etc.), when the module fans out to `Map<team_id, Set<ws>>`, then every WebSocket in every team's set receives the event, including multi-window connections.
- Given a client sends any command carrying a `league_id` that does not match `draft.league_id`, when the command handler performs the per-command auth check, then the server returns `{type: "ERROR", code: "AUTH_ERROR"}` and the command is not enqueued or applied.
- Given two concurrent drafts exist for two different leagues in the same server process, when each draft receives bids and nomination events, then each draft's `DraftClientSession` set, in-memory state, and broadcast group are fully isolated — no event from draft A reaches any client registered for draft B.
- Given the server restarts while a draft is in `RUNNING` status, when the process starts up (crash recovery from MOD-000), then the draft is already set to `PAUSED` before the WS server begins accepting connections; any client that then connects receives a `STATE_SNAPSHOT` with `status: "PAUSED"` and the client shows "Draft paused — waiting for commissioner."
- Given a client reconnects to a PAUSED draft after a server restart, when the `STATE_SNAPSHOT` is delivered, then the Draft Room and War Room screens display a "Draft paused — waiting for commissioner" message in place of the "Reconnecting..." banner.
- Given the Commissioner Console is open when a draft enters PAUSED with `paused_reason = SERVER_RESTART`, when the state snapshot reaches the console, then a pause notification component is rendered, distinguishing this from a commissioner-initiated pause.
- Given a WS connection is established but the client never sends an AUTH message, when approximately 5 seconds elapse, then the server closes the connection (established by MOD-000 skeleton; confirmed to hold here).
- Given `GET /leagues/{leagueId}/drafts` is called with a valid bearer JWT, when the handler processes the request, then it returns `{drafts: DraftSummary[]}` where each entry includes `id`, `league_id`, `status`, and optional `started_at`/`completed_at` timestamps.
- Given `GET /drafts/{draftId}/state` is called with a valid bearer JWT, when the handler processes the request, then it returns a `DraftStateSnapshot` with `draft_id`, `status`, `teams` (array of `TeamStateEntry` with `remaining_budget_minor` and `control_mode`), and `current_auction` (null if no auction is active).
- Given any environment variable in `## Required Env Variables` is absent at startup, when the env checker runs before any module reads configuration, then the server exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable and pointing to `cp .env.example .env`; each variable is also present in `.env.example` with a safe placeholder.

## Layers

- api
- ui

## Dependencies

- F-MOD-002

## API Contracts

```yaml
produces:
  - operation_id: listDrafts
    schema_file: schema/MOD-003-api-schema.yaml
    request_schema: null
    response_schema: "{ drafts: DraftSummary[] }"

  - operation_id: getDraftState
    schema_file: schema/MOD-003-api-schema.yaml
    request_schema: null
    response_schema: DraftStateSnapshot
```

## Required Env Variables

- DATABASE_URL — PostgreSQL connection string (re-read for auth_epoch on every WS AUTH and command)
- JWT_SECRET — JWT signing key (used to verify bearer tokens on WS connect and REST calls)
- NODE_ENV — Runtime environment

## Lint Config

## Test Config

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-003_session.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-003_session.test.ts

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
