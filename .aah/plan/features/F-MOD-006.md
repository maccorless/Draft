## Id
F-MOD-006

## Title
Draft Completion, Reports, and Nominator Match

## Module Ref
MOD-006

## Description
MOD-006 closes out a completed draft: it auto-transitions the `Draft` record to `COMPLETE` when the last `PlayerAuction` is awarded, generates a `DraftSummaryReport` snapshot, renders an ESPN-compatible roster entry worksheet for download, dispatches a post-draft summary email via SendGrid (stubbed at 202 until Phase 9), and enforces the one-per-draft Nominator Match right.

**Stack and platform context:** Node.js 20+ LTS, Fastify 4.x, PostgreSQL 15+ via Drizzle ORM (postgres.js driver), React 18 + Vite 5 + TypeScript, Zod 3.x in `shared-types`, native `ws` WebSockets with sequence-numbered envelopes. Deployed on Railway. Observe every constraint in `.aah/discuss/discuss-prd.md` §Architectural Constraints and `.aah/architecture/architecture-overview.md` §Design Principles.

**Entity and schema references:** read `.aah/architecture/data-model.md` for the full field-level schemas of `Draft` (including `status: CREATED | RUNNING | PAUSED | COMPLETE` and `completed_at`), `NominatorMatch` (`used`, `used_at`), `Acquisition`, `RosterEntry`, `BudgetLedgerEntry`, `DraftEvent`, and `DraftTeamState`. The `DraftSummaryReport` is a generated snapshot — not a mutable Postgres entity with live authority — but must be durably stored (or regenerable from live rows) so it survives server restart. All money fields are `*_minor` integers; no floating point.

**Application flow reference:** see `.aah/architecture/application-flow.md` for where draft completion and report generation sit in the end-to-end flow. See `.aah/architecture/module-map.yaml` entry `id: MOD-006` for the full capability list.

**Report generation performance:** per `resolved-standards.yaml` rule `EXTRACTED-016`, report generation must run off the main event loop if heavy enough to threaten a concurrently RUNNING draft's latency (use `node:worker_threads` or async chunked processing; never block the event loop).

**Nominator Match mechanics (from `discuss-prd.md` user story 2 and `data-model.md` §NominatorMatch):** one row per team per draft; `used` is a boolean set irreversibly on first use. The WS command `NOMINATOR_MATCH` enters the per-draft serialized command queue; the first receipt wins — a second attempt from the same team emits `NOMINATOR_MATCH_CONSUMED` and is rejected without state change. A valid use ties the current bid price (does not raise it), requires that (a) the normal bidding timer is still active, (b) the requesting team does not already hold the lead, and (c) another team currently leads. `bid_type = NOMINATOR_MATCH` is recorded in `BidAttempt`; `NominatorMatch.used` and `used_at` are set in the same transaction as the `BidAttempt` row and `DraftEvent: NOMINATOR_MATCH_USED`.

**SendGrid stub:** `POST /drafts/:id/report/email` (mapped as `emailDraftReport` in the API schema) triggers email to all `Team.owner_email` addresses. Until Phase 9 wire-up, the SendGrid call is replaced by a stub that logs the call and returns HTTP 202 with `{ accepted: true, recipients: N }`. Email delivery failure must never affect in-app report availability (rule `EXTRACTED-038`).

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

## Constraints
