# Codebase Learning Document

**Project**: Draft (Fantasy Football Auction Draft Platform)
**Profiled**: 2026-08-31 (plan-mode synthesis)
**Refreshed**: 2026-09-04 (build phase, F-MOD-000 through F-MOD-017 landed, 10/18 features passing per progress log)
**Primary Language**: TypeScript
**Codebase Size**: 114 TypeScript/TSX/JS files tracked in codemap (server/src, web/src, shared-types/src)

---

## 1. System Purpose and Context

A dedicated live-auction fantasy-football draft platform for a private 12-team league. Owners bid salary-cap dollars against each other in real time to fill their rosters. The system is the authoritative record of every bid (accepted and rejected), every nomination, every dollar spent, and every roster assignment. It does not manage the fantasy season — it conducts the draft and then hands off validated rosters to ESPN.

The operator profile: 12 sophisticated fantasy owners who care deeply about auction mechanics and strategy. Reliability and determinism of bid outcomes are the primary value proposition; a wrong bid outcome or a corrupted roster mid-draft would be catastrophic.

---

## 2. Technology Stack

| Category | Technology | Version (if known) | Notes |
|----------|------------|-------------------|-------|
| Language | TypeScript | 5.5.x | All packages, strict mode |
| Server runtime | Node.js | 20+ LTS | tsx watch for dev |
| HTTP framework | Fastify | 5.12.x | `@fastify/jwt`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/cors` |
| Realtime | native `ws` | 8.18.x | Per-draft WS at `/ws/drafts/:draftId`, sequence-numbered envelope |
| Database | PostgreSQL | via `postgres` (postgres.js) 3.4.x | Authoritative state; raw `sql` tagged-template queries alongside Drizzle |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45.x / 0.31.x | `server/db/schema/index.ts` is the single schema file; `npm run db:migrate` |
| Validation | Zod | 3.23.x | Shared schemas in `shared-types/src/schemas/` |
| Frontend | React + Vite | 18.3.x / 8.2.x (vite) | `react-router-dom` 7.x for routing |
| Monorepo | npm workspaces | — | `server/`, `web/`, `shared-types/` |
| Auth | Custom HMAC JWT (`@fastify/jwt`) + `@node-rs/bcrypt` | — | `auth_epoch` revocation, re-checked every command |
| Test runner | Vitest | 5.x | Root + per-package configs; 24+ `__tests__` files in `server/src/__tests__` alone |
| Deployment | Railway | — | `railway.toml`, two services (Node app + managed Postgres) |
| PDF/Excel ingestion | `pdfjs-dist`, `xlsx` | — | ESPN dataset import adapters |

---

## 3. Architecture Overview

**Style:** Monolith (single Node.js process), state-stored (not event-sourced), multi-tenant by `draft_id`.

**Core invariant: state is stored in Postgres rows, updated only after a successful commit.** In-memory state per `draft_id` (the `DraftRuntime`, created via `getOrCreateRuntime` in `server/src/auction/engine.ts`) is a hot cache that mirrors Postgres — it is populated from the DB and updated only after commit. The `DraftEvent` log (`draft_events` table) is an audit trail and WS reconnect-replay source, not the state reconstruction mechanism.

**Isolation model:** All draft state (in-memory runtime map, timers, the per-draft `AsyncQueue`, WS broadcast groups) is keyed by `draft_id`. Every mutating route/WS handler independently re-verifies `draft.league_id === token.league_id` — routing alone is not the isolation mechanism.

**Actual module layout** (see §4 for detail):
1. `shared-types` — WS protocol/schemas, the only cross-package interface
2. `server/src/auth` — token issuance (`routes.ts`)
3. `server/src/league` — league/team/roster/auction config CRUD + `auth-hook.ts` (`requireCommissioner` / `requireLeagueMember`)
4. `server/src/ws` — `handler.ts` (generic) + `auction-handler.ts` (the live auction WS endpoint, AUTH handshake, per-command dispatch)
5. `server/src/auction` — the auction engine: `engine.ts` (bid/nominate/award pipeline, per-draft queue wiring, timers), `queue.ts` (the `AsyncQueue` serialization primitive), `auto-agent.ts` (control-mode FSM + reactive bidding cadence), `auto-agent-routes.ts`, `routes.ts` (start/pause/resume)
6. `server/src/draft` — surrounding draft features: `strategy.ts` (Watch List + Nomination Queue), `do-not-draft.ts`, `corrections.ts` (price correction / rollback), `reports.ts`, `war-room.ts`, `whammy.ts`
7. `server/src/player` — DraftDataset import: CSV/Excel/ESPN-PDF adapters, AAV resolution
8. `server/src/session` — reconnect/session snapshot (`buildDraftStateSnapshot`), whose-turn-to-nominate derivation
9. `server/src/team-media` — icon/nomination-audio upload
10. `server/src/dev` — `/dev/reseed` (non-production only)
11. `web/src/screens/*` — `lobby`, `auth`, `draft-room`, `war-room`, `commissioner` (League Setup, Dataset Import, Draft Control, Corrections, Ambiguity Resolution, Dev Tools), `draft-complete`

**Key design decisions confirmed in code:**
- State-stored over event-sourced, as designed.
- Per-draft serialized command queue (`server/src/auction/queue.ts` `AsyncQueue`) — every bid/nominate/award command for a draft enqueues here; the queue drains one item at a time.
- `server_receipt_time = new Date()` is the first line of the WS message handler (`server/src/ws/auction-handler.ts`), before any `await` — confirmed in code, matches the design doc invariant.
- Price-only in-place correction; winner/player change goes through rollback (`server/src/draft/corrections.ts`).
- Commissioner "on-behalf-of" override (`on_behalf_of_team_id` in WS commands, resolved in `auction-handler.ts`'s `resolveOnBehalfOfTeamId`) lets a commissioner nominate/bid as a disconnected/unresponsive team — a COMMISSIONER-only escape hatch, rejected outright for any other role.

**Resolved (F-MOD-002-rework-01, feedback session UF-01-02):** Auto-nomination now works — `dispatchNominationTurn` in `engine.ts` branches on `DraftTeamState.control_mode`: `AUTO_AGENT` auto-nominates immediately (no timer), `MANUAL` gets a `nomination_timer_ms`-based deadline that auto-nominates on expiry. Both paths use `selectAutoNominationPlayer` (Nomination Queue first, then highest-AAV at an open roster-need position excluding Do Not Draft) via `processAutoNomination`. `triggerCurrentNominationTurn`, wired in `routes.ts` right after `DRAFT_STARTED`, closes the very-first-turn gap. Verified live: a 12-team draft with every team on `AUTO_AGENT` now drafts itself end-to-end with zero human input.

**Known gap (feedback session UF-01-03, in progress):** `web/src/screens/draft-room/index.tsx` has no link to War Room and no in-room "Pause Draft" action (confirmed by grep — no `war-room`/`Pause` references in the file); the commissioner-facing pause control only lives in `web/src/screens/commissioner/DraftControl.tsx`. The `+$1` relative-bid button (`draft-room/index.tsx` ~line 278) computes `auction.current_bid_minor + 100` from client-side React state rather than a server-computed increment, which can race a just-applied `BID_ACCEPTED` and produce a `BID_TOO_LOW` rejection; separately, `engine.ts`'s `BID_REJECTED` reason strings (e.g. line ~396) interpolate raw `*_minor` integers unformatted (e.g. "Bid 2600 must exceed current 2600" instead of dollars).

---

## 4. Codebase Structure

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `server/src/auth/` | Site/league/team password auth, JWT issuance | `routes.ts` |
| `server/src/league/` | League/Team/Roster/AuctionConfiguration CRUD, auth hooks | `routes.ts`, `auth-hook.ts` |
| `server/src/ws/` | WS connection lifecycle, AUTH handshake, per-draft command dispatch | `handler.ts`, `auction-handler.ts` |
| `server/src/auction/` | Auction engine: bid/nominate/award pipeline, per-draft queue, Auto-Agent | `engine.ts` (1290 lines — the core FSM), `queue.ts`, `auto-agent.ts`, `auto-agent-routes.ts`, `routes.ts` |
| `server/src/draft/` | Watch List, Nomination Queue, Do Not Draft, corrections/rollback, reports, War Room, Whammy | `strategy.ts`, `do-not-draft.ts`, `corrections.ts`, `reports.ts`, `war-room.ts`, `whammy.ts`, `draft-control.ts` |
| `server/src/player/` | DraftDataset lifecycle, CSV/Excel/ESPN-PDF ingestion, AAV resolution | `routes.ts`, `csv-worker.ts`, `excel-worker.ts`, `espn-pdf-worker.ts`, `aav-resolution.ts`, `adapters/` |
| `server/src/session/` | Reconnect/session snapshot, nomination-turn derivation for clients | `routes.ts` (`buildDraftStateSnapshot`) |
| `server/src/team-media/` | Team icon + nomination-audio upload | `routes.ts`, `storage.ts` |
| `server/src/dev/` | Dev-only `/dev/reseed` (non-production) | `routes.ts` |
| `server/db/schema/` | Single Drizzle schema file, all entities | `index.ts` |
| `server/db/` | Seed CLI + reusable seed data + wipe | `seed.ts`, `seed-data.ts`, `wipe.ts`, `migrate.ts` |
| `web/src/screens/lobby/` | Pre-draft owner landing screen | `index.tsx` |
| `web/src/screens/draft-room/` | Primary live bidding UI | `index.tsx` |
| `web/src/screens/war-room/` | Second-screen analytics view | `index.tsx` |
| `web/src/screens/commissioner/` | Commissioner Console: League Setup, Dataset Import, Draft Control, Corrections, Ambiguity Resolution, Dev Tools | `LeagueSetup.tsx`, `DatasetImport.tsx`, `DraftControl.tsx`, `Corrections.tsx`, `AmbiguityResolution.tsx`, `DevTools.tsx` |
| `web/src/screens/draft-complete/` | Post-draft summary screen | `index.tsx` |
| `shared-types/src/protocol.ts` | WS envelope + AUTH + command/event shapes | `protocol.ts` |
| `shared-types/src/schemas/` | Zod schemas shared client/server | `auth.ts`, `league.ts`, others |

## Entry Points

| File | Role |
|------|------|
| `server/src/main.ts` | Server boot: env check → crash recovery (RUNNING→PAUSED) → Fastify start |
| `web/src/main.tsx` (or equivalent) | React app bootstrap |

## Notable API Routes (non-exhaustive — see per-module `routes.ts`)

| Route | Method | Handler |
|-------|--------|---------|
| `/health` | GET | liveness |
| `/auth/site`, `/auth/league/:id` | POST | `server/src/auth/routes.ts` |
| `/drafts/:draftId/start`, `/pause`, `/resume` | POST | `server/src/auction/routes.ts` |
| `/drafts/:draftId/teams/:teamId/auto-agent` | PUT | `server/src/auction/auto-agent-routes.ts` |
| `/drafts/:draftId/teams/:teamId/control-mode` | PATCH | `server/src/auction/auto-agent-routes.ts` |
| `/ws/drafts/:draftId` | WS | `server/src/ws/auction-handler.ts` — AUTH, BID_COMMAND, NOMINATE_COMMAND, PASS_NOMINATION, NOMINATOR_MATCH_COMMAND |
| `/dev/reseed` | POST | `server/src/dev/routes.ts` (non-production) |
| Nomination Queue / Watch List CRUD | GET/POST/DELETE | `server/src/draft/strategy.ts` |

---

## 5. Data Architecture

**Primary store:** PostgreSQL, accessed via `postgres.js` raw `sql` tagged templates for the auction-critical paths (transactional multi-statement work) and Drizzle for schema definition/migration. Every accepted mutation persists `{row change + DraftEvent}` in a single `sql.begin(...)` transaction; the event `sequence` number is allocated inside that same transaction.

**In-memory:** `getOrCreateRuntime(draftId)` in `server/src/auction/engine.ts` returns a per-draft runtime object (queue, team sessions, grace timers) held in a module-level `Map<draft_id, DraftRuntime>` — confirmed keyed by `draft_id`, not a singleton.

**Append-only history:** Corrections and rollbacks append new rows; superseded rows are marked inactive, never deleted (`server/src/draft/corrections.ts`).

**Money:** All financial fields are `*_minor` integer columns (e.g. `remaining_budget_minor`, `current_bid_minor`). `computeMaxLegalBid` in `engine.ts` implements `remaining_budget_minor - ($1 * other_required_remaining_roster_spots)`.

**Migrations:** Drizzle Kit (`drizzle-kit`), driven by `npm run db:migrate` (`server/db/migrate.ts`) against the single schema file `server/db/schema/index.ts`.

---

## 6. API Surface

See §4's route table. WS message types confirmed in code (`server/src/ws/auction-handler.ts`, `shared-types/src/protocol.ts`): `AUTHENTICATE`, `BID_COMMAND`, `NOMINATE_COMMAND`, `PASS_NOMINATION`, `NOMINATOR_MATCH_COMMAND`, and broadcast events `NOMINATION_STARTED`, `NOMINATION_TURN_CHANGED`, `BID_ACCEPTED`/`BID_REJECTED`, `PLAYER_AWARDED`, `DRAFT_STATUS_CHANGED`, `TEAM_AUTO_AGENT_ENABLED`/`DISABLED`, `TEAM_NOMINATION_AUDIO`.

---

## 7. Key Abstractions

| Concept | Implementation | Files |
|---------|---------------|-------|
| Per-draft command queue | `AsyncQueue` — one in-flight command per `draft_id` | `server/src/auction/queue.ts`, wired via `getOrCreateRuntime` in `engine.ts` |
| PlayerAuction FSM | States: `SECOND_BID_OPEN → REBID_OPEN → RESOLVING → AWARDED` (+ `PAUSED`) | `server/src/auction/engine.ts` (`processBidCommand`, `processNominateCommand`, `startAwardTimer`) |
| Draft FSM | States: `CREATED → RUNNING ↔ PAUSED → COMPLETE` | `server/src/auction/routes.ts` |
| Auth epoch revocation | `auth_epoch` re-read from `leagues`/`teams` table on every command (never from token payload) | `server/src/league/auth-hook.ts`, `server/src/auction/routes.ts`, `auto-agent-routes.ts` |
| Starter-first roster assignment | Lowest priority-number unfilled starter slot, then bench | `server/src/auction/engine.ts` (award path) |
| Nominator Match | One-per-auction right to match high bid at same price, consumed permanently | `server/src/auction/engine.ts` (`processNominatorMatchCommand`) |
| Nomination turn advance | Shared by explicit `PASS_NOMINATION` and post-award; auto-nominates on missed AUTO_AGENT/MANUAL turn via the Nomination Queue (fixed UF-01-02/F-MOD-002-rework-01) | `server/src/auction/engine.ts` `advanceNominationTurn` |
| Auto-Agent control mode | `MANUAL` / `AUTO_AGENT`, separate from WS connection state; grace-timer takeover on full disconnect; `setControlMode` upserts `DraftTeamState` so a pre-start mode change isn't silently dropped (F-MOD-004-rework-01) | `server/src/auction/auto-agent.ts` (`setControlMode`, `handleGraceExpiry`) |
| Auto-Agent per-player willingness ceiling | Fires on nomination and on every leadership change (recursive: each accepted Auto-Agent bid re-triggers the leader-change check for the other AUTO_AGENT teams). 5-step ceiling per player (F-MOD-004-rework-02): base = customized `owner_target_values` row else Primary AAV via `resolvePlayerPrimaryAav`; apply stable `random_variance_pct`; cap at `base * (1 + max_over_base_pct)`; full value if it fills an unfilled starter slot and `prioritize_starters`, else discounted by `bench_value_pct`; clamp to `max_legal_bid`. Excludes `do_not_draft_items` and any team with `required_remaining_spots <= 0` (F-MOD-004-rework-03) | `server/src/auction/auto-agent.ts` (`computeAutoAgentWillingnessCeiling`, `triggerAutoAgentBidsOnNomination`, `triggerAutoAgentBidsOnLeaderChange`) |
| Roster-full hard gate | Bid validation rejects with `ROSTER_FULL` when the bidding team's `required_remaining_spots <= 0`, independent of `max_legal_bid`; `awardAuction` throws (caught per-auction, never charges budget) if `assignRosterSlot` finds no eligible slot (F-MOD-002-rework-04) | `server/src/auction/engine.ts` (`processBidCommand`, `awardAuction`, `assignRosterSlot`) |
| Commissioner on-behalf-of override | COMMISSIONER-only; nominate/bid as another team | `server/src/ws/auction-handler.ts` (`resolveOnBehalfOfTeamId`) |
| Watch List / Nomination Queue / Do Not Draft | Private per-team lists; Nomination Queue may auto-nominate, Watch List never does | `server/src/draft/strategy.ts` (`getTopNominationQueueEntry`), `server/src/draft/do-not-draft.ts` |
| Append-only history | Superseded rows marked inactive, never deleted | `server/src/draft/corrections.ts` |
| Crash recovery | All `RUNNING` drafts forced to `PAUSED` at boot, before accepting connections | `server/src/main.ts` |

---

## 8. Dependency Analysis

**High-impact modules (change carefully):**
- `server/src/auction/engine.ts` — the largest file (1290 lines); every bid/nominate/award/rollback path runs through it. Bugs here corrupt draft state.
- `server/src/auction/queue.ts` — the serialization boundary; breaking this allows concurrent mutations to race.
- `server/src/ws/auction-handler.ts` — the single entry point for all live-draft mutations; owns `server_receipt_time` stamping and the commissioner on-behalf-of override.
- `shared-types/src/protocol.ts` — both client and server depend on it; a breaking change requires coordinated update everywhere.
- `server/src/league/auth-hook.ts` — called by nearly every authenticated route; correctness bugs here are league-wide.

**Well-isolated modules (safer to modify):**
- `server/src/player/` — ingestion pipeline is pre-draft; errors here don't affect a live auction.
- `server/src/team-media/` — icon/audio upload, cosmetic only.
- `server/src/dev/` — dev-only, not present in production.
- `web/src/screens/war-room/` — read-only second screen; no mutations.

---

## 9. Testing Landscape

- Framework: Vitest, root `vitest.config.ts` + per-package configs.
- 24+ test files under `server/src/__tests__/` alone (e.g. `F-MOD-004_auto_agent.test.ts`, `F-MOD-003_session.test.ts`, `F-MOD-014_do_not_draft.test.ts`), named after the feature ID that introduced them.
- No mocks by design (AAH rule) — tests run against a real Postgres instance (`vitest.globalSetup.ts` provisions it).
- `test-results/junit.xml` output per feature's `test_config` in `feature-list.json`.

---

## 10. Build and Deployment

- `npm run dev` (per-package: `tsx watch` for server, `vite` for web).
- `npm test` → `vitest run` at the repo root; per-feature commands also defined in `feature-list.json`.
- `npm run typecheck` → `tsc --noEmit` across workspaces.
- `npm run build` → per-workspace build (`tsc` for server, `tsc && vite build` for web).
- CI: `.github/workflows/ci.yml`.
- Deployment: Railway (`railway.toml`) — Node.js app service + managed Postgres.

---

## 11. Technical Debt and Risks

| Area | Observation | Impact | Confidence |
|------|-------------|--------|------------|
| `engine.ts` size | ~1290+ lines, many concerns (bid, nominate, award, match, timers, roster-full gate) in one file | Medium — readability/maintainability, not correctness | Medium |
| Draft Room nomination UX | Nomination is search-box-only (`nominateSearch`/`availablePlayers` in `web/src/screens/draft-room/index.tsx`) — no persistent filterable/sortable player list; being addressed by UF-17-07 | Medium — usability gap, not correctness | High (confirmed by code read) |
| Codebase intel staleness | This document and the diagram files were last fully synthesized at plan-mode (pre-implementation); resolved auto-nomination gap and refreshed the Auto-Agent/roster-full rows as of 2026-09-05 (wave 17 fixes) | Medium — future refreshes should prioritize a fuller re-read once the module set stabilizes | High |

---

## 12. Recommendations for Modification

**Where to start:** Read `knowledge/data-model.md` §21 (critical invariants checklist) and `knowledge/state-machine-flows.md` §2-4 before touching any draft/bid/nomination code.

**What to be careful about:**
- The per-draft `AsyncQueue` (`server/src/auction/queue.ts`) is the serialization guarantee — never bypass it, even for a proactive auto-nomination trigger from a timer callback.
- Rows in `draft_events`, `budget_ledger_entries`, `roster_entries` etc. are append-only — never hard-delete or mutate in place except the one documented price-only correction path.
- `auth_epoch` must be re-read from the DB on every command, not cached from token payload.
- All money arithmetic is integer — never introduce floating-point.
- Any new proactive-nomination timer must be keyed by `draft_id` like everything else in `DraftRuntime` — never a module-level singleton.

**What to test after changes to the nomination/bid pipeline:** Run the relevant `F-MOD-002`/`F-MOD-004` test files plus a full regression pass; a change that makes a new unit test green but breaks "kill DB mid-bid" or "restart mid-auction" scenarios is not done.

**Potential pitfalls:**
- Forgetting to stamp `server_receipt_time` before the first `await` in the WS handler.
- Updating in-memory state before the DB commit.
- Using a module-level singleton for any draft-scoped state (timers, queues, in-memory maps) — must be keyed by `draft_id`.
- A new nomination-turn timer racing with an owner's in-flight manual `NOMINATE_COMMAND` for the same turn — must resolve through the same `AsyncQueue`, not a separate code path.
