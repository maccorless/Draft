## Id
F-MOD-004

## Title
Auto-Agent Mode for Disconnected Teams

## Module Ref
MOD-004

## Description
MOD-004 implements Auto-Agent mode: the MANUAL ↔ AUTO_AGENT control-mode finite state machine for draft teams, the disconnect grace timer that triggers the transition, the server-side bidding cadence that keeps a disconnected team participating in the auction, and the UI controls that let a reconnected owner see the active state and explicitly take manual control back.

### Stack and architecture context

Read `.aah/architecture/architecture-overview.md` §2 and §7 for the monorepo layout (`server/src/draft/auto-agent.ts`, `web/src/screens/draft-room/`), the per-draft serialized AsyncQueue (all Auto-Agent bids enqueue through the same path as manual bids), and the Pino + OTel observability conventions. Read `.aah/architecture/data-model.md` for the `AutoAgentConfig`, `DraftTeamState.control_mode`, and `DraftEvent` entity shapes touched by this module. Read `.aah/architecture/application-flow.md` §8 for the Auto-Agent flow diagram. Read `.aah/architecture/module-map.yaml` entry `id: MOD-004` for the full layer capability list.

### What the module does

**Control-mode FSM.** `DraftTeamState.control_mode` is an enum (`MANUAL | AUTO_AGENT`). Every transition is persisted (via a `DraftEvent` row) and broadcast to all clients in the draft. The transition `MANUAL → AUTO_AGENT` is triggered either by the disconnect grace timer firing or by an explicit `PATCH /drafts/:draftId/teams/:teamId/control-mode` request with `{"mode": "AUTO_AGENT"}`. The reverse transition (`AUTO_AGENT → MANUAL`) is triggered only by an explicit `PATCH` with `{"mode": "MANUAL"}` — reconnection alone does NOT restore manual control.

**Disconnect detection and grace timer.** The session layer (MOD-003) maintains a `Map<draft_id, Map<team_id, Set<ws>>>`. When the last WebSocket connection for a team closes, a per-team grace timer is started (duration from `AuctionConfiguration`; default 30 s). If the team reconnects before the timer fires, the timer is cancelled and `control_mode` remains `MANUAL`. If the timer fires, the server sets `DraftTeamState.control_mode = AUTO_AGENT`, inserts a `DraftEvent` row with type `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `disconnect_grace`), and broadcasts the event to all draft clients. Multi-window ownership counts as one identity: any of the team's ws connections reconnecting cancels the timer.

**Willingness ceiling.** `AutoAgentConfig` (per-team per-draft) stores `willingness_pct` (float 0–1). The willingness ceiling is computed at bid time: `Math.floor(DraftTeamState.remaining_budget_minor * willingness_pct)`. The computation uses the live `remaining_budget_minor` from `DraftTeamState`, never a stale snapshot. The `PUT /drafts/:draftId/teams/:teamId/auto-agent` endpoint writes `AutoAgentConfig.willingness_pct` and confirms it; the team's owner may update this at any time before or during the draft.

**Bidding cadence.** When `control_mode == AUTO_AGENT` and the team's willingness ceiling has not been reached, the agent enqueues a `BID_ABSOLUTE` command on two trigger events:
- `NOMINATION_STARTED` — auction opens on a player; the agent may place the opening bid even if it has never led on this player.
- `BID_ACCEPTED` where `new leading_team_id != this team's team_id` — a competitor just took the lead.

The agent does NOT trigger on `PLAYER_AWARDED` (the auction is already closed at that point). The bid amount is `min(current_bid_minor + 100, max_legal_bid)`, where `max_legal_bid = remaining_budget_minor - (100 * required_remaining_roster_spots)`. If `willingness_ceiling < current_bid_minor + 100`, the agent does not bid. All auto-bids route through the per-draft `AsyncQueue` and are validated by the same bid pipeline as manual bids (auth_epoch re-read, version check, budget check). The server never silently adjusts the agent's computed amount; if the computed bid fails validation, the bid is rejected and the rejection is logged.

**WS commands.** Two WS commands complete the surface:
- `SET_AUTO_AGENT_CONFIG` — owner sets `willingness_pct`; maps to the REST endpoint above.
- `RESUME_MANUAL` — owner explicitly restores `MANUAL` control; maps to `PATCH /control-mode {mode: MANUAL}`.

**DraftEvent audit.** Every control-mode transition persists a `DraftEvent` row in the same DB transaction as the `DraftTeamState.control_mode` update. Event types: `TEAM_AUTO_AGENT_ENABLED`, `TEAM_AUTO_AGENT_DISABLED`, `TEAM_RECONNECTED`. The sequence number is allocated from the per-draft counter inside the transaction per the append-only convention in `data-model.md`.

**UI: Auto-Agent config panel.** Located in the Draft Room sidebar (`web/src/screens/draft-room/`). Contains a willingness-percentage slider (0–100 %) bound to `AutoAgentConfig.willingness_pct * 100`. The slider is only actionable by the team's own owner session. The computed ceiling in dollar terms is shown adjacent to the slider (integer cents, formatted as dollars).

**UI: Auto-Agent active indicator.** Visible to all teams in the draft room. Shows which teams are currently in `AUTO_AGENT` mode. The indicator updates on receipt of `TEAM_AUTO_AGENT_ENABLED` and `TEAM_AUTO_AGENT_DISABLED` events.

**UI: Resume manual control button.** Rendered only for the reconnected owner whose team is currently in `AUTO_AGENT` mode. Clicking it sends `RESUME_MANUAL`. After receiving `TEAM_AUTO_AGENT_DISABLED` broadcast, the button disappears and the team's control mode shows `MANUAL`.

### Behavioral expectations

- **Grace timer — no early transition.** Given a team has active WS connections, when one connection closes but at least one remains, then the grace timer is NOT started and `control_mode` stays `MANUAL`.
- **Grace timer — cancelled by reconnect.** Given the last connection for a team closed and the grace timer is running, when any connection for that team reconnects before the timer fires, then the timer is cancelled and `control_mode` remains `MANUAL`.
- **Grace timer — fires.** Given the last connection for a team closed and the grace timer fires with no reconnect, then `DraftTeamState.control_mode` is set to `AUTO_AGENT`, a `DraftEvent` row with type `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `disconnect_grace`) is inserted in the same transaction, and the event is broadcast to all draft clients.
- **No auto-resume on reconnect.** Given a team is in `AUTO_AGENT` mode and a WS connection is established for that team, then `control_mode` remains `AUTO_AGENT` and the server does NOT emit `TEAM_AUTO_AGENT_DISABLED`; the reconnected client receives the current `TEAM_AUTO_AGENT_ENABLED` state in its reconnect snapshot.
- **Agent bids on NOMINATION_STARTED.** Given `control_mode == AUTO_AGENT` and `current_bid_minor (0) < willingness_ceiling`, when `NOMINATION_STARTED` is broadcast for a new player auction, then the agent enqueues a `BID_ABSOLUTE` command for `min(100, max_legal_bid)` through the per-draft AsyncQueue.
- **Agent bids on leadership change.** Given `control_mode == AUTO_AGENT` and `current_bid_minor < willingness_ceiling`, when `BID_ACCEPTED` is received with `leading_team_id != this team's team_id`, then the agent enqueues `BID_ABSOLUTE` for `min(current_bid_minor + 100, max_legal_bid)`.
- **Agent does NOT bid on PLAYER_AWARDED.** Given `control_mode == AUTO_AGENT`, when `PLAYER_AWARDED` is broadcast (auction already closed), then the agent enqueues no bid command.
- **Agent does NOT bid above willingness ceiling.** Given `control_mode == AUTO_AGENT` and `current_bid_minor + 100 > willingness_ceiling`, when a bid trigger event arrives, then the agent does NOT enqueue any bid command and the team remains a non-bidder on that player.
- **Agent bids respect max_legal_bid.** Given the computed agent bid amount would exceed `max_legal_bid`, when the bid is enqueued, then the amount is capped at `max_legal_bid`; if `max_legal_bid <= current_bid_minor`, no bid is enqueued.
- **Bid validation applies to agent bids.** Given an auto-agent bid is enqueued, when the command queue processes it, then the same auth_epoch re-read, auction-version check, and budget check run as for a manual bid; if any check fails, the bid is rejected and logged as a `BidAttempt` with `accepted = false`.
- **Willingness config update.** Given an owner sends `PUT /drafts/:draftId/teams/:teamId/auto-agent` with `{"willingness_pct": 0.6}`, when the request is authenticated (JWT + auth_epoch re-read) and `willingness_pct` is in [0, 1], then `AutoAgentConfig.willingness_pct` is updated and the response contains `{team_id, willingness_pct: 0.6}`; all subsequent auto-bids use the new ceiling.
- **Explicit AUTO_AGENT transition via PATCH.** Given an authenticated owner or commissioner sends `PATCH /drafts/:draftId/teams/:teamId/control-mode` with `{"mode": "AUTO_AGENT"}`, when the request passes auth checks, then `DraftTeamState.control_mode` is set to `AUTO_AGENT`, a `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `manual`) `DraftEvent` is appended, and the event is broadcast to all draft clients.
- **RESUME_MANUAL transitions to MANUAL.** Given a team is in `AUTO_AGENT` mode and the owner sends `PATCH /drafts/:draftId/teams/:teamId/control-mode` with `{"mode": "MANUAL"}`, when the request passes auth checks, then `DraftTeamState.control_mode` is set to `MANUAL`, a `TEAM_AUTO_AGENT_DISABLED` `DraftEvent` is appended, and the event is broadcast; the response returns `{team_id, control_mode: "MANUAL"}`.
- **DraftEvent atomicity.** Given any control-mode transition, when the DB transaction commits, then the `DraftTeamState.control_mode` update and the `DraftEvent` row share the same transaction; if the transaction fails, neither is persisted and no broadcast occurs.
- **All transitions broadcast.** Given any control-mode change (`TEAM_AUTO_AGENT_ENABLED`, `TEAM_AUTO_AGENT_DISABLED`, `TEAM_RECONNECTED`), when the transaction commits, then all WS clients connected to that draft receive the corresponding broadcast event containing `{team_id, triggered_by}`.
- **Multi-draft isolation.** Given a `PATCH /control-mode` or `PUT /auto-agent` command arrives, when the token's `league_id` does not match `draft.league_id`, then the server rejects the request with an AUTH_ERROR and makes no state change.
- **UI — config panel visible to owner only.** Given the current session is for team T, when the Draft Room renders the Auto-Agent panel, then the willingness slider is interactive only for session team T; other teams' sessions see the panel as read-only or see only the active-indicator.
- **UI — active indicator updates in real time.** Given a `TEAM_AUTO_AGENT_ENABLED` or `TEAM_AUTO_AGENT_DISABLED` event is received over WS, when the Draft Room re-renders, then the active indicator immediately reflects the updated set of teams in AUTO_AGENT mode without requiring a page reload.
- **UI — Resume Manual button.** Given a team's session reconnects while `control_mode == AUTO_AGENT`, when the Draft Room renders, then a "Resume manual control" button is visible only to that team's owner; clicking it dispatches `RESUME_MANUAL`; on receipt of `TEAM_AUTO_AGENT_DISABLED` the button disappears.
- **Env variables registered.** Given `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV` are missing from the environment, when the server starts, then the env checker (implemented in MOD-000) emits `ERR_CDR_78_EX_CONFIG` naming all missing variables before any module reads configuration, and the process exits non-zero.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-003

## API Contracts

```yaml
produces:
  - operation_id: setAutoAgentConfig
    schema_file: schema/MOD-004-api-schema.yaml
    request_schema: AutoAgentConfigRequest
    response_schema: AutoAgentConfigResponse
  - operation_id: setControlMode
    schema_file: schema/MOD-004-api-schema.yaml
    request_schema: ControlModeRequest
    response_schema: ControlModeResponse
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
