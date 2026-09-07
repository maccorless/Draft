## Id
F-MOD-010-rework-01

## Supersedes
- F-MOD-010

## Spec File
F-MOD-010.md

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
planned

## Title
Commissioner League Setup and Readiness Checklist

## Module Ref
MOD-010

## Description
Builds the Commissioner Console "League Setup" section, replacing the `ComingSoon` placeholder currently rendered for the `'league-setup'` nav item in `web/src/screens/commissioner/index.tsx`. This is the primary UI over PRD §4.4 (access/passwords), §5 (league and team configuration, including §5.1 team media and §5.2 draft scheduling), §10 (multi-source AAV selection), and §41 (pre-draft readiness), and realizes `screen-information-architecture.md §0.2` ("Commissioner Setup"). Entities touched are defined in `.aah/architecture/data-model.md §3.1` (League, Team, RosterConfiguration, RosterSlotDefinition, AuctionConfiguration, WhammyConfig).

**Stack:** React 18 + Vite 5 + TypeScript (frontend, `web/src/screens/commissioner/`); Node.js 20 + Fastify 4.x (backend, `server/src/league/routes.ts`, extended); Drizzle ORM migrations against the existing `leagues`/`teams` tables in `server/db/schema/index.ts`; Zod via `shared-types` for request/response validation, extending `shared-types/src/schemas/league.ts`.

**Schema additions (db layer).** Per module-map: `leagues.logo_url` (nullable text), `leagues.name_lock` (boolean, default false), `leagues.scheduled_draft_start_at` (nullable timestamptz), `leagues.status_message` (nullable text — the commissioner-entered free-text note `screen-information-architecture.md` §0.1 calls "readiness/status messaging from the commissioner if provided"; MOD-014's Pre-Draft Lobby reads and renders it, rendering nothing when null); `teams.starting_budget_override_minor` (nullable integer cents, falls back to `AuctionConfiguration.initial_budget_minor` when null). PRD §4.4 also requires an optional Host password distinct from the Commissioner and Team passwords; since no host-credential column or HOST login path exists anywhere in the current schema (`leagues` has only `site_password_hash`/`commissioner_password_hash`) or auth routes (`server/src/auth/routes.ts`'s `LeagueAuthRequestSchema` role enum is only `COMMISSIONER | OWNER`), this module adds `leagues.host_password_hash` (nullable text) **and** extends the existing `POST /auth/league/:id` login endpoint (already-shipped MOD-000 code, but this is a small, additive, backward-compatible extension — not a rework of what MOD-000 already does) with a `role: 'HOST'` branch that verifies against `host_password_hash` and issues a JWT carrying `role: 'HOST'` and the league_id, with no team_id and no commissioner mutation rights (PRD §4.3: presentation-only role, separate password, never the commissioner password). This keeps host-password generation (below) actually usable end-to-end rather than generating a credential nothing can log in with.

**API layer.** Extends `server/src/league/routes.ts` with the endpoints module-map lists for this module: `PUT /leagues/:id`, `PUT /leagues/:id/teams/:teamId`, `POST /leagues/:id/passwords/generate`, `GET /leagues/:id/readiness`. It also adds `PUT /leagues/:id/config/whammy`, following the `/leagues/:id/config/*` naming convention MOD-001 already established for `PUT /leagues/:id/config/roster` and `PUT /leagues/:id/config/auction` — module-map's description explicitly calls for a "Whammy configuration form... over MOD-009's WhammyConfig" but MOD-009 (`server/src/draft/whammy.ts`) only ever reads `WhammyConfig` for trigger validation and never added a write path, so this module supplies it. The existing roster/auction config PUT endpoints and MOD-016's `PUT /leagues/:id/datasets/:id/aav-sources` and MOD-015's `POST`/`DELETE /leagues/:id/teams/:teamId/media` are called by this UI unchanged, per module-map's MOD-016 and MOD-015 entries respectively.

`schema/MOD-010-api-schema.yaml` already exists in `.aah/architecture/schema/`, with `produces` operationIds matching exactly the operations named below (`updateLeague`, `updateTeam`, `generatePasswords`, `getDraftReadiness`, `setWhammyConfig`) — no schema-authoring action is needed for those. This module also calls three operations owned by other already-shipped/already-specced modules unchanged: MOD-001's `setRosterConfig`/`setAuctionConfig` (`PUT /leagues/:id/config/roster`, `PUT /leagues/:id/config/auction`), MOD-015's `uploadTeamMedia`/`deleteTeamMedia`, and MOD-016's `setAavSources` — see `## API Contracts`' `consumes` list below.

**Post-launch gap-review additions (2026-09).** A live gap review found three problems in this module's shipped surface, all confirmed by reading current code:

1. **Teams nav section is a dead placeholder with no team CRUD anywhere in the app.** `web/src/screens/commissioner/index.tsx` renders `activeSection === 'teams'` as a bare `<ComingSoon label="Teams" />` with no wiring at all. The backend is only half-missing: `server/src/league/routes.ts` already has `POST /leagues/:leagueId/teams` (creates a team with `name`, `team_password`, `draft_order`, per `CreateTeamRequestSchema` in `shared-types/src/schemas/league.ts`) and `GET /leagues/:leagueId/teams`, both already used by `LeagueSetup.tsx`'s existing team roster table (budget override, name-lock, media, draft-order fields). There is **no team-removal endpoint** — no `DELETE /leagues/:leagueId/teams/:teamId` exists anywhere in `server/src/league/routes.ts`. This module adds that DELETE endpoint (blocked once a draft for the league has ever left `CREATED` status, since removing a team the draft engine has already assigned budget/roster state to would corrupt `draft_team_states`) and adds "Add Team" (name + password + draft order) and "Remove Team" controls to the existing team roster table in `LeagueSetup.tsx` (not a new screen — the per-team fields this module already manages there: starting-budget override, name-lock, icon/media, must keep working unchanged for teams added this way), replacing the `teams`-nav `ComingSoon` with a view of the same team list/management UI (or a thin nav-level redirect into League Setup's team table — implementer's choice, but there must be no second, duplicate team-editing UI).
2. **Ambiguity Resolution screen and its data pipeline are dead code, and the backend does not yet expose ambiguous candidates structurally.** `web/src/screens/commissioner/AmbiguityResolution.tsx` is a complete, working component expecting `ambiguousRows: AmbiguousRow[]` (`{ row_number, raw_name, raw_position, candidates: PlayerCandidate[] }`) and an `onResolve` callback. `CommissionerConsole` (`web/src/screens/commissioner/index.tsx`) already accepts `ambiguousRows`/`onResolveAmbiguity` props and renders the component when both are non-empty — but `CommissionerRoute` in `web/src/App.tsx` never supplies either prop, so the component is unreachable in the running app. Worse, on the backend, `upsertRows` in `server/src/player/routes.ts` (used by the CSV/Excel/ESPN-PDF/FantasyPros import handlers) does not currently surface ambiguous matches as structured data at all: when a raw CSV name/position pair matches more than one existing `players` row (`existing.length > 1`, around line 177), the row is simply skipped and recorded as a plain string in `importErrors` (`Ambiguous player match for '...' (...)`.), with the candidate list itself (`existing`) discarded and never returned to the client, and there is no resolve endpoint anywhere in the codebase today. This module therefore: (a) changes `upsertRows` to collect skipped ambiguous rows as structured `{ row_number, raw_name, raw_position, candidates }` (populating `candidates` from the `existing` rows already fetched, mapped to `{ id, name, position, nfl_team }`) instead of only a string message, (b) adds those to the import response returned by the CSV/Excel/ESPN-PDF/FantasyPros endpoints in `server/src/player/routes.ts` as `ambiguous_rows`, alongside the existing `errors` array (existing `errors` behavior for other error kinds is unchanged), (c) adds a new endpoint to resolve them — `POST /leagues/:leagueId/datasets/:datasetId/ambiguities/resolve` — that accepts the same `Record<row_number, player_id | 'skip'>` shape `AmbiguityResolution.tsx`'s `onResolve` already produces, and for each resolved row either creates the `playerAavSources` link to the chosen `player_id` or discards the row when `'skip'`, and (d) wires `App.tsx`'s `CommissionerRoute` to hold the last import's `ambiguous_rows` in state, pass them as `ambiguousRows` to `CommissionerConsole`, and pass an `onResolveAmbiguity` handler that calls the new resolve endpoint and clears resolved rows from state on success.
3. **Bug: starting-budget save/display path stores/shows a corrupted value.** Live repro showed every team's starting budget rendering as a garbled value (e.g. `200250`) across Draft Room, War Room, and Draft Control, with the league-wide total scaling consistently across all 12 teams — i.e. a real stored/config value, not a per-screen rendering bug. Reading the current save/read round trip in `LeagueSetup.tsx` (`submitAuctionConfig`, line ~380: `Math.round(parseFloat(initialBudget) * 100)` sent as `initial_budget_minor`; `refreshAuctionConfig`, line ~250: `String(d.initial_budget_minor / 100)` on read) and the `PUT`/`GET /leagues/:leagueId/config/auction` handlers in `server/src/league/routes.ts` (which `Math.trunc()` and store the value as given, with no further scaling) shows this specific dollars-to-minor-units conversion is correct as written today. This module's fix work is therefore to **reproduce the bug against a fresh save cycle** (enter a budget in the League Setup form, save, and trace the exact value written to `auction_configurations.initial_budget_minor`) rather than assume the cause, and check in particular: (i) whether `server/src/auction/routes.ts`'s draft-start handler (~line 151), which copies `cfg.initial_budget_minor` into every team's `draft_team_states.remaining_budget_minor` at draft start, is the source — note it currently ignores each team's `teams.starting_budget_override_minor` entirely and applies the league-wide `initial_budget_minor` to every team uniformly, which on its own does not explain a per-team-scaled garbled value but is a real, separate correctness bug this module must also fix (the override this module's own team roster table lets a commissioner set must actually take effect at draft start: `remaining_budget_minor` should seed from `starting_budget_override_minor` when set, else `initial_budget_minor`); (ii) whether the corrupted value was written by some other write path this review didn't find (a migration default, a stale seed run, or a since-changed form state bug now fixed but never corrected in already-saved rows) — if so, the fix must correct the root write path AND provide a one-time correction of already-stored bad values, not just prevent new ones. Do not patch `formatMoney` or any other display formatter if the stored value itself is wrong — every downstream consumer (Draft Room, War Room, Draft Control) reads the same `remaining_budget_minor`/`initial_budget_minor` column and must self-correct once the source data is fixed.

**UI layer.** All work happens in `web/src/screens/commissioner/`, following the existing folder layout (`architecture-overview.md §7`) and reusing the bespoke CSS custom-property design-token system already established in `commissioner-console.css` (`--color-bg`, `--color-chrome`, `--space-*`, `--font-display`, etc.) — this project has no `design-spec.yaml` or wireframe set; the existing CSS token system across `commissioner-console.css`/`draft-room.css`/`war-room.css` is the authoritative visual source. New components: league identity form (name, logo, name-lock toggle), password generation panel (commissioner/host/team, shown-once values, manual override), roster/scoring/auction configuration forms wrapping the existing MOD-001 config endpoints, a team roster table (per-team starting-budget override, name-lock display, media upload trigger from MOD-015), scheduled-start-time picker, AAV Primary/Secondary source dropdowns (from MOD-016), a Whammy configuration form, and the pre-draft readiness checklist (PRD §41). The scheduled start time this module writes must also be surfaced (read-only) in the existing Pre-Draft Lobby, Draft Room, and War Room headers, showing "Not yet scheduled" when unset, per PRD §5.2.

**Behavioral expectations:**

- Given the Commissioner Console renders, when the commissioner selects the "League Setup" nav item, then the `LeagueSetup` component renders in place of the `ComingSoon` placeholder that currently occupies that section in `web/src/screens/commissioner/index.tsx`.
- Given a migration runs, then `leagues` has `logo_url`, `name_lock` (default false), `scheduled_draft_start_at`, and `host_password_hash` columns, and `teams` has `starting_budget_override_minor`; none of these columns are populated by any other existing module.
- Given the commissioner submits the league identity form (name, logo, name-lock toggle), when `PUT /leagues/:id` is called with a valid commissioner JWT, then the server updates the League row and returns the updated summary including `logo_url` and `name_lock`, and rejects the request (without JWT or with a non-commissioner JWT) with an auth error.
- Given the commissioner sets, edits, or clears a free-text status message, when `PUT /leagues/:id` is submitted with `status_message`, then the value is persisted and readable back; when it has never been set, reads return null and the Pre-Draft Lobby (MOD-014) renders nothing for that section rather than an empty box.
- Given the commissioner sets or clears the scheduled draft start date/time, when `PUT /leagues/:id` is submitted with `scheduled_draft_start_at`, then the value is persisted and readable back; when it has never been set, reads return null and any header consuming it displays "Not yet scheduled" (PRD §5.2) — setting it never transitions the draft's own status.
- Given `leagues.host_password_hash` is set, when `POST /auth/league/:id` is called with `{ role: 'HOST', password }` matching that hash, then the server returns a valid JWT carrying `role: 'HOST'` and the league's `id` with no `team_id`, and that token is accepted by presentation-only endpoints but rejected by every commissioner-mutation endpoint (PRD §4.3); when `host_password_hash` is unset, the same request is rejected rather than accepted with a null/empty comparison.
- Given the commissioner clicks "Generate" for the commissioner, host, or a specific team's password, when `POST /leagues/:id/passwords/generate` is called, then the server generates a cryptographically random password, stores only its bcrypt hash (work factor 12, matching the MOD-000 convention already used for `commissioner_password_hash`/`team_password_hash`), bumps the affected scope's `auth_epoch` (invalidating previously issued tokens for that scope), and returns the plaintext value exactly once in the response body; the plaintext is never persisted, logged, or returned again on subsequent calls.
- Given the commissioner instead types a custom password value for one of those targets, when the same endpoint is called with an explicit password supplied, then the server hashes and stores exactly the value entered rather than generating a random one.
- Given the commissioner submits the roster and auction configuration forms, when they call the existing `PUT /leagues/:id/config/roster` and `PUT /leagues/:id/config/auction` endpoints unchanged, then a success state renders on 200, and a server-side invariant violation (e.g. `total_roster_size != sum(slot_count) + bench_slots`) is surfaced as a form-level validation message rather than failing silently.
- Given the commissioner enters a starting-budget override for a team in the team roster table, when `PUT /leagues/:id/teams/:teamId` is called with `starting_budget_override_minor` as an integer-cents value (or null to clear it), then the server persists it on that team row, and the UI displays the effective per-team budget as the override when set or `AuctionConfiguration.initial_budget_minor` otherwise.
- Given the commissioner toggles a team's name-lock, when `PUT /leagues/:id/teams/:teamId` is submitted with `name_lock`, then the flag is persisted and shown in the team roster table so other modules (e.g. owner-side rename in the Lobby) can honor it.
- Given the commissioner reorders a team's draft position in the team roster table (e.g. drag/reorder or up/down controls), when `PUT /leagues/:id/teams/:teamId` is called with the team's new `draft_order`, then the value is persisted and the team roster table reflects the new order; the nomination-turn rotation (MOD-002) reads `draft_order` from the same `teams` row, so this is the single source of truth for nomination sequence, not a display-only value.
- Given the commissioner uses the media upload control for a team in this section, when an icon and/or nomination MP3 is submitted, then it calls MOD-015's existing `POST /leagues/:id/teams/:teamId/media` (and `DELETE` to remove), and the resulting `icon_url` renders in the team roster table.
- Given at least one AAV source has been imported into the league's active dataset (MOD-016), when the commissioner opens the Primary/Secondary AAV source dropdowns, then they are populated from the dataset's currently-loaded sources and a selection calls MOD-016's existing `PUT /leagues/:id/datasets/:id/aav-sources`; when no sources are loaded yet, the dropdowns render disabled rather than erroring.
- Given the commissioner submits the Whammy configuration form (enabled, max_amount_minor, allowed_event_types, allow_positive, allow_negative, max_per_team, max_per_draft, commissioner_approval_required), when `PUT /leagues/:id/config/whammy` is called, then the server upserts the league's single `WhammyConfig` row, and a subsequent `POST /drafts/:id/whammy` (MOD-009) immediately validates against the newly saved constraints (e.g. an amount exceeding the updated `max_amount_minor` is rejected).
- Given the commissioner opens the readiness checklist, when `GET /leagues/:id/readiness` is called, then the response contains one pass/fail row per PRD §41 item this project models — team count, roster configuration (total size and starter-slot definitions), budget feasibility, unresolved/ambiguous dataset players, dataset frozen state, AAV source selection (including Primary selected), timer configuration, Auto-Agent defaults, team media validity, and Whammy configuration — each row is deterministically PASS or FAIL, never a third state.
- Given every readiness prerequisite is satisfied (12 teams, valid roster config, budget feasible, dataset FROZEN with no unresolved ambiguous rows, AAV sources selected, timers configured, Auto-Agent defaults set, team media valid, Whammy configured or intentionally disabled), when the checklist re-renders, then every row shows PASS, matching this module's demo criteria.
- Given any form or panel in this section renders, then it is styled using only the existing CSS custom properties already defined for the Commissioner Console (as used in `commissioner-console.css`), introducing no new hardcoded hex colors or pixel-value styles.
- Given the commissioner selects the "Teams" nav item, then a real team-management view renders (not `ComingSoon`) showing the same team list already used by League Setup's team roster table (name, draft order, starting-budget override, name lock, media, icon).
- Given the commissioner submits the "Add Team" form (name, team password, draft order), when `POST /leagues/:leagueId/teams` is called (existing endpoint, unchanged), then the new team appears in both the Teams section and League Setup's team roster table, immediately editable via the existing per-team fields (budget override, name-lock, media).
- Given the commissioner clicks "Remove Team" for a team, when `DELETE /leagues/:leagueId/teams/:teamId` is called with a valid commissioner JWT, then the team row is deleted and no longer appears in either the Teams section or League Setup, and the readiness checklist's team-count row reflects the new count; when the league's draft has ever left `CREATED` status, the server rejects the deletion (409) rather than deleting a team the draft engine already holds state for.
- Given a CSV/Excel/ESPN-PDF/FantasyPros import produces one or more rows that match multiple existing players, when the import response is returned, then it includes `ambiguous_rows: { row_number, raw_name, raw_position, candidates: { id, name, position, nfl_team }[] }[]` in addition to the existing `errors` array, and `App.tsx`'s `CommissionerRoute` stores that list and passes it to `CommissionerConsole` as `ambiguousRows`.
- Given `ambiguousRows` is non-empty, when the commissioner opens Dataset Import, then `AmbiguityResolution` renders (it is no longer unreachable), listing each ambiguous row with its candidates.
- Given the commissioner resolves each ambiguous row (pick a candidate or "skip") and confirms, when `onResolveAmbiguity` fires, then `POST /leagues/:leagueId/datasets/:datasetId/ambiguities/resolve` is called with `{ [row_number]: player_id | 'skip' }`; on success, each resolved row either links the chosen player into the dataset's `playerAavSources` or is discarded (`'skip'`), and the resolved rows are cleared from `ambiguousRows` state so the panel shrinks to only the rows still pending.
- Given a league has any team with `starting_budget_override_minor` set, when a draft for that league transitions from `CREATED` to `RUNNING` (draft start), then that team's `draft_team_states.remaining_budget_minor` is seeded from the override, not from the league-wide `auction_configurations.initial_budget_minor` — every other team without an override still seeds from the league-wide value.
- Given the commissioner saves a starting budget of $200 in League Setup, when Draft Room, War Room, and Draft Control subsequently read that team's budget, then all three display exactly $200 (not a scaled, concatenated, or otherwise corrupted value), confirming the fix is in the stored value and not a per-screen display patch.

## Api Contracts
```yaml
consumes:
  - operation_id: setRosterConfig
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: RosterConfigRequest
    response_schema: "200 OK (no response body)"
  - operation_id: setAuctionConfig
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: AuctionConfigRequest
    response_schema: "200 OK (no response body)"
  - operation_id: uploadTeamMedia
    schema_file: schema/MOD-015-api-schema.yaml
    request_schema: "multipart/form-data (icon, nomination_audio)"
    response_schema: TeamMediaResponse
  - operation_id: deleteTeamMedia
    schema_file: schema/MOD-015-api-schema.yaml
    request_schema: DeleteTeamMediaRequest
    response_schema: TeamMediaResponse
  - operation_id: setAavSources
    schema_file: schema/MOD-016-api-schema.yaml
    request_schema: SetAavSourcesRequest
    response_schema: AavSourceSelectionResponse
produces:
  - operation_id: updateLeague
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: UpdateLeagueRequest
    response_schema: LeagueSummary
  - operation_id: updateTeam
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: UpdateTeamRequest
    response_schema: TeamSummary
  - operation_id: generatePasswords
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: GeneratePasswordsRequest
    response_schema: GeneratePasswordsResponse
  - operation_id: getDraftReadiness
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: "(none)"
    response_schema: ReadinessResponse
  - operation_id: setWhammyConfig
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: WhammyConfigRequest
    response_schema: "200 OK (no response body)"
  - operation_id: deleteTeam
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: "(none)"
    response_schema: "200 OK (no response body); 409 Conflict if the league's draft has left CREATED status"
  - operation_id: resolveAmbiguousMatch
    schema_file: schema/MOD-010-api-schema.yaml
    request_schema: ResolveAmbiguousMatchRequest
    response_schema: "200 OK (no response body)"
```
**New schema additions needed for the above (not yet in `schema/MOD-010-api-schema.yaml`):** `deleteTeam` (`DELETE /leagues/:leagueId/teams/:teamId`) and `resolveAmbiguousMatch` (`POST /leagues/:leagueId/datasets/:datasetId/ambiguities/resolve`, request body `{ resolutions: Record<string, string> }` where each value is a `player_id` or the literal `'skip'`). This module also changes the response shape of MOD-016's existing CSV/Excel/ESPN-PDF/FantasyPros import endpoints (`server/src/player/routes.ts`) to add `ambiguous_rows` alongside their existing `errors` array — an additive, backward-compatible field, not a breaking change to `ImportResultSchema` in `shared-types/src/schemas/league.ts`, which this module extends with an `ambiguous_rows` field and an `AmbiguousRowSchema`/`PlayerCandidateSchema` pair.