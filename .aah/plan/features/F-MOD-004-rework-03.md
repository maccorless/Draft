## Id
F-MOD-004-rework-03

## Supersedes
- F-MOD-004

## Spec File
F-MOD-004.md

## Status
done

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

**Pre-start control-mode setting.** A `DraftTeamState` row is not guaranteed to exist yet when the commissioner or owner sets control mode before the draft has started (`Draft.status == 'CREATED'`) — `POST /drafts/:draftId/start` (MOD-002) is what normally creates one per team, seeded from the auction's configured `initial_budget_minor`/`total_roster_size`. `PATCH /drafts/:draftId/teams/:teamId/control-mode` (`server/src/auction/auto-agent.ts` `setControlMode()`) must therefore upsert: if no `DraftTeamState` row exists for `(draft_id, team_id)`, create one (using the same `auction_configurations`/`roster_configurations` lookup `POST /start` performs for `remaining_budget_minor`/`required_remaining_spots`) with the requested `control_mode`, append the `DraftEvent`, and broadcast — never a bare `UPDATE` that can silently match zero rows and return success anyway. `POST /drafts/:draftId/start` already guards its own row-creation with an existing-row check, so a row created early by this path is left untouched at start and its pre-set `control_mode` is preserved rather than being reset to `MANUAL`.

**Disconnect detection and grace timer.** The session layer (MOD-003) maintains a `Map<draft_id, Map<team_id, Set<ws>>>`. When the last WebSocket connection for a team closes, a per-team grace timer is started (duration from `AuctionConfiguration`; default 30 s). If the team reconnects before the timer fires, the timer is cancelled and `control_mode` remains `MANUAL`. If the timer fires, the server sets `DraftTeamState.control_mode = AUTO_AGENT`, inserts a `DraftEvent` row with type `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `disconnect_grace`), and broadcasts the event to all draft clients. Multi-window ownership counts as one identity: any of the team's ws connections reconnecting cancels the timer.

**Willingness ceiling — per-player, per `state-machine-flows.md` §11 "Auto-Agent Offer Calculation" and `data-model.md` §10.5 "AutoAgentConfiguration".** The ceiling is computed **per player under consideration**, not as a flat percentage of the team's total remaining budget:

1. **Base value.** If `AutoAgentConfiguration.use_owner_target_when_customized` and the team has a customized target for this player (a row exists in `owner_target_values` for `(draft_id, team_id, dataset_player_id)`), base = that row's `target_value_minor`. Otherwise, if `fallback_to_primary_aav`, base = this dataset's Primary AAV for the player (`player_aav_sources.aav_minor` joined on `dataset_id` + `player_id` + `source = draft_datasets.primary_aav_source`). If neither source is available, the agent does not bid on this player.
2. **Variance.** Apply a stable/random variance within `± AutoAgentConfiguration.random_variance_pct` of the base value (seeded/derived so it is stable across repeated calculations for the same team+player within a draft, not re-randomized on every trigger).
3. **Max-over-base ceiling.** Cap the varied value at `base * (1 + AutoAgentConfiguration.max_over_base_pct)`.
4. **Starter vs. bench.** If this player would fill one of the team's currently-unfilled starter slots (per `roster_slot_definitions`/`roster_entries`, mirroring the starter-fill-state logic already used in `server/src/draft/war-room.ts`), use the value from step 3 as-is ("starter willingness") when `AutoAgentConfiguration.prioritize_starters`. Otherwise, discount it by `AutoAgentConfiguration.bench_value_pct` (i.e. multiply by that fraction).
5. **Clamp.** Clamp the result to `max_legal_bid` (`remaining_budget_minor - ($1 reserve × other required remaining roster spots)`), computed from the live `DraftTeamState`, never a stale snapshot.

This ceiling is the `willingness_ceiling` referenced throughout the rest of this spec. `AutoAgentConfiguration` (per-team per-draft, table `auto_agent_configs`) gains the fields `data-model.md` §10.5 specifies — `use_owner_target_when_customized` (bool), `fallback_to_primary_aav` (bool), `max_over_base_pct` (decimal), `random_variance_pct` (decimal), `bench_value_pct` (decimal), `prioritize_starters` (bool) — via a migration; a newly-created row (no prior per-team configuration) must default to sane values that produce reasonable AAV-anchored behavior out of the box: `use_owner_target_when_customized = true`, `fallback_to_primary_aav = true`, `random_variance_pct = 0.25` (±25%), `max_over_base_pct` a modest ceiling above base (e.g. 0.25 = 25% over base at most), `bench_value_pct` a discount below 1.0 (e.g. 0.5), `prioritize_starters = true`. The prior flat `willingness_pct = remaining_budget_minor × pct` calculation is replaced by this per-player algorithm; the `PUT /drafts/:draftId/teams/:teamId/auto-agent` endpoint and Draft Room config UI are updated to configure these fields instead of a single willingness percentage.

**Bidding cadence.** When `control_mode == AUTO_AGENT`, the team has `DraftTeamState.required_remaining_spots > 0` (an eligible roster slot still exists — a full roster is never considered for a bid trigger, matching the existing `required_remaining_spots <= 0` nomination-eligibility filter already applied elsewhere for nomination selection), and the team's willingness ceiling has not been reached, the agent enqueues a `BID_ABSOLUTE` command on two trigger events:
- `NOMINATION_STARTED` — auction opens on a player; the agent may place the opening bid even if it has never led on this player.
- `BID_ACCEPTED` where `new leading_team_id != this team's team_id` — a competitor just took the lead.

The agent does NOT trigger on `PLAYER_AWARDED` (the auction is already closed at that point). The bid amount is `min(current_bid_minor + 100, max_legal_bid)`, where `max_legal_bid = remaining_budget_minor - (100 * required_remaining_roster_spots)`. If `willingness_ceiling < current_bid_minor + 100`, the agent does not bid. All auto-bids route through the per-draft `AsyncQueue` and are validated by the same bid pipeline as manual bids (auth_epoch re-read, version check, budget check). The server never silently adjusts the agent's computed amount; if the computed bid fails validation, the bid is rejected and the rejection is logged.

**WS commands.** Two WS commands complete the surface:
- `SET_AUTO_AGENT_CONFIG` — owner sets `AutoAgentConfiguration` fields (`max_over_base_pct`, `random_variance_pct`, `bench_value_pct`, `use_owner_target_when_customized`, `fallback_to_primary_aav`, `prioritize_starters`); maps to the REST endpoint above.
- `RESUME_MANUAL` — owner explicitly restores `MANUAL` control; maps to `PATCH /control-mode {mode: MANUAL}`.

**DraftEvent audit.** Every control-mode transition persists a `DraftEvent` row in the same DB transaction as the `DraftTeamState.control_mode` update. Event types: `TEAM_AUTO_AGENT_ENABLED`, `TEAM_AUTO_AGENT_DISABLED`, `TEAM_RECONNECTED`. The sequence number is allocated from the per-draft counter inside the transaction per the append-only convention in `data-model.md`.

**UI: Auto-Agent config panel.** Located in the Draft Room sidebar (`web/src/screens/draft-room/`). Exposes controls for the `AutoAgentConfiguration` fields above (`max_over_base_pct`, `random_variance_pct`, `bench_value_pct`, `prioritize_starters`, and the two boolean source-preference toggles), editable only by the team's own owner session. A computed example ceiling in dollar terms may be shown for context.

**UI: Auto-Agent active indicator.** Visible to all teams in the draft room. Shows which teams are currently in `AUTO_AGENT` mode. The indicator updates on receipt of `TEAM_AUTO_AGENT_ENABLED` and `TEAM_AUTO_AGENT_DISABLED` events.

**UI: Resume manual control button.** Rendered only for the reconnected owner whose team is currently in `AUTO_AGENT` mode. Clicking it sends `RESUME_MANUAL`. After receiving `TEAM_AUTO_AGENT_DISABLED` broadcast, the button disappears and the team's control mode shows `MANUAL`.

### Behavioral expectations

- **Grace timer — no early transition.** Given a team has active WS connections, when one connection closes but at least one remains, then the grace timer is NOT started and `control_mode` stays `MANUAL`.
- **Grace timer — cancelled by reconnect.** Given the last connection for a team closed and the grace timer is running, when any connection for that team reconnects before the timer fires, then the timer is cancelled and `control_mode` remains `MANUAL`.
- **Grace timer — fires.** Given the last connection for a team closed and the grace timer fires with no reconnect, then `DraftTeamState.control_mode` is set to `AUTO_AGENT`, a `DraftEvent` row with type `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `disconnect_grace`) is inserted in the same transaction, and the event is broadcast to all draft clients.
- **No auto-resume on reconnect.** Given a team is in `AUTO_AGENT` mode and a WS connection is established for that team, then `control_mode` remains `AUTO_AGENT` and the server does NOT emit `TEAM_AUTO_AGENT_DISABLED`; the reconnected client receives the current `TEAM_AUTO_AGENT_ENABLED` state in its reconnect snapshot.
- **Agent bids on NOMINATION_STARTED.** Given `control_mode == AUTO_AGENT` and `current_bid_minor (0) < willingness_ceiling` (computed per the per-player algorithm above for the nominated player), when `NOMINATION_STARTED` is broadcast for a new player auction, then the agent enqueues a `BID_ABSOLUTE` command for `min(100, max_legal_bid)` through the per-draft AsyncQueue.
- **Agent bids on leadership change.** Given `control_mode == AUTO_AGENT` and `current_bid_minor < willingness_ceiling` (for the player currently up), when `BID_ACCEPTED` is received with `leading_team_id != this team's team_id`, then the agent enqueues `BID_ABSOLUTE` for `min(current_bid_minor + 100, max_legal_bid)`.
- **Willingness ceiling is per-player, not a flat fraction of total budget.** Given two different players with different Primary AAV values (or one with a customized `owner_target_values` entry and one without), when the same AUTO_AGENT team considers bidding on each, then each player's `willingness_ceiling` is computed independently from that player's own base value (Owner Target if customized, else Primary AAV) — not from a single percentage of the team's total remaining budget shared across all players. A player whose base value is well below the team's remaining budget produces a correspondingly low ceiling, even early in the draft with a nearly-full budget.
- **Ceiling reflects AAV ± variance.** Given a player's Primary AAV is `V` minor units and no customized Owner Target exists, when the agent computes its ceiling for that player, then the base value used is `V`, the variance applied is within `± random_variance_pct` of `V`, and the final ceiling (before the starter/bench and max-legal-bid steps) does not exceed `V * (1 + max_over_base_pct)`.
- **Customized Owner Target overrides AAV.** Given a team has a customized `owner_target_values` row for a player and `use_owner_target_when_customized` is true, when the agent computes its ceiling for that player, then the base value is that row's `target_value_minor`, not the player's Primary AAV.
- **Bench discount applies to non-starter-filling players.** Given a player would not fill any of the team's currently-unfilled starter slots, when the agent computes its ceiling, then the post-variance/ceiling value is multiplied by `bench_value_pct` before the max-legal-bid clamp.
- **Agent does NOT bid on PLAYER_AWARDED.** Given `control_mode == AUTO_AGENT`, when `PLAYER_AWARDED` is broadcast (auction already closed), then the agent enqueues no bid command.
- **Agent does NOT bid above willingness ceiling.** Given `control_mode == AUTO_AGENT` and `current_bid_minor + 100 > willingness_ceiling`, when a bid trigger event arrives, then the agent does NOT enqueue any bid command and the team remains a non-bidder on that player.
- **Agent with a full roster never bids.** Given `control_mode == AUTO_AGENT` and `DraftTeamState.required_remaining_spots <= 0` (every starter and bench slot already filled), when `NOMINATION_STARTED` or a `BID_ACCEPTED` leadership change arrives, then the team is excluded from the bid-trigger query entirely — no `BID_ABSOLUTE` command is enqueued for it, regardless of remaining budget or willingness ceiling. This matches how a full-roster team is already excluded from nomination-turn eligibility.
- **Agent bids respect max_legal_bid.** Given the computed agent bid amount would exceed `max_legal_bid`, when the bid is enqueued, then the amount is capped at `max_legal_bid`; if `max_legal_bid <= current_bid_minor`, no bid is enqueued.
- **Bid validation applies to agent bids.** Given an auto-agent bid is enqueued, when the command queue processes it, then the same auth_epoch re-read, auction-version check, and budget check run as for a manual bid; if any check fails, the bid is rejected and logged as a `BidAttempt` with `accepted = false`.
- **Willingness config update.** Given an owner sends `PUT /drafts/:draftId/teams/:teamId/auto-agent` with updated `AutoAgentConfiguration` field values (e.g. `max_over_base_pct`, `random_variance_pct`, `bench_value_pct`), when the request is authenticated (JWT + auth_epoch re-read) and the values are within valid ranges, then `AutoAgentConfiguration` is updated and the response echoes the new values; all subsequent per-player ceiling calculations for that team use them.
- **New config defaults to AAV-anchored behavior.** Given a draft team has never had its `AutoAgentConfiguration` explicitly set, when the agent computes a ceiling for that team on any player, then it uses the documented defaults (`use_owner_target_when_customized = true`, `fallback_to_primary_aav = true`, `random_variance_pct = 0.25`, a modest `max_over_base_pct`, a `bench_value_pct` below 1.0, `prioritize_starters = true`) rather than failing or falling back to a flat percentage of total budget.
- **Explicit AUTO_AGENT transition via PATCH.** Given an authenticated owner or commissioner sends `PATCH /drafts/:draftId/teams/:teamId/control-mode` with `{"mode": "AUTO_AGENT"}`, when the request passes auth checks, then `DraftTeamState.control_mode` is set to `AUTO_AGENT`, a `TEAM_AUTO_AGENT_ENABLED` (triggered_by: `manual`) `DraftEvent` is appended, and the event is broadcast to all draft clients.
- **Control-mode set before draft start persists.** Given `Draft.status == 'CREATED'` and no `DraftTeamState` row yet exists for a team, when the commissioner or owner sends `PATCH /drafts/:draftId/teams/:teamId/control-mode` with `{"mode": "AUTO_AGENT"}`, then a `DraftTeamState` row is created for that team (budget/roster fields seeded from the draft's `auction_configurations`/`roster_configurations`) with `control_mode = AUTO_AGENT`, a `TEAM_AUTO_AGENT_ENABLED` `DraftEvent` is appended, the change is broadcast, and `GET /drafts/:draftId/roster-grid` subsequently reports that team's `control_mode` as `AUTO_AGENT` (not the no-row default of `MANUAL`). When `POST /drafts/:draftId/start` later runs for that draft, it does not overwrite this team's `control_mode` back to `MANUAL`.
- **RESUME_MANUAL transitions to MANUAL.** Given a team is in `AUTO_AGENT` mode and the owner sends `PATCH /drafts/:draftId/teams/:teamId/control-mode` with `{"mode": "MANUAL"}`, when the request passes auth checks, then `DraftTeamState.control_mode` is set to `MANUAL`, a `TEAM_AUTO_AGENT_DISABLED` `DraftEvent` is appended, and the event is broadcast; the response returns `{team_id, control_mode: "MANUAL"}`.
- **DraftEvent atomicity.** Given any control-mode transition, when the DB transaction commits, then the `DraftTeamState.control_mode` update and the `DraftEvent` row share the same transaction; if the transaction fails, neither is persisted and no broadcast occurs.
- **All transitions broadcast.** Given any control-mode change (`TEAM_AUTO_AGENT_ENABLED`, `TEAM_AUTO_AGENT_DISABLED`, `TEAM_RECONNECTED`), when the transaction commits, then all WS clients connected to that draft receive the corresponding broadcast event containing `{team_id, triggered_by}`.
- **Multi-draft isolation.** Given a `PATCH /control-mode` or `PUT /auto-agent` command arrives, when the token's `league_id` does not match `draft.league_id`, then the server rejects the request with an AUTH_ERROR and makes no state change.
- **UI — config panel visible to owner only.** Given the current session is for team T, when the Draft Room renders the Auto-Agent panel, then the config controls are interactive only for session team T; other teams' sessions see the panel as read-only or see only the active-indicator.
- **UI — active indicator updates in real time.** Given a `TEAM_AUTO_AGENT_ENABLED` or `TEAM_AUTO_AGENT_DISABLED` event is received over WS, when the Draft Room re-renders, then the active indicator immediately reflects the updated set of teams in AUTO_AGENT mode without requiring a page reload.
- **UI — Resume Manual button.** Given a team's session reconnects while `control_mode == AUTO_AGENT`, when the Draft Room renders, then a "Resume manual control" button is visible only to that team's owner; clicking it dispatches `RESUME_MANUAL`; on receipt of `TEAM_AUTO_AGENT_DISABLED` the button disappears.
- **Env variables registered.** Given `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV` are missing from the environment, when the server starts, then the env checker (implemented in MOD-000) emits `ERR_CDR_78_EX_CONFIG` naming all missing variables before any module reads configuration, and the process exits non-zero.

## Api Contracts
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