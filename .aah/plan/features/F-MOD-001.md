## Id
F-MOD-001

## Title
League Setup, Dataset Import, and Draft Creation

## Module Ref
MOD-001

## Description
This module implements the full pre-draft setup path: league and team CRUD, roster and auction configuration, CSV player data import with worker-thread parsing, dataset freeze, and draft creation. It extends the walking skeleton (MOD-000) by adding code to `server/src/league/` and `server/src/player/` (backend) and `web/src/screens/commissioner/` (frontend), following the folder layout in `.aah/architecture/architecture-overview.md §7`.

**Stack:** Node.js 20 + Fastify 4.x (backend); React 18 + Vite 5 (frontend); Drizzle ORM with postgres.js (hybrid: query builder for CRUD); Zod 3.x via `shared-types` for request/response validation; `node:worker_threads` for CSV parsing.

**Data model.** The entities this module creates and reads are defined in `.aah/architecture/data-model.md §3.1` (League, Team, Membership, RosterConfiguration, RosterSlotDefinition, AuctionConfiguration) and `§3.2` (DraftDataset, Player, PlayerDatasetEntry). The Draft entity is defined in `§3.3`; MOD-001 creates the initial Draft row (status=CREATED) but does not operate the auction. Money fields (`initial_budget_minor`, `aav_minor`) are integer cents; no floating point anywhere.

**API surface.** All endpoints are defined verbatim in `.aah/architecture/schema/MOD-001-api-schema.yaml`. The bearer token is a HMAC JWT issued by MOD-000; auth_epoch validation is handled by MOD-000's preHandler hook.

**Dataset import flow.** The full sequencing is described in `.aah/architecture/application-flow.md §6`. A CSV multipart upload triggers a `node:worker_threads` worker that parses rows off the main event loop, returning parsed row objects to the main thread for UPSERT into the Player master table and INSERT into PlayerDatasetEntry. The dataset moves through status states DRAFT → VALIDATED → FROZEN. A dataset must be FROZEN before any Draft can reference it; a FROZEN dataset is immutable.

**UI.** The three UI surfaces for this module are in `web/src/screens/commissioner/`:
1. Dataset import screen: CSV upload dropzone with progress indicator and ImportResult display.
2. Ambiguity resolution UI: side-by-side player match candidates for rows the importer could not auto-resolve; commissioner confirms or overrides each match.
3. Dataset status indicator embedded in the Commissioner Console: shows current dataset status (DRAFT / VALIDATED / FROZEN) and gates the "Create Draft" action on FROZEN status.

There is no separate design-spec or wireframe file for these screens; implement using semantic HTML, Tailwind utility classes consistent with the existing Commissioner Console scaffold from MOD-000, and React hooks per resolved-standards.yaml rules `RX-ARCH-001` and `RX-ARCH-002`.

**Behavioral expectations:**

- Given a valid `CreateLeagueRequest` (name, site_password, commissioner_password), when `POST /leagues` is called, then the server returns 201 with `LeagueSummary` (id, name), stores both passwords as bcrypt hashes at work factor 12 (never plaintext), and assigns a fresh `auth_epoch = 1` to the new League row.
- Given a valid `CreateTeamRequest` (name, team_password, draft_order), when `POST /leagues/:id/teams` is called with a valid commissioner JWT, then the server returns 201 with `TeamSummary` (id, name, draft_order); the team_password is stored as a bcrypt hash.
- Given GET /leagues/:id is called with a valid commissioner JWT, then the server returns the League row (id, name); no password hashes are included in the response.
- Given GET /leagues/:id/teams is called with a valid JWT for that league, then the server returns an array of TeamSummary objects; no password hashes are included.
- Given a valid `RosterConfigRequest` (bench_slots, slots[]), when `PUT /leagues/:id/config/roster` is called, then the server upserts a RosterConfiguration row and replaces all RosterSlotDefinition rows for that league, returning 200; total_roster_size is validated to equal sum of all slot_count values plus bench_slots, and the server returns a 4xx error if this invariant is violated.
- Given a valid `AuctionConfigRequest` with all required timer fields in milliseconds and initial_budget_minor as an integer, when `PUT /leagues/:id/config/auction` is called, then the server upserts an AuctionConfiguration row and returns 200; all timer values are stored as integers (_ms fields) and initial_budget_minor is stored as integer cents with no floating-point conversion.
- Given a league exists, when `POST /leagues/:id/datasets` is called, then the server creates a DraftDataset row with status=DRAFT and version=1, returning 201 with `DatasetSummary`.
- Given a multipart/form-data upload with a CSV file, when `POST /leagues/:id/datasets/:id/import/csv` is called, then the CSV is parsed inside a `node:worker_threads` worker (never on the main event loop), Player rows are upserted into the master table, PlayerDatasetEntry rows are inserted for the dataset, and the response is an `ImportResult` with `rows_imported` count and an `errors` array covering any row-level parse or validation failures; the main event loop is not blocked during parsing.
- Given a dataset with at least one PlayerDatasetEntry, when `POST /leagues/:id/datasets/:id/freeze` is called, then the server sets status=FROZEN, records frozen_at, and returns the updated `DatasetSummary`; any subsequent import attempt on the frozen dataset is rejected with a 409 or 422 error.
- Given a dataset in status=DRAFT or status=VALIDATED, when `POST /leagues/:id/drafts` is called referencing it, then the server returns a 4xx error and no Draft row is written.
- Given a dataset in status=FROZEN, when `POST /leagues/:id/drafts` is called with a valid `CreateDraftRequest` (dataset_id), then the server creates a Draft row with status=CREATED, league_id, and dataset_id, returning 201 with `CreateDraftResponse`.
- Given GET /leagues/:id/players is called with a valid JWT, then the server returns PlayerDatasetEntry rows for the league's active dataset including aav_minor (integer cents), projected_points, tier, and player name/position; no floating-point values appear in the response.
- Given the commissioner is on the dataset import screen, when a CSV file is dropped into the dropzone, then a progress indicator is displayed during upload, and on completion the ImportResult (rows_imported count, per-row errors) is rendered; if errors is non-empty, each error shows its row number and message.
- Given the CSV import returns ambiguous player match candidates (rows that could not be auto-resolved to a unique Player master entry), when the ambiguity resolution UI renders, then each ambiguous row shows at least two side-by-side candidate entries and the commissioner can select confirm or override for each before the import is committed.
- Given the Commissioner Console is loaded, when viewing the dataset section, then the current dataset status (DRAFT / VALIDATED / FROZEN) is displayed prominently; the "Create Draft" button is rendered disabled or absent when status is not FROZEN, and enabled only when status=FROZEN.
- Given DATABASE_URL, JWT_SECRET, or NODE_ENV is absent from the runtime environment, when the application boots (inheriting the MOD-000 startup env checker), then the process exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable before any module reads configuration; all three names are present in `.env.example` with safe placeholder values.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-000

## API Contracts

```yaml
produces:
  - operation_id: createLeague
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: CreateLeagueRequest
    response_schema: LeagueSummary

  - operation_id: createTeam
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: CreateTeamRequest
    response_schema: TeamSummary

  - operation_id: setRosterConfig
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: RosterConfigRequest
    response_schema: "200 OK (no response body)"

  - operation_id: setAuctionConfig
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: AuctionConfigRequest
    response_schema: "200 OK (no response body)"

  - operation_id: createDataset
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: DatasetSummary

  - operation_id: importDatasetCsv
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "multipart/form-data { file: binary }"
    response_schema: ImportResult

  - operation_id: freezeDataset
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: DatasetSummary

  - operation_id: createDraft
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: CreateDraftRequest
    response_schema: CreateDraftResponse

  - operation_id: getLeague
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: LeagueSummary

  - operation_id: listTeams
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: TeamListResponse

  - operation_id: listPlayers
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: PlayerListResponse
```

## Required Env Variables
- DATABASE_URL — PostgreSQL connection string
- JWT_SECRET — JWT signing key
- NODE_ENV — Runtime environment

## Lint Config

## Test Config

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose
- test_paths:
  - server/src/__tests__/F-MOD-001_league.test.ts
  - server/src/__tests__/F-MOD-001_dataset.test.ts
  - web/src/__tests__/F-MOD-001_commissioner.test.tsx

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
