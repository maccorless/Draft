## Id
F-MOD-000

## Title
Walking Skeleton: Scaffold, Auth, Protocol, and Boot

## Module Ref
MOD-000

## Description
MOD-000 creates the entire foundational layer of the Draft platform — the monorepo scaffold, the
shared WS protocol contract, the complete Drizzle database schema, the auth HTTP endpoints,
cross-cutting server infrastructure, crash recovery, and the two seed UI screens. Every subsequent
module builds on this foundation without needing to revisit any of it.

**Stack:** Node.js 20+ LTS + TypeScript 5.x + Fastify 4.x (backend); React 18 + Vite 5 + TypeScript
(frontend); native ws 8.x; Drizzle ORM + postgres.js; Zod 3.x; Vitest. Deployment target: two
Railway services (Node.js + Railway-managed Postgres). See
`.aah/architecture/architecture-overview.md §2` (Architecture Style and Key Decisions) and `§7`
(Folder Structure) for the authoritative directory layout and ADR table.

**Scaffold** — creates the npm workspaces monorepo at the repo root: `server/`, `web/`, and
`shared-types/` packages each with their own `package.json` and `tsconfig.json`. TypeScript strict
mode (`strict: true`) is enabled in every `tsconfig.json` per `resolved-standards.yaml` TS-TYPE-002.
Vitest is configured at the repo root. `railway.toml` declares two services: the Node.js app and the
Railway Postgres addon. `.github/workflows/ci.yml` runs `tsc --noEmit` and Vitest on every PR and
triggers a Railway deploy only on merge to `main`.

**Protocol** — `shared-types/src/protocol.ts` defines the WS envelope type
`{ seq: number; draft_id: string; event_type: string; payload: unknown; server_time: string }` and
the `AUTH` message shape (first message on every WS connection; carries JWT + league_id). All WS
message types have Zod validators in `shared-types/src/schemas/`. An unauthenticated socket that
does not send `AUTH` within 5 seconds is closed by the server. See
`.aah/architecture/application-flow.md §2` for the full auth sequence diagram.

**Database** — `server/db/schema/` holds the complete Drizzle schema for all 18 entities: League,
Team, Membership, User, Draft, PlayerAuction, BidAttempt, DraftEvent, DraftTeamState, Acquisition,
RosterEntry, BudgetLedgerEntry, RosterConfiguration, RosterSlotDefinition, AuctionConfiguration,
AutoAgentConfig, DraftDataset, Player, and WhammyConfig. See
`.aah/architecture/data-model.md §2` (ERD) and `§3`–`§16` for per-entity shapes. Every
`*_minor` money field is an integer column; no DECIMAL or FLOAT anywhere. `npm run db:migrate`
generates and applies migrations. The postgres.js connection pool is capped at 10 connections.

**Env checker** — `server/src/config/env-check.cjs` (or `.ts` equivalent compiled to CJS) runs as
the very first import in `server/src/main.ts` before any module reads configuration. It validates
that DATABASE_URL and JWT_SECRET are present; on any missing variable it exits immediately with
error code `ERR_CDR_78_EX_CONFIG`, names every absent variable, and prints `cp .env.example .env`.
This module is also responsible for seeding `.env.example` with safe placeholder entries for all
five catalog variables (DATABASE_URL, JWT_SECRET, SENDGRID_API_KEY, FANTASYPROS_API_KEY, NODE_ENV)
so that every downstream module can read them from the single source of truth without re-adding them.

**API** — Fastify 4.x server with Pino structured JSON logger and `pino-opentelemetry-transport`.
The `@fastify/jwt` plugin signs and verifies HMAC JWTs; a `preHandler` hook re-reads `auth_epoch`
from Postgres on every authenticated command (never from the cached token payload) and closes the
WS with code 4401 `AUTH_EPOCH_INVALID` on mismatch. Passwords are hashed and verified with
`@node-rs/bcrypt` at work factor 12. `@fastify/rate-limit` applies an in-memory 5-failures/IP/min
cap on both auth routes. Fastify's error handler returns `{ code, message }` for HTTP errors; WS
command rejections return `{ type: "ERROR", code, reason }`. Endpoints:
- `GET /health` — liveness probe; no auth required.
- `POST /auth/site` — accepts `site_password`; returns list of league name+id pairs.
- `POST /auth/league/:id` — accepts role (COMMISSIONER or OWNER), optional team_id, and password;
  returns a JWT carrying `{ league_id, team_id, role, auth_epoch }` valid for 172 800 s (48 h).
See `.aah/architecture/application-flow.md §2` for the full three-tier auth sequence.

**Crash recovery** — immediately after the env check and before Fastify begins accepting connections,
`server/src/main.ts` queries all `Draft` rows with `status = RUNNING`, updates each to
`status = PAUSED`, and appends a `DRAFT_PAUSED` `DraftEvent` row in the same Postgres transaction.
This satisfies architectural constraint 8 from `discuss/discuss-prd.md` and `resolved-standards.yaml`
EXTRACTED-005: a draft that was RUNNING at crash time must never be resumed against a stale expired
deadline.

**UI** — two screens implemented in `web/src/screens/`:
- **Lobby** (`lobby/`) — shown to authenticated owners before the draft starts: league name, scheduled
  start time (or "Not yet scheduled" / "Waiting for commissioner to start"), and own team name.
  Described in `knowledge/screen-information-architecture.md §0` and `§0.1`.
- **Commissioner Console scaffold** (`commissioner/`) — top-level navigation shell with all named
  sections present and routing configured; section content pages are empty placeholders for later
  modules to fill.

**Seed / fixture data** — `server/src/db/seed.ts` populates a local development database with one
test league, 12 teams (each with a hashed password), a frozen DraftDataset referencing a set of
seeded Player rows, and an AuctionConfiguration. This seed must be runnable via `npm run db:seed`
and must not require any other module to be built first.

**Behavioral expectations:**

- Given the monorepo root, when `npm install` runs, then workspaces `server`, `web`, and
  `shared-types` resolve without errors and `tsc --noEmit` passes in all three packages with no
  type errors.

- Given `shared-types` is built, when a WS message is constructed using the envelope schema in
  `shared-types/src/protocol.ts`, then the Zod validators enforce the shape
  `{ seq, draft_id, event_type, payload, server_time }`; any message missing a required field fails
  validation and is rejected before reaching a command handler.

- Given a WebSocket connects to the server but sends no AUTH message, when 5 seconds elapse, then
  the server closes that connection.

- Given DATABASE_URL is set and `npm run db:migrate` completes, then every entity table from the
  Drizzle schema (`League`, `Team`, `Membership`, `Draft`, `PlayerAuction`, `BidAttempt`,
  `DraftEvent`, `DraftTeamState`, `Acquisition`, `RosterEntry`, `BudgetLedgerEntry`,
  `RosterConfiguration`, `RosterSlotDefinition`, `AuctionConfiguration`, `AutoAgentConfig`,
  `DraftDataset`, `Player`, `WhammyConfig`) exists in Postgres and is selectable.

- Given DATABASE_URL is absent from the environment, when the server process starts, then it exits
  before binding any port, prints `ERR_CDR_78_EX_CONFIG`, names DATABASE_URL as missing, and
  instructs the operator to run `cp .env.example .env`.

- Given JWT_SECRET is absent from the environment, when the server process starts, then it exits
  with `ERR_CDR_78_EX_CONFIG` naming JWT_SECRET, regardless of whether DATABASE_URL is present
  (all missing variables are named at once).

- Given `.env.example` is committed to the repo, when it is read, then it contains named placeholder
  entries (no real values) for DATABASE_URL, JWT_SECRET, SENDGRID_API_KEY, FANTASYPROS_API_KEY, and
  NODE_ENV.

- Given the server is running, when `GET /health` is called, then it returns HTTP 200
  `{ "status": "ok", "ts": "<ISO-8601 datetime>" }` within 50 ms regardless of database state.

- Given a correct site_password, when `POST /auth/site` is called, then it returns HTTP 200
  `{ "leagues": [{ "id": "<uuid>", "name": "<string>" }] }`.

- Given an incorrect site_password, when `POST /auth/site` is called, then it returns HTTP 401
  `{ "code": "INVALID_CREDENTIALS", "message": "..." }` and does not disclose whether the site
  password exists.

- Given a valid commissioner password for a league, when `POST /auth/league/:id` is called with
  `{ "role": "COMMISSIONER", "password": "..." }`, then it returns HTTP 200 with a JWT whose
  decoded payload carries `league_id`, `role: "COMMISSIONER"`, and `auth_epoch`; `expires_in` is
  172800.

- Given a valid team password and matching team_id for a league, when `POST /auth/league/:id` is
  called with `{ "role": "OWNER", "team_id": "...", "password": "..." }`, then it returns HTTP 200
  with a JWT whose decoded payload carries `league_id`, `team_id`, `role: "OWNER"`, and
  `auth_epoch`.

- Given a JWT was issued before the league or team's `auth_epoch` was bumped, when any WS command
  carrying that token is processed, then the server re-reads `auth_epoch` from Postgres (not from
  the cached token payload) and closes the socket with code 4401 `AUTH_EPOCH_INVALID`.

- Given 5 failed auth attempts (any combination of `/auth/site` and `/auth/league/:id`) from the
  same IP within a 60-second window, when a 6th attempt arrives within that window, then the server
  returns HTTP 429 without evaluating the credential.

- Given a team or commissioner password is created or changed, when it is stored in Postgres, then
  it is stored as a bcrypt hash produced with work factor 12; the plaintext password never persists.

- Given one or more `Draft` rows have `status = RUNNING` in Postgres at server start, when the
  server process starts (after env check, before accepting HTTP/WS connections), then each such
  draft is updated to `status = PAUSED` and a `DRAFT_PAUSED` `DraftEvent` is appended in the same
  transaction; the server only begins accepting connections after this completes.

- Given `npm run db:seed` is run against a local Postgres instance, when it completes, then the
  database contains one test league, 12 teams each with a bcrypt-hashed password, a `FROZEN`
  `DraftDataset` with seeded `Player` rows, and an `AuctionConfiguration` — sufficient for all
  subsequent modules to run locally without additional data setup.

- Given an authenticated owner whose draft has not started, when the Lobby screen loads
  (`web/src/screens/lobby/`), then it displays the league name, the scheduled draft start time
  (or the string "Not yet scheduled" when unset, or "Waiting for commissioner to start" when the
  scheduled time has passed), and the owner's team name, per
  `knowledge/screen-information-architecture.md §0.1`.

- Given an authenticated commissioner, when the Commissioner Console loads
  (`web/src/screens/commissioner/`), then all top-level navigation sections render without
  JavaScript errors; section content areas for modules not yet built show an empty placeholder and
  do not throw.

- Given a push to any non-`main` branch, when the GitHub Actions CI workflow runs, then `tsc
  --noEmit` and Vitest pass as gate checks; the Railway deploy step is skipped.

- Given a merge to `main`, when the GitHub Actions CI workflow runs, then the Railway deploy step
  executes only after `tsc --noEmit` and Vitest both pass.

## Layers

- scaffold
- protocol
- db
- api
- crash_recovery
- ui

## Dependencies

## API Contracts

```yaml
produces:
  - operation_id: getHealth
    schema_file: schema/MOD-000-api-schema.yaml
    request_schema: ~
    response_schema: HealthResponse
  - operation_id: authSite
    schema_file: schema/MOD-000-api-schema.yaml
    request_schema: SiteAuthRequest
    response_schema: SiteAuthResponse
  - operation_id: authLeague
    schema_file: schema/MOD-000-api-schema.yaml
    request_schema: LeagueAuthRequest
    response_schema: LeagueAuthResponse
```

## Required Env Variables

- DATABASE_URL — Railway-injected PostgreSQL connection string; validated at boot
- JWT_SECRET — HMAC signing key for JWTs; validated at boot
- SENDGRID_API_KEY — SendGrid API key for post-draft email (consumed by MOD-006; seeded here so .env.example is complete from day one)
- FANTASYPROS_API_KEY — FantasyPros API auth key (consumed by MOD-007; seeded here so .env.example is complete from day one)
- NODE_ENV — Runtime environment flag (development / production)

## Lint Config

Before writing any application code, for each root below: create its manifest first, then run
`aah run core.scaffold.project ensure-lint-config --project-path "$PROJECT_DIR" --package-root <root> --install`
— it reads the manifest to pick the linter, writes the config, adds the linter to dev dependencies
and installs it, and never clobbers an existing config. Where a source path is given, copy that file
into the root first, then run the same command. Commit the configs with this module.

- server — default
- web — default
- shared-types — default

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

## Status
implementing
