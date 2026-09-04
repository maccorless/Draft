## Id
F-MOD-010

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

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-001
- F-MOD-009
- F-MOD-015
- F-MOD-016

## API Contracts
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
```

## Required Env Variables

## Lint Config

## Test Config

## Constraints
