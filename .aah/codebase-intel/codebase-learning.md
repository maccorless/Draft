# Codebase Learning Document

**Project**: Draft (Fantasy Football Auction Draft Platform)
**Profiled**: 2026-08-31
**Primary Language**: TypeScript (planned)
**Codebase Size**: 0 source files (pre-implementation — this document synthesized from design documents)

---

## 1. System Purpose and Context

A dedicated live-auction fantasy-football draft platform for a private 12-team league. Owners bid salary-cap dollars against each other in real time to fill their rosters. The system is the authoritative record of every bid (accepted and rejected), every nomination, every dollar spent, and every roster assignment. It does not manage the fantasy season — it conducts the draft and then hands off validated rosters to ESPN.

The operator profile: 12 sophisticated fantasy owners who care deeply about auction mechanics and strategy. Reliability and determinism of bid outcomes are the primary value proposition; a wrong bid outcome or a corrupted roster mid-draft would be catastrophic.

---

## 2. Technology Stack

| Category | Technology | Version (if known) | Notes |
|----------|------------|-------------------|-------|
| Language | TypeScript | 5.x | All packages |
| Server runtime | Node.js | 20+ LTS | |
| HTTP framework | Fastify | 4.x | Server |
| Realtime | native ws | 8.x | Per-draft WS, sequence-numbered envelope |
| Database | PostgreSQL | 15+ | Authoritative state |
| Validation | Zod | 3.x | Shared schemas in shared-types |
| Frontend | React + Vite | 18.x / 5.x | Web clients |
| Monorepo | npm workspaces | — | server/, web/, shared-types/ |
| DB migrations | TBD (Drizzle / Prisma / node-pg-migrate) | — | Decided in Phase 0 |
| Auth | Custom HMAC JWT | — | auth_epoch revocation |

---

## 3. Architecture Overview

**Style:** Monolith (single Node.js process), state-stored (not event-sourced), multi-tenant by `draft_id`.

**Core invariant: state is stored in Postgres rows, updated only after a successful commit.** In-memory state per `draft_id` is a hot cache that mirrors Postgres — it is populated from the DB at startup and updated only after commit. This is not event-sourcing; the `DraftEvent` log is an audit trail and WS reconnect replay source, not the state reconstruction mechanism.

**Isolation model:** All draft state (in-memory maps, timers, command queues, WS broadcast groups) is keyed by `draft_id`. The routing layer and the auth layer each independently enforce per-league/draft isolation — routing alone is not sufficient.

**Architectural layers:**
1. `shared-types` — WS protocol contract and Zod schemas, the only cross-package interface
2. `server/auth` — token issuance and per-command auth_epoch validation
3. `server/ws` — connection lifecycle, AUTH handshake, per-draft routing
4. `server/draft/command-queue` — per-draft serialized queue, the isolation and ordering guarantee
5. `server/draft/{nomination, bid, resolution, auto-agent, rollback}` — the auction business logic
6. `server/league`, `server/player` — setup and data import, mostly CRUD
7. `web/*` — thin UI consuming the WS event stream

**Key design decisions recorded in design docs:**
- State-stored over event-sourced: bounded rollback (last N picks, not arbitrary point) means event sourcing's reconstruction power is not needed. Simpler recovery story.
- Per-draft serialized command queue (not Postgres row locks): prevents two interleaved commands from validating against the same stale state. The lock is logical, not physical.
- `server_receipt_time` is stamped in the WS message handler *before any await* — ensures event-loop stall can't flip an in-time bid to expired.
- Price-only in-place correction; winner/player change always requires rollback — removes the need to validate a second team's feasibility inline.
- Anti-sniping classification uses server receipt time; AUTO_AGENT bids are exempt from penalty accrual.

---

## 4. Codebase Structure

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `server/src/auth/` | Token issuance + per-command epoch validation | token.ts, middleware.ts [PLANNED] |
| `server/src/ws/` | WS handler, AUTH handshake, 5s auth timeout, broadcast | handler.ts [PLANNED] |
| `server/src/draft/` | All auction business logic | command-queue.ts [PLANNED] |
| `server/src/draft/bid/` | Full bid validation pipeline | validate.ts, pipeline.ts [PLANNED] |
| `server/src/draft/resolution/` | Acquisition + ledger + starter-first roster | resolution.ts [PLANNED] |
| `server/src/draft/auto-agent/` | Willingness calc, cadence trigger | auto-agent.ts [PLANNED] |
| `server/src/draft/rollback/` | Reverse-order rollback, price-correction replay | rollback.ts [PLANNED] |
| `server/src/league/` | League/Team/Roster/Scoring config | routes.ts, service.ts [PLANNED] |
| `server/src/player/` | DraftDataset lifecycle, CSV ingestion | dataset.ts, adapters/ [PLANNED] |
| `web/src/screens/draft-room/` | Primary bidding UI | DraftRoom.tsx [PLANNED] |
| `web/src/screens/war-room/` | Second screen / analytics | WarRoom.tsx [PLANNED] |
| `web/src/ws/` | WS client, reconnect, snapshot replay | client.ts [PLANNED] |
| `shared-types/src/protocol.ts` | WS envelope + AUTH + command/ack shapes | protocol.ts [PLANNED] |

---

## 5. Data Architecture

**Primary store:** PostgreSQL. Every accepted mutation persists `{row change + DraftEvent}` in a single transaction. The event sequence number is allocated inside that transaction — events and rows can never diverge.

**In-memory:** A `Map<draft_id, DraftState>` per Node.js process. Updated only on successful commit. On restart, all RUNNING drafts are forced to PAUSED and state is reloaded from Postgres.

**Append-only history:** Corrections and rollbacks append new rows and mark old ones `active: false`. No deletes, no timeline branching.

**Money:** All financial fields are integer minor units. `max_legal_bid = remaining_budget - (1 * other_required_roster_spots)`. All calculations are server-side.

**Migration strategy:** One chosen tool (Phase 0 decision) manages all schema evolution. Rollback does not require schema rollback — only data row operations.

---

## 6. API Surface

| Endpoint/Interface | Method | Purpose |
|-------------------|--------|---------|
| `POST /auth/login` | REST | League/team password → HMAC token [PLANNED] |
| `POST /leagues` | REST | Commissioner creates league + config [PLANNED] |
| `POST /leagues/:id/draft-dataset` | REST | Import + freeze player dataset [PLANNED] |
| `POST /leagues/:id/draft` | REST | Create Draft [PLANNED] |
| `POST /drafts/:id/pause` | REST | Commissioner pause/resume [PLANNED] |
| `POST /drafts/:id/corrections` | REST | Price correction or rollback trigger [PLANNED] |
| `GET /health` | REST | Health check [PLANNED] |
| `WS /ws?draft_id=X` | WebSocket | All real-time events — AUTH as first message [PLANNED] |

WS message types (from `shared-types/protocol.ts`): AUTH, BID_COMMAND, NOMINATE_COMMAND, PAUSE_COMMAND, BID_ACCEPTED, BID_REJECTED, PLAYER_AWARDED, NOMINATION_STARTED, DRAFT_EVENT, RECONNECT_SNAPSHOT, etc.

---

## 7. Key Abstractions

| Concept | Implementation | Files |
|---------|---------------|-------|
| Per-draft command queue | In-memory async queue, one in-flight command per draft_id | server/draft/command-queue.ts [PLANNED] |
| PlayerAuction FSM | States: SECOND_BID_OPEN → REBID_OPEN → RESOLVING → AWARDED | server/draft/auction/ [PLANNED] |
| Draft FSM | States: UPCOMING → RUNNING ↔ PAUSED → COMPLETE | server/draft/ [PLANNED] |
| Auth epoch revocation | auth_epoch field on League/Team; re-checked on every command | server/auth/ [PLANNED] |
| Starter-first roster assignment | Lowest priority unfilled starter slot, then bench; never reshuffles | server/draft/resolution/ [PLANNED] |
| Nominator Match | One-per-auction right to match high bid at same price | server/draft/bid/ [PLANNED] |
| Anti-sniping | Server-side deadline extension; AUTO_AGENT exempt from penalty | server/draft/bid/ [PLANNED] |
| Append-only history | `active: false` on superseded rows; no deletes | data-model §17.2 |
| Bounded rollback | Reverse-order undo of last N picks as one transaction | server/draft/rollback/ [PLANNED] |

---

## 8. Dependency Analysis

**High-impact modules (change carefully):**
- `server/draft/resolution/` — every pick flows through here; touches Acquisition, Ledger, RosterEntry in one transaction. Bugs here corrupt draft state.
- `server/draft/command-queue.ts` — the serialization boundary. Breaking this allows concurrent mutations to race.
- `shared-types/protocol.ts` — both client and server depend on this. A breaking change here requires coordinated update everywhere.
- `server/auth/` — called on every command. Performance or correctness bugs here affect all users simultaneously.

**Well-isolated modules (safer to modify):**
- `server/player/` — ingestion pipeline is pre-draft; errors here don't affect a live auction.
- `server/reports/` — post-draft only; failures are non-blocking to the draft itself.
- `server/whammy/` — flows through the existing ledger API; no separate state machine.
- `web/screens/war-room/` — read-only second screen; no mutations.

---

## 9. Testing Landscape

No tests exist yet (pre-implementation). Planned test targets per design docs:

- Every bid/starter-first/nomination-audio scenario in PRD §44 as automated tests
- Ledger reconciliation after a sequence of acquisitions
- Max-legal-bid formula enforcement
- No accepted event broadcast before DB commit (DB kill test)
- Server restart mid-auction comes back PAUSED
- Multi-draft isolation: League A token rejected on League B draft
- Auto-Agent first competing bid (not just "reacts to being outbid")

No mocks by design (AAH rule + BUILD_PLAN philosophy) — tests run against real Postgres.

---

## 10. Build and Deployment

No build system exists yet. Phase 0 will establish:

- `npm run dev` — starts server + web concurrently
- `npm test` — test runner (framework TBD)
- `npm run typecheck` — tsc --noEmit across all packages
- `npm run lint` — ESLint

CI: typecheck + lint + test on push (GitHub Actions).

Deployment target not specified in design docs — containerized Node.js + managed Postgres is the natural fit given multi-draft multi-tenancy.

---

## 11. Technical Debt and Risks

| Area | Observation | Impact | Confidence |
|------|-------------|--------|------------|
| Migration tool undecided | Phase 0 requires choosing Drizzle vs. Prisma vs. node-pg-migrate | Low — affects DX, not correctness | High |
| ORM decision pending | No ORM vs. Drizzle vs. Prisma affects query authoring for the bid pipeline | Medium — Drizzle/raw SQL safer for the complex atomic resolution transaction | High |
| Email delivery stubbed | Phase 9 uses a SendGrid stub — wiring real delivery is future work | Low — reports available in-app regardless | High |
| ESPN PDF import | PDF parsing is inherently fragile against ESPN format changes | Medium — Phase 2b, fallback is CSV | Medium |
| In-process isolation | Multi-draft concurrency is in one Node.js process; a crashed async operation in one draft must not affect others — requires careful error boundary design | High for production | High |
| Anti-sniping audit | `server_receipt_time` stamped before any await is correct-by-design but must be enforced in code review — easy to accidentally move inside the async path | High — wrong stamp = deadline bypass | High |

---

## 12. Recommendations for Modification

**Where to start:** Read `data-model.md` §21 (critical invariants checklist) before touching any draft or bid code. Every invariant there is a potential production incident.

**What to be careful about:**
- The per-draft command queue is the serialization guarantee — never bypass it, even for "read-only" state checks that might have side effects.
- `active: false` on superseded rows is how rollback works — never hard-delete Acquisition, RosterEntry, or BudgetLedgerEntry rows.
- `auth_epoch` must be re-read from the DB on every command, not cached from token payload — the whole revocation mechanism depends on this.
- All money arithmetic is integer — never introduce floating-point.

**What to test after changes to bid pipeline:** Run the full §44 acceptance scenario suite. A change that makes the unit test green but breaks "kill DB mid-bid" or "restart mid-auction" scenarios is not done.

**Potential pitfalls:**
- Forgetting to stamp `server_receipt_time` before the first `await` in the WS handler.
- Updating in-memory state before the DB commit (the invariant is "in-memory updates only after commit").
- Using a module-level singleton for any draft-scoped state (timers, queues, in-memory maps) — must be keyed by `draft_id`.
- Auto-Agent bidding trigger: must fire on auction open AND on every leadership change, not just "react to being outbid" — an agent that never led would never bid otherwise.
