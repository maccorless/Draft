## Id
F-MOD-006

## Title
Draft Completion, Reports, and Nominator Match

## Module Ref
MOD-006

## Description
MOD-006 closes out a completed draft: it auto-transitions the `Draft` record to `COMPLETE` when the last `PlayerAuction` is awarded, generates a `DraftSummaryReport` snapshot, renders an ESPN-compatible roster entry worksheet for download, dispatches a post-draft summary email via SendGrid, and enforces the one-per-draft Nominator Match right. Post-launch gap review (PRD §37 "ESPN Transfer") added a full ESPN post-draft transfer workstream — team-to-ESPN-team mapping, transfer reconciliation tracking, and a canonical JSON export — plus real (non-stub) SendGrid email delivery.

**Post-launch addition — ESPN transfer workflow (PRD §37; entities already specified in `data-model.md` §19, none of them implemented yet — this feature builds the missing endpoints against the existing schema, it does not invent new entities):**

The application never calls an ESPN API (constraint `EXTRACTED-039` — unchanged). The transfer workflow is entirely: map internal teams to their ESPN counterparts, export data in three formats, and track which acquisitions the commissioner has manually confirmed inside ESPN's own Offline Draft entry screen.

- **Team → ESPN-team mapping**, using `ProviderTeamMapping` (`data-model.md` §19.2, PK `[league_id, provider_code, team_id]`, `provider_code = 'ESPN'`). `GET /leagues/:leagueId/espn-team-mappings` returns one row per league `Team` — `external_team_id`, `external_team_name`, `verified`, and, for any team with no `external_team_id` yet, a `candidates` array of ESPN team names from previously-entered mappings or commissioner-entered ESPN league data whose name similarity to `Team.name` is above a low threshold but not high enough to auto-select. Auto-matching is a simple case-insensitive/normalized string comparison — this is name matching for a UI mapping step, not the strategic-valuation-prohibited domain (CLAUDE.md #6), and it never guesses when more than one ESPN team clears the threshold. `PUT /leagues/:leagueId/espn-team-mappings/:teamId` (commissioner-only) sets or corrects `external_team_id`/`external_team_name` and sets `verified = true`; commissioner input always overrides any auto-match candidate. A team with `external_team_id = null` remains **unmapped/ambiguous** and is surfaced as a blocking checklist item before the commissioner is guided into ESPN entry (PRD §37 step 2 and step 7 — "flag ambiguous/unresolved mappings" is this step, distinct from the dataset-import player-name ambiguity resolution already built elsewhere, which resolves CSV/AAV-PDF player identity at import time, not team identity at transfer time).
- **Canonical JSON export**, backed by `ExportJob` (`data-model.md` §19.3, `provider_code`, `schema_version`, `status: PENDING|VALIDATED|GENERATED|FAILED`, `artifact_uri`/`artifact_checksum` nullable, `validation_json`). `GET /drafts/:draftId/export/canonical` requires `Draft.status = COMPLETE`; on first call it creates (or reuses, idempotently, if one already exists for this draft+provider) an `ExportJob` row, validates internal roster integrity (every active `Acquisition` has exactly one active `RosterEntry`, PRD §37 step 1), and returns a JSON document covering every acquisition in the draft: `player_id`, `player_name`, `position`, `team_id`, `team_name`, `price_minor`, `roster_slot`, `resolution_sequence`. The job's `status` moves `PENDING → VALIDATED → GENERATED`, or to `FAILED` with `validation_json` describing what failed (e.g. a roster slot with no active `RosterEntry`) — a `FAILED` job returns its validation errors instead of a partial/invented export. This is additive to the existing generic CSV/ESPN worksheet exports; none of the three output formats replaces another (PRD §37 "Exports include").
- **Reconciliation tracking**, backed by `ReconciliationItem` (`data-model.md` §19.4, FK `ExportJob`, one row per `(team_id, player_id)`, `status: PENDING|CONFIRMED|AMBIGUOUS|FAILED`, `recommended_target_slot` nullable, `confirmed_by_user_id`/`confirmed_at` nullable). Rows are seeded (one per active `Acquisition`, `status = PENDING`, `recommended_target_slot` from the acquisition's active `RosterEntry`) the first time either `GET /drafts/:draftId/export/canonical` or the existing `GET /drafts/:draftId/espn-worksheet` succeeds for a draft — whichever export path runs first creates the `ExportJob` and its `ReconciliationItem` rows; the second path reuses them rather than re-seeding duplicates. `GET /drafts/:draftId/reconciliation` (any league member) lists every `ReconciliationItem` for the draft with its player/team/status. `POST /drafts/:draftId/reconciliation/:itemId/confirm` (commissioner-only) transitions one item's `status` to `CONFIRMED`, recording `confirmed_by_user_id` and `confirmed_at` — this is the commissioner marking, inside this app, that they've verified a specific player landed correctly in ESPN's Offline Draft screen (PRD §37 step 6, "track confirmed players"). There is no ESPN-side confirmation call; this is bookkeeping the commissioner drives manually. When every `ReconciliationItem` for a draft is `CONFIRMED`, the draft's transfer is considered reconciled (PRD §37 step 8) — surfaced as a computed `all_confirmed: bool` on the `GET /drafts/:draftId/reconciliation` response, not a new persisted field.

**Post-launch addition — real SendGrid email delivery (replaces the Phase-9 stub referenced in the original description above):** `POST /drafts/:id/report/email` now sends actual email via the SendGrid v3 Mail Send API using `SENDGRID_API_KEY` (already catalogued in `F-MOD-000`'s `.env.example`/env-check registration — reused as-is, not reinvented) and a new `SENDGRID_FROM_EMAIL` sender address (SendGrid requires a verified sender identity; this cannot be hardcoded and must go through the same three-step env contract — feature-file listing, `.env.example` placeholder, `config/env-check.cjs` registration — in the same change that adds the send call). Per PRD §36.4: each owner with a non-empty `Team.owner_email` is sent their own `DraftTeamReport` (owner view — full pick list, spend, remaining budget, per-team metrics); the commissioner's `User.email` is sent the league-wide `DraftSummaryReport` (league summary view — all teams side by side). Every send attempt (one per recipient) writes a `ReportDeliveryAttempt` row (`data-model.md` §19.7: `recipient_email`, `status: PENDING|SENT|FAILED|SKIPPED_EMAIL_DISABLED`, `sent_at`, `error_detail`) — `SKIPPED_EMAIL_DISABLED` when a team has no `owner_email` on file. A SendGrid API failure for one recipient is caught, recorded as `FAILED` with `error_detail`, and never prevents delivery to other recipients or affects in-app report availability (`EXTRACTED-038`, unchanged). The endpoint's response `recipients` count reflects attempted sends (rows written), not confirmed deliveries — SendGrid delivery is asynchronous and out of scope to track further.

**Stack and platform context:** Node.js 20+ LTS, Fastify 4.x, PostgreSQL 15+ via Drizzle ORM (postgres.js driver), React 18 + Vite 5 + TypeScript, Zod 3.x in `shared-types`, native `ws` WebSockets with sequence-numbered envelopes. Deployed on Railway. Observe every constraint in `.aah/discuss/discuss-prd.md` §Architectural Constraints and `.aah/architecture/architecture-overview.md` §Design Principles.

**Entity and schema references:** read `.aah/architecture/data-model.md` for the full field-level schemas of `Draft` (including `status: CREATED | RUNNING | PAUSED | COMPLETE` and `completed_at`), `NominatorMatch` (`used`, `used_at`), `Acquisition`, `RosterEntry`, `BudgetLedgerEntry`, `DraftEvent`, and `DraftTeamState`. The `DraftSummaryReport` is a generated snapshot — not a mutable Postgres entity with live authority — but must be durably stored (or regenerable from live rows) so it survives server restart. All money fields are `*_minor` integers; no floating point.

**Application flow reference:** see `.aah/architecture/application-flow.md` for where draft completion and report generation sit in the end-to-end flow. See `.aah/architecture/module-map.yaml` entry `id: MOD-006` for the full capability list.

**Report generation performance:** per `resolved-standards.yaml` rule `EXTRACTED-016`, report generation must run off the main event loop if heavy enough to threaten a concurrently RUNNING draft's latency (use `node:worker_threads` or async chunked processing; never block the event loop).

**Nominator Match mechanics (from `discuss-prd.md` user story 2 and `data-model.md` §NominatorMatch):** one row per team per draft; `used` is a boolean set irreversibly on first use. The WS command `NOMINATOR_MATCH` enters the per-draft serialized command queue; the first receipt wins — a second attempt from the same team emits `NOMINATOR_MATCH_CONSUMED` and is rejected without state change. A valid use ties the current bid price (does not raise it), requires that (a) the normal bidding timer is still active, (b) the requesting team does not already hold the lead, and (c) another team currently leads. `bid_type = NOMINATOR_MATCH` is recorded in `BidAttempt`; `NominatorMatch.used` and `used_at` are set in the same transaction as the `BidAttempt` row and `DraftEvent: NOMINATOR_MATCH_USED`.

**SendGrid delivery:** `POST /drafts/:id/report/email` (mapped as `emailDraftReport` in the API schema) sends real email via SendGrid to each team's `owner_email` (owner view) and the commissioner's `User.email` (league summary view) — see the "real SendGrid email delivery" subsection above for the per-recipient view split and `ReportDeliveryAttempt` tracking. The response remains HTTP 202 with `{ accepted: true, recipients: N }`. Email delivery failure must never affect in-app report availability (rule `EXTRACTED-038`).

**ESPN worksheet format:** the export (`getEspnWorksheet`) produces a CSV or XLSX file in ESPN roster-entry order — one row per acquisition, ordered for manual ESPN entry. The system does not call any ESPN API (constraint `EXTRACTED-039` and `architecture-overview.md` §1 out-of-scope table).

**Environment variables:** `SENDGRID_API_KEY` is read by the email dispatch path. All three steps (feature file listing, `.env.example` placeholder, startup checker registration) must land in the same change, or the app boots with `ERR_CDR_78_EX_CONFIG`. The startup env checker lives at `config/env-check.cjs` (Node/TypeScript project convention from MOD-000).

**Behavioral expectations:**

- Given all `PlayerAuction` rows for a draft reach `AWARDED` status, when the last award transaction commits, then `Draft.status` is set to `COMPLETE` and `Draft.completed_at` is populated in the same transaction; a `DRAFT_COMPLETE` broadcast is sent to all connected clients.
- Given `Draft.status = COMPLETE`, when `GET /drafts/:id/report` is called by any authenticated member of the league, then the response is a `DraftSummaryReport` JSON matching the schema in `schema/MOD-006-api-schema.yaml`: `draft_id`, `completed_at`, and a `teams` array where each entry carries `team_id`, `team_name`, `final_budget_minor` (remaining unspent budget from `DraftTeamState`), and `acquisitions` (player name, position, price in minor units, roster slot) — all acquisitions present and none invented.
- Given `Draft.status = COMPLETE`, when `GET /drafts/:id/espn-worksheet` is called, then the response is a downloadable CSV or XLSX file in ESPN roster-entry order with one row per acquisition; no ESPN API is called; the `Content-Disposition` header names the file with the draft id.
- Given `POST /drafts/:id/report/email` is called by a commissioner, when the SendGrid stub is active, then the stub logs the dispatch attempt and returns HTTP 202 with `accepted: true` and the correct `recipients` count; in-app report availability is unchanged whether the call succeeds or fails.
- Given the `DraftSummaryReport` has been generated, when the server restarts, then the report remains accessible via `GET /drafts/:id/report` (either durably stored in Postgres or regenerated from live `Acquisition` + `DraftTeamState` rows without data loss).
- Given a team owner issues the `NOMINATOR_MATCH` WS command during an active nomination (timer running, the requesting team does not lead, another team leads), then the command enters the per-draft serialized queue; upon processing, a `BidAttempt` row is written with `bid_type = NOMINATOR_MATCH` and `accepted = true`, `NominatorMatch.used` is set to `true` and `used_at` populated in the same transaction, `NOMINATOR_MATCH_USED` is appended to `DraftEvent`, and all connected clients receive a broadcast reflecting the tied bid and the new leader.
- Given a team owner whose `NominatorMatch.used = true` issues a second `NOMINATOR_MATCH` command, when processed, then the server appends `NOMINATOR_MATCH_CONSUMED` to `DraftEvent`, rejects the command with an error response, and `NominatorMatch.used` remains `true` with no state change; `BidAttempt` records the rejected attempt with `accepted = false`.
- Given `NOMINATOR_MATCH` is attempted when the timer is not active, or the requesting team already leads, or no other team leads, then the command is rejected with a descriptive error; no state is mutated and no `NOMINATOR_MATCH_USED` event is emitted.
- Given the Draft Complete screen loads after `DRAFT_COMPLETE` broadcasts (or on page load for a COMPLETE draft), when a team owner views it, then they see final standings, each team's roster with awarded players and prices, and each team's remaining budget; no ad hoc player data is shown beyond what is in `DraftSummaryReport`.
- Given the Draft Complete screen loads for a commissioner, when they interact with it, then the "Export worksheet" button triggers download of `GET /drafts/:id/espn-worksheet`, and the "Send summary email" button posts to `POST /drafts/:id/report/email` and shows a confirmation with recipient count; both buttons are keyboard-accessible semantic `<button>` elements with `aria-label`.
- Given the Draft Room is active for a team whose `NominatorMatch.used = false`, when a nomination is in progress with another team leading, then the Nominator Match button is visible and enabled; given `NominatorMatch.used = true` for that team, then the button is visible but disabled with a clear indication it has been consumed.
- Given `SENDGRID_API_KEY` is absent from the environment at startup, when the application boots, then `config/env-check.cjs` exits with `ERR_CDR_78_EX_CONFIG` naming `SENDGRID_API_KEY` among the missing variables and pointing the user at `cp .env.example .env`; the server does not start.
- Given report generation for a large draft runs concurrently with an active auction on another draft, then report generation does not block the Node.js event loop (runs off the main thread or is chunked) and does not degrade the concurrently RUNNING draft's command queue latency.
- Given any `DraftEvent` rows are written by this module (`NOMINATOR_MATCH_USED`, `NOMINATOR_MATCH_CONSUMED`, `DRAFT_COMPLETE`), then each row's `sequence` is allocated from the per-draft counter inside the same transaction as its companion DB mutations — event log and materialized rows never diverge.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-003

## API Contracts

```yaml
produces:
  - operation_id: getDraftReport
    schema_file: schema/MOD-006-api-schema.yaml
    request_schema: {}
    response_schema: DraftSummaryReport

  - operation_id: getEspnWorksheet
    schema_file: schema/MOD-006-api-schema.yaml
    request_schema: {}
    response_schema:
      type: string
      format: binary
      content_types: [text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet]

  - operation_id: emailDraftReport
    schema_file: schema/MOD-006-api-schema.yaml
    request_schema: {}
    response_schema: EmailDispatchResponse
```

## Required Env Variables
- DATABASE_URL — PostgreSQL connection string
- JWT_SECRET — JWT signing key
- SENDGRID_API_KEY — SendGrid API key for post-draft email dispatch
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

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test SENDGRID_API_KEY=test-key npx vitest run --reporter=verbose server/src/__tests__/F-MOD-006_reports.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-006_reports.test.ts

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
done
