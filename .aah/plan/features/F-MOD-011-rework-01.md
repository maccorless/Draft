## Id
F-MOD-011-rework-01

## Supersedes
- F-MOD-011

## Spec File
F-MOD-011.md

## Status
done

## Title
Commissioner Draft Control Live-Operation UI

## Module Ref
MOD-011

## Description
Replaces the `ComingSoon` placeholder currently rendered for the "Draft Control" section of
`web/src/screens/commissioner/index.tsx` (see the `activeSection === 'draft-control'` branch) with a
live-operation panel that lets the commissioner run an in-progress draft, plus the persistent Draft
Health panel and Audit log called for by `screen-information-architecture.md` §9.1/§9.2/§9.6 and
`PRD.md` §30. This module is the UI and small REST-endpoint layer on top of the auction engine already
built in MOD-002 (`server/src/auction/engine.ts`, `server/src/auction/routes.ts`) and the Auto-Agent
control-mode machinery already built in MOD-004 (`server/src/auction/auto-agent.ts`,
`server/src/auction/auto-agent-routes.ts`).

**Stack:** React 18 + Vite 5 + TypeScript for the UI (added to `web/src/screens/commissioner/`,
following the existing section-panel pattern in `index.tsx`); Fastify 4.x + TypeScript + `postgres.js`
for the new endpoints (added alongside `server/src/auction/routes.ts`), reusing the
`requireCommissionerForDraft`-style auth helper pattern (JWT verify → role check → re-read
`auth_epoch` from DB → verify `draft.league_id === claims.league_id`) already established in
`server/src/auction/routes.ts` and `server/src/auction/auto-agent-routes.ts`.

**What it builds, grounded in `module-map.yaml` MOD-011 and PRD §30:**

1. **Start Now / Pause/resume + timer controls.** "Start Now" reuses the existing
   `POST /drafts/:draftId/start` endpoint (`server/src/auction/routes.ts`), which transitions a
   `CREATED` draft straight to `RUNNING` — this endpoint has no scheduled-start-time gate of its own,
   so the commissioner can call it at any time regardless of whether or when the draft was scheduled.
   This module adds a "Start Now" button to the Draft Controls panel, visible/enabled only while
   `health.status === 'CREATED'`, wired to that endpoint. Pause/resume reuse the existing
   `POST /drafts/:draftId/pause` and `POST /drafts/:draftId/resume` endpoints
   (`server/src/auction/routes.ts`) — this module wires buttons to them. Timer extension is new:
   `POST /drafts/:id/timers/extend` (body: `{ seconds }`),
   commissioner-only, valid only while a `PlayerAuction` is in a non-terminal state
   (`SECOND_BID_OPEN` or `REBID_OPEN` per `data-model.md` §PlayerAuction) — extends that auction's
   `deadline_at`, bumps `auction_version`, appends a `DraftEvent`, and broadcasts the new deadline so
   all clients' countdowns (which are always display-only per CLAUDE.md constraint #1) reflect it.
2. **Nominate-for-owner / bid-for-owner.** Per module-map: reuse the existing WS commands
   `NOMINATE_COMMAND` and `BID_COMMAND` (handled in `server/src/ws/auction-handler.ts` via
   `processNominateCommand`/`processBidCommand` in `server/src/auction/engine.ts`), extended with an
   `on_behalf_of_team_id` field in the command payload. When the sender's JWT role is `COMMISSIONER`
   and `on_behalf_of_team_id` is present, the handler authorizes the action as a commissioner override
   (`requireCommissioner`-equivalent check) and executes the nominate/bid using that team_id instead of
   the commissioner's own identity — the resulting `PLAYER_NOMINATED`/`BID_ACCEPTED`/`BID_REJECTED`
   events and broadcasts are unchanged in shape, so no new WS event types are introduced for this path.
3. **Manual/Auto-Agent toggle per team.** Reuses the existing `PATCH
   /drafts/:draftId/teams/:teamId/control-mode` endpoint (`server/src/auction/auto-agent-routes.ts`,
   already commissioner-callable via `requireTeamOrCommissioner`) and `setControlMode()`
   (`server/src/auction/auto-agent.ts`, which appends `TEAM_AUTO_AGENT_ENABLED` /
   `TEAM_AUTO_AGENT_DISABLED` DraftEvents and broadcasts them). This module adds the per-team toggle
   grid UI calling that existing endpoint with `triggered_by: 'commissioner'`.
4. **Budget adjustment.** New endpoint `POST /drafts/:id/teams/:teamId/budget-adjustment` (body:
   `{ delta_minor, reason }`), commissioner-only, `reason` required. Inserts a `BudgetLedgerEntry`
   with `reason_type = COMMISSIONER_ADJUSTMENT` (per `data-model.md` §16 BudgetLedgerEntry enum),
   updates the team's `DraftTeamState.remaining_budget` accordingly, appends a `DraftEvent`, and
   broadcasts the new balance — all in one transaction per the command-atomicity pattern used
   throughout `engine.ts` (validate → persist + DraftEvent in the same transaction → commit → update
   in-memory state → broadcast; CLAUDE.md constraint #4). Money is exact integer minor units server-side
   (constraint #5); the server never recomputes or clamps the commissioner's entered `delta_minor`.
5. **Open-auction reassign.** New endpoint `POST /drafts/:id/auctions/current/reassign` (body allows
   changing the target player and/or manually awarding to a team), restricted to the currently open
   (unresolved) `PlayerAuction` only — i.e. one in a non-terminal `state`
   (`SECOND_BID_OPEN`/`REBID_OPEN`/`PAUSED`) per `data-model.md` §PlayerAuction. Per PRD §30 and
   module-map, this is unrestricted/no-legality-replay because nothing has resolved yet — it is
   distinct from MOD-012's already-awarded-pick corrections (which require ledger-replay legality
   gating). Appends a `DraftEvent` and broadcasts the change so all clients see the corrected
   nomination/award immediately.
6. **Draft Health panel** (`screen-information-architecture.md` §9.1): backed by new
   `GET /drafts/:id/health`, returning status, current round/cycle, auctions completed, the current
   `PlayerAuction` + its timer/deadline, counts of connected/Auto-Agent/reconnecting teams (derived
   from the `DraftClientSession` tracking already built in MOD-003/MOD-004,
   `server/src/auction/engine.ts` runtime maps), and a warnings list. Rendered persistently within the
   Draft Control section.
7. **Audit log** (`screen-information-architecture.md` §9.6): backed by new
   `GET /drafts/:id/audit-log`, a paginated read over the existing `draft_events` table (see
   `server/src/draft/reports.ts` and `server/src/draft/whammy.ts` for the established
   query-by-`draft_id`/auth pattern) filtered to commissioner-relevant and exception event types
   (e.g. `DRAFT_PAUSED`, `DRAFT_RESUMED`, `TEAM_AUTO_AGENT_ENABLED`, `TEAM_AUTO_AGENT_DISABLED`,
   the new timer-extend/budget-adjustment/reassign event types, and any `BID_REJECTED`/`ERROR`
   exception events) — no new write path, this is a read-only projection of the append-only
   `DraftEvent` log per CLAUDE.md constraint #2. Rendered as a filterable, most-recent-first table.

**Behavioral expectations:**

- Given a `CREATED` draft (not yet started, regardless of whether or when a scheduled start time
  is set or has passed), when the commissioner clicks "Start Now" in the Draft Control section,
  then `POST /drafts/:id/start` fires, the draft transitions to `RUNNING`, a `DRAFT_STATUS_CHANGED`
  broadcast is received, and the UI reflects `RUNNING` without a page reload.
- Given a draft that is not `CREATED` (already `RUNNING`, `PAUSED`, or `COMPLETE`), when the
  commissioner views the Draft Control section, then the "Start Now" control is not shown or is
  disabled, and clicking it (if somehow triggered) is a no-op that makes no request.
- Given a `RUNNING` draft, when the commissioner clicks Pause in the Draft Control section, then
  `POST /drafts/:id/pause` fires, the draft transitions to `PAUSED`, a `DRAFT_STATUS_CHANGED`
  broadcast is received, and the UI reflects `PAUSED` without a page reload.
- Given a `PAUSED` draft, when the commissioner clicks Resume, then `POST /drafts/:id/resume` fires
  and the UI reflects `RUNNING` on the resulting broadcast.
- Given an auction in `SECOND_BID_OPEN` or `REBID_OPEN`, when the commissioner submits a timer
  extension of N seconds, then `POST /drafts/:id/timers/extend` succeeds, the auction's deadline
  moves forward by N seconds, `auction_version` increments, and all connected clients' displayed
  deadlines update from the broadcast (never from local client math).
- Given no open auction, when the commissioner attempts a timer extension, then the request is
  rejected with a clear error and no `DraftEvent` is written.
- Given a disconnected or otherwise unresponsive team, when the commissioner submits a nominate
  action via the on-behalf-of form targeting that team, then a `NOMINATE_COMMAND` with
  `on_behalf_of_team_id` set is sent, the server authorizes it as a commissioner override, and the
  resulting nomination is attributed to that team (not the commissioner) in the broadcast state.
- Given an open auction, when the commissioner submits a bid on behalf of a team via the
  bid-for-owner form, then a `BID_COMMAND` with `on_behalf_of_team_id` set is accepted or rejected
  by the same validation rules (stale-state protection, budget/roster legality) that apply to a
  team's own bids, and the outcome is reflected identically for all clients.
- Given a team currently in `MANUAL` control mode, when the commissioner toggles it to Auto-Agent
  in the per-team grid, then `PATCH /drafts/:id/teams/:teamId/control-mode` is called with
  `mode: AUTO_AGENT`, a `TEAM_AUTO_AGENT_ENABLED` event broadcasts, and the grid reflects the new
  mode; toggling back to Manual calls the same endpoint with `mode: MANUAL` and broadcasts
  `TEAM_AUTO_AGENT_DISABLED`.
- Given a team with a known remaining budget, when the commissioner submits a budget adjustment with
  a non-zero `delta_minor` and a required `reason`, then a `BudgetLedgerEntry` with
  `reason_type = COMMISSIONER_ADJUSTMENT` is appended, `DraftTeamState.remaining_budget` reflects the
  exact entered delta (never rounded, clamped, or silently altered), and the change broadcasts to all
  clients.
- Given a budget adjustment request with an empty or missing `reason`, when submitted, then the
  server rejects it with a validation error and no ledger entry is written.
- Given the currently open, unresolved `PlayerAuction`, when the commissioner submits a reassign
  (different player and/or manual award to a specific team), then
  `POST /drafts/:id/auctions/current/reassign` succeeds without any legality replay (since nothing
  has resolved yet), the auction reflects the new player/winner, and the change broadcasts to all
  clients.
- Given an already-awarded (resolved) `PlayerAuction`, when a reassign is attempted against it via
  this endpoint, then the request is rejected — that already-awarded case is out of scope for this
  module and belongs to MOD-012's corrections/rollback flow instead.
- Given a running draft, when the commissioner views the Draft Control section, then the Draft
  Health panel shows current status, round/cycle, auctions-completed count, the current
  `PlayerAuction` and its live timer, connected-owner count, Auto-Agent-team count,
  reconnecting-team count, and any warnings, all sourced from `GET /drafts/:id/health` and kept live
  as events arrive.
- Given prior commissioner actions and system exceptions have occurred in the draft, when the
  commissioner opens the Audit log, then `GET /drafts/:id/audit-log` returns them most-recent-first,
  paginated, filterable, and every action performed via this module's controls (pause, resume, timer
  extend, on-behalf-of nominate/bid, control-mode toggle, budget adjustment, reassign) appears in it
  in the order performed.
- Given a non-commissioner (owner) session token, when any of this module's endpoints
  (`timers/extend`, `budget-adjustment`, `auctions/current/reassign`, `health`, `audit-log`) or the
  commissioner-override WS fields are invoked, then the request is rejected with a `FORBIDDEN`
  response and no state changes.
- Given a request whose token `league_id` does not match the target draft's `league_id`, when any
  of this module's endpoints or WS commands are invoked, then the request is rejected per the
  multi-draft isolation check (CLAUDE.md constraint #11), independent of routing.

## Api Contracts
```yaml
api_contracts:
  produces:
    - operation_id: extendTimer
      schema_file: schema/MOD-011-api-schema.yaml
      request_schema: ExtendTimerRequest
      response_schema: ExtendTimerResponse
    - operation_id: adjustBudget
      schema_file: schema/MOD-011-api-schema.yaml
      request_schema: BudgetAdjustmentRequest
      response_schema: BudgetAdjustmentResponse
    - operation_id: reassignCurrentAuction
      schema_file: schema/MOD-011-api-schema.yaml
      request_schema: ReassignAuctionRequest
      response_schema: "200 OK (no response body)"
    - operation_id: getDraftHealth
      schema_file: schema/MOD-011-api-schema.yaml
      request_schema: "(none)"
      response_schema: DraftHealthResponse
    - operation_id: getAuditLog
      schema_file: schema/MOD-011-api-schema.yaml
      request_schema: "(none)"
      response_schema: AuditLogResponse
```