## Id
F-MOD-013

## Title
Draft Summary Report Routing and Metrics

## Module Ref
MOD-013

## Description
Wires the already-built `DraftComplete` component (`web/src/screens/draft-complete/index.tsx`) into actual app routing, and extends the report it renders with the PRD §36.1–§36.3 evaluation metrics. Node.js 20+ / Fastify 4.x backend, PostgreSQL via Drizzle (postgres.js), React 18 + Vite + TypeScript frontend, native `ws` WebSockets. Observe every constraint in `.aah/discuss/discuss-prd.md` and `CLAUDE.md` — in particular constraint #6 (No strategic valuation: these metrics are informational evaluation figures, never a fair-value computation or bid recommendation).

**Current gap (read these files before writing code):** `web/src/App.tsx` defines routes for `/commissioner`, `/lobby`, `/draft-room`, `/war-room` but has no `/draft-complete` route, so `DraftComplete` is never rendered by the running app. `App.tsx`'s `DraftGateway` (the post-auth landing logic for an OWNER) inspects `DraftSummary.status` (`CREATED | RUNNING | PAUSED | COMPLETE`) to route to Draft Room or the Lobby, but never checks for `COMPLETE`, so an owner authenticating after the draft ends lands in the Lobby. `web/src/screens/draft-room/index.tsx` (around its `ws.draftStatus === 'COMPLETE'` branch) shows only inline "Draft complete." text instead of navigating away, and `web/src/screens/war-room/index.tsx` does not react to `draftStatus` at all. `web/src/lib/useAuctionSocket.ts` already parses the `DRAFT_COMPLETE` broadcast into `state.draftStatus = 'COMPLETE'` (see its `DRAFT_COMPLETE` reducer case) — that is the existing signal this feature's navigation must react to; no new WS message type is needed. `server/src/draft/reports.ts`'s `generateReport()` builds `DraftSummaryReport` from `Acquisition` + `DraftTeamState` rows and is the function to extend with the new metrics; `GET /drafts/:draftId/report` (operation `getDraftReport`) is the endpoint whose response grows new fields. `POST /drafts/:draftId/report/email` (SendGrid stub) is explicitly out of scope — leave it as-is.

**Routing behavior to build:** add a `/draft-complete` route in `App.tsx` (pattern matching the existing `DraftRoomRoute`/`WarRoomRoute`, reading `draftId` from the URL and `auth` for role/team context). In `DraftRoomRoute` and `WarRoomRoute` (or inside `DraftRoom`/`WarRoom` themselves), react to `ws.draftStatus === 'COMPLETE'` by navigating (`react-router-dom`'s `useNavigate`) to `/draft-complete?draftId=...` — this covers both the live `DRAFT_COMPLETE` broadcast for already-connected clients and the reconnect-snapshot case (a client that connects after completion also receives `draftStatus: 'COMPLETE'` in its `STATE_SNAPSHOT`, per `useAuctionSocket.ts`'s `STATE_SNAPSHOT` case). In `DraftGateway`, extend the existing `active.status === 'RUNNING' || 'PAUSED'` check to also navigate to `/draft-complete?draftId=...` when `active.status === 'COMPLETE'`, per `screen-information-architecture.md` §18 ("an owner who authenticates after the draft has ended lands here directly rather than at the Pre-Draft Lobby").

**Metrics to add (PRD §36.1–§36.3, data-model.md §19.1 `DraftTeamEvaluation`):** extend `GET /drafts/:draftId/report`'s per-team response entries with `projected_starter_points`, `roster_depth_score`, and `aav_efficiency_pct` (field names per `module-map.yaml` MOD-013's `api` layer and its `smoke_test`), computed as:
- `projected_starter_points` — sum of `player_dataset_entries.projected_points` for that team's acquisitions whose active `roster_entries` row points to a `roster_slot_definitions` row with `is_starter = true` (the same starter-first assignment `server/src/draft/engine.ts` already applied at award time — this metric reads that assignment, it does not recompute or re-optimize it; PRD §36.1: "not an optimized weekly lineup recommendation").
- `roster_depth_score` — a separately labeled, versioned bench/depth-oriented figure (PRD §36.2: "exact formula is versioned and transparent") distinct from `projected_starter_points`; expose its formula version conceptually as `data-model.md` §19.1's `calculation_version` field does, so the figure's meaning can evolve without silently changing past reports.
- `aav_efficiency_pct` — purchase price vs. the frozen dataset's `player_dataset_entries.aav_minor` for that team's acquisitions (the single, static AAV value the currently-built dataset schema carries per player — multi-source AAV selection is MOD-016 scope and out of dependency for this module). Label the figure clearly as "AAV efficiency," never as owner skill or fair value (PRD §36.3, CLAUDE.md #6).

These three fields are computed per team and added alongside the existing `team_id`, `team_name`, `final_budget_minor`, `acquisitions` fields already defined by `schema/MOD-006-api-schema.yaml`'s `ReportTeamEntry`/`DraftSummaryReport` schemas — extend those response objects, do not replace them.

**UI split (screen-information-architecture.md §18, PRD §36.4):** split `DraftComplete`'s current flat all-teams standings into two tab/view states — **Owner view** (the requesting team's own full pick list with player/price/slot, total spend, remaining budget, and that team's three new metrics) and **League summary view** (all teams' spend, roster completion, and the three metrics side by side, plus league-wide spend vs. the dataset AAV). Both views are visible and downloadable by every owner, not commissioner-gated — per the IA: "nothing in it wasn't already broadcast live during the draft," so no additional authorization narrowing is needed beyond the existing `requireLeagueMember` check `reports.ts` already applies. The existing commissioner-only "Export worksheet" (ESPN CSV) and "Send summary email" actions are unrelated to this per-view download and stay commissioner-gated exactly as built.

**Behavioral expectations:**

- Given a draft transitions to `COMPLETE` and broadcasts `DRAFT_COMPLETE`, when a client currently on `/draft-room` or `/war-room` for that draft receives it, then the client is navigated to `/draft-complete?draftId=...` without requiring a manual reload.
- Given a fresh session authenticates (or a client reconnects) against a draft whose status is already `COMPLETE`, when the client determines its initial route (via `DraftGateway` for a lobby-bound owner, or via the existing snapshot-driven `draftStatus` for an already-open Draft Room/War Room tab), then it is routed to `/draft-complete?draftId=...` and never to `/lobby`, `/draft-room`, or `/war-room`.
- Given the `/draft-complete` route renders, when `DraftComplete` mounts, then it fetches or receives the `DraftSummaryReport` for that `draftId` and renders without requiring the user to already hold report data in memory.
- Given `GET /drafts/:draftId/report` is called for a `COMPLETE` draft, when the response is returned, then each team entry includes `projected_starter_points`, `roster_depth_score`, and `aav_efficiency_pct` in addition to the existing `team_id`, `team_name`, `final_budget_minor`, `acquisitions` fields, and the existing `DRAFT_NOT_COMPLETE` 409 behavior for a non-`COMPLETE` draft is unchanged.
- Given `projected_starter_points` is computed for a team, when a player was assigned to a bench slot rather than a starter slot, then that player's projected points are excluded from the sum — only players whose active `RosterEntry` maps to an `is_starter = true` `RosterSlotDefinition` are counted.
- Given `roster_depth_score` is computed, then it is presented as a metric distinct and separately labeled from `projected_starter_points`, and its formula carries a version identifier so a future formula change is distinguishable from a past report's figure.
- Given `aav_efficiency_pct` is computed for an acquisition, then it compares `price_minor` against that player's `player_dataset_entries.aav_minor` from the draft's frozen dataset, and the UI label reads as an AAV-efficiency figure, never as a skill grade, fair-value estimate, or recommended bid (CLAUDE.md #6).
- Given any team owner (not just the commissioner) opens `/draft-complete`, when they view the Owner view, then they see only their own full pick list (player, price, slot), total spend, remaining budget, and their team's three metrics.
- Given any team owner opens `/draft-complete`, when they switch to the League summary view, then they see every team's spend, roster completion, and the three metrics side by side, plus league-wide spend vs. the dataset AAV — with no data beyond what was already broadcast live during the draft.
- Given a team owner is viewing either the Owner view or the League summary view, when they trigger that view's download action, then a file download is initiated containing that view's data, and this action is available to every owner, not gated to the commissioner (distinct from the existing commissioner-only "Export worksheet"/ESPN CSV and "Send summary email" actions, which are unchanged).
- Given the commissioner opens `/draft-complete`, when they interact with it, then the existing "Export worksheet" and "Send summary email" buttons continue to function exactly as already built by F-MOD-006, unaffected by the Owner/League summary view split.
- Given the Draft Room's previous inline "Draft complete." message path, when this feature ships, then that dead-end state is replaced by the automatic navigation to `/draft-complete` — a connected owner is never left staring at static "Draft complete." text with no way to reach the report.

**Post-launch gap-review scope (2026-09): guided ESPN transfer flow + working email report.** This scope pairs with a much larger backend rework in F-MOD-006 (draft-completion-and-reports), which adds a Team→ESPN-team mapping endpoint, reconciliation-tracking (mark-player-transfer-confirmed), a canonical JSON export endpoint, and real SendGrid email delivery replacing the current logging-only stub in `server/src/draft/reports.ts`'s `POST /drafts/:draftId/report/email` handler. This feature is the UI side of that rework, replacing `DraftComplete`'s current single "Export worksheet" CSV-download button with an actual guided multi-step flow, per PRD §37 ("ESPN Transfer"): 1) validate internal roster integrity, 2) map source teams to ESPN teams, 3) validate player identity and roster capacity, 4) produce team-by-team ESPN entry order, 5) guide the commissioner through ESPN Offline Draft entry, 6) track confirmed players, 7) flag ambiguous/unresolved mappings, 8) mark the transfer reconciled — the application never assumes a supported ESPN roster-write API (PRD §37), so every step is manual entry into ESPN's own Offline Draft tool guided by this UI, not an API call to ESPN.

**Guided ESPN roster transfer flow to build:** commissioner-only (same gating as the existing "Export worksheet" button). Add a multi-step flow, reachable from `/draft-complete`, that:
- lets the commissioner map each internal `Team` to an ESPN team (consuming F-MOD-006's new team-mapping endpoint), and surfaces any ambiguous/unresolved mapping flags that endpoint returns for the commissioner to resolve before proceeding;
- walks the commissioner through entering each team's picks into ESPN's Offline Draft tool in `resolution_sequence` (draft) order, with a reconciliation checkbox/confirmation control per player that calls F-MOD-006's new mark-player-transfer-confirmed endpoint, so progress through a long roster list survives a page reload;
- adds a download/view option for F-MOD-006's new canonical JSON export, alongside (not replacing) the existing CSV/ESPN-worksheet downloads — Draft Complete now offers three export formats: generic CSV, ESPN-oriented worksheet, and canonical JSON;
- keeps winning prices and full bid history authoritative in this application throughout (PRD §37: "Winning prices and full bid history remain authoritative in this application") — the guided flow assists manual ESPN entry and tracks confirmation state, it never becomes a second source of truth for who won what.

**Working email report to build:** the existing commissioner-only "Send summary email" button currently calls `POST /drafts/:draftId/report/email`, which only logs dispatch intent and always returns `{ accepted: true, recipients }` regardless of whether mail was sent. Once F-MOD-006's rework wires that endpoint to real SendGrid delivery, this button must reflect the endpoint's real outcome: on success, show confirmation that the report was actually sent to owners (not merely accepted for logging); on failure, show a clear, distinct error state rather than the current always-succeeds UI. Per PRD §36 and `reports.ts`'s existing comment, email delivery failure must never affect in-app report availability — a failed send only affects this button's own status display, not the rest of the `/draft-complete` screen.

**Additional behavioral expectations (gap-review scope):**

- Given the commissioner opens the guided ESPN transfer flow, when F-MOD-006's team-mapping endpoint returns an ambiguous or unresolved mapping, then the flow surfaces that flag to the commissioner for resolution before the entry-order step proceeds for the affected team.
- Given the commissioner is walking through ESPN Offline Draft entry for a team, when they check a player's reconciliation confirmation control, then that confirmation is persisted via F-MOD-006's mark-player-transfer-confirmed endpoint, and reloading the page preserves which players are already confirmed.
- Given the commissioner is on `/draft-complete`, when they look at export options, then a canonical JSON download/view is available alongside the existing CSV and ESPN-worksheet downloads, with neither existing option removed or altered.
- Given the commissioner clicks "Send summary email" after F-MOD-006's SendGrid wire-up ships, when the send succeeds, then the UI shows real confirmation that owners were sent the report; when the send fails, then the UI shows a clear error distinct from the success state, and the rest of `/draft-complete` (Owner view, League summary view, existing downloads) remains fully usable.

## Layers
- api
- ui

## Dependencies
- F-MOD-006

## API Contracts
```yaml
api_contracts:
  produces:
    - operation_id: getDraftReport
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: {}
      response_schema: DraftSummaryReport
  consumes:
    - operation_id: listEspnTeamMappings
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: "(none)"
      response_schema: "ProviderTeamMapping[]"
    - operation_id: setEspnTeamMapping
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: ProviderTeamMappingRequest
      response_schema: ProviderTeamMapping
    - operation_id: getCanonicalExport
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: "(none)"
      response_schema: CanonicalExport
    - operation_id: getReconciliationStatus
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: "(none)"
      response_schema: ReconciliationStatusResponse
    - operation_id: confirmReconciliationItem
      schema_file: schema/MOD-006-api-schema.yaml
      request_schema: "(none)"
      response_schema: ReconciliationItem
```

## Test Config

- command: DATABASE_URL=postgres://draft:draft_local_dev@localhost:5432/draft_test npx vitest run --project node server/src/__tests__/F-MOD-013_report_metrics.test.ts --project web web/src/__tests__/F-MOD-013_draft_complete_routing.test.tsx web/src/__tests__/F-MOD-013_draft_complete_component.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-013_report_metrics.test.ts
  - web/src/__tests__/F-MOD-013_draft_complete_routing.test.tsx
  - web/src/__tests__/F-MOD-013_draft_complete_component.test.tsx

## Lint Config

## Constraints
- No strategic valuation: `projected_starter_points`, `roster_depth_score`, and `aav_efficiency_pct` are informational evaluation figures only — never a computed fair value, recommended bid, or owner-skill grade (CLAUDE.md constraint #6).
- `roster_depth_score`'s formula must be versioned and transparent, distinct from `projected_starter_points` (PRD §36.2).
- Both the Owner view and League summary view are visible and downloadable by every owner, not commissioner-restricted (PRD §36.4, screen-information-architecture.md §18).

## Required Env Variables

## Status
done

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
