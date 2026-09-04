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
