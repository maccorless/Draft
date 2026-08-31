# Build Plan — Fantasy Football Auction Draft Platform

**Status:** Planning
**Companion documents:** `PRD.md`, `data-model.md`, `state-machine-flows.md`, `screen-information-architecture.md`

---

## Stack

- **Backend:** Node + TypeScript (Fastify)
- **Realtime:** plain `ws` WebSockets (custom protocol per `state-machine-flows.md` §10, §19)
- **Database:** Postgres
- **Frontend:** React + Vite + TypeScript
- **Validation:** Zod, shared between client and server via a `shared-types` package
- **Monorepo layout:** `server/`, `web/`, `shared-types/`

Single process owns authoritative draft state in memory; every accepted mutation commits to Postgres (BidAttempt, DraftEvent, ledger entries) before broadcasting. On restart, state rebuilds from snapshot + event replay (PRD §42).

---

## Build Mode Legend

- 🔒 **Core / sequential** — touches the shared authoritative state machine or the WebSocket protocol directly. Build in one continuous session (not fanned out to parallel agents); correctness here depends on one coherent mental model of the invariants in `data-model.md` §21.
- 🧩 **Parallelizable** — decoupled from live auction state once the core API/schema is frozen. Safe to hand to separate agents/sessions against a fixed contract.

---

## Phase 0 — Project Scaffold 🔒

**Goal:** monorepo boots, empty server accepts a WebSocket connection, empty React app renders.

- `server/`, `web/`, `shared-types/` packages; shared `tsconfig`.
- Postgres connection + migration tool (e.g. `node-pg-migrate` or Drizzle/Prisma — pick one before starting).
- Fastify server with health-check route + one WS echo endpoint.
- Vite React app that connects to the WS endpoint and shows connection status.
- Lint/format/test harness wired (this is what CLAUDE.md's "build/test commands" section gets filled in from).
- CI: typecheck + lint + test on push.

**Acceptance:** `npm run dev` starts server + web; web shows "connected"; `npm test` runs (even if trivial); typechecker runs clean.

---

## Phase 1 — League, Roster, and Scoring Configuration 🔒

**Entities:** `League`, `User`, `Team`, `Membership`, `TeamMedia`, `RosterConfiguration`, `RosterSlotDefinition`, `ScoringConfiguration`, `ScoringRule`, `AuctionConfiguration`, `AutoAgentLeagueDefaults`.

- DB schema + migrations for the above.
- Commissioner API: create league, create teams, assign owners, configure roster slots, configure scoring rules, configure auction timers/rules.
- Enforce invariants: `total_roster_size == total_starter_slots + bench_slots`; effective starting budget resolution (team override vs. league default).
- Minimal commissioner setup UI (forms, not polish).

**Acceptance:** commissioner can create a full league config for a 12-team league via API and see it round-trip through the UI; invalid roster configs are rejected server-side.

---

## Phase 2 — Player Master, Draft Dataset, AAV Ingestion 🔒 (schema) / 🧩 (adapters after Phase 2a)

**Entities:** `Player`, `PlayerPositionEligibility`, `ProviderPlayerMapping`, `DataSource`, `DraftDataset`, `DatasetImport`, `PlayerSeasonStats`, `PlayerProjection`, `PlayerStatus`, `PlayerTier`, `AAVSource`, `PlayerAAV`.

**Phase 2a (🔒 core):** schema, the `DraftDataset` freeze/version lifecycle (DRAFT → VALIDATED → FROZEN), and **one** working ingestion adapter (commissioner CSV) end to end, since this proves the ingestion contract everything else builds against.

**Phase 2b (🧩 parallelizable once 2a's adapter interface is frozen):** additional adapters — ESPN AAV PDF import (PRD §10.1, with ambiguity-resolution UI), FantasyPros, Sleeper/nflverse if desired.

**Acceptance:** a commissioner can load a CSV of players/projections/AAVs, review match/ambiguity counts (`DatasetImport`), and freeze a `DraftDataset` version. The live draft can start with a frozen dataset.

---

## Phase 3 — Draft, DraftTeamState, Nomination Order 🔒

**Entities:** `Draft`, `DraftTeamState`, `TeamDraftMediaState`.

- Draft-level state machine: `UPCOMING → RUNNING ↔ PAUSED → COMPLETE`.
- Nomination turn flow (`state-machine-flows.md` §2): select next eligible nominator, start Nomination Timer, handle no-submission fallback to Nomination Queue.
- Nomination audio flow (§12) — presentation-only, must never block the auction.

**Acceptance:** commissioner can start a draft; nomination turn rotates through teams in `draft_order`; a team with a complete roster is skipped; first-nomination audio event fires once per team.

---

## Phase 4 — PlayerAuction State Machine 🔒

**Entities:** `PlayerAuction`, `NominatorMatchRight`.

- State machine: `SECOND_BID_OPEN → REBID_OPEN → RESOLVING → AWARDED` (+ `PAUSED`, `REVERSED`).
- Nominator Match availability rules (§6): available only while bidding open, nominator not already leading, consumed at most once.
- No-competing-bid resolution: nominator wins at opening price when Second-Bid Timer expires.

**Acceptance:** a PlayerAuction can be created, opened, and resolved end to end with a single nominator and no competing bids; Match right correctly transitions AVAILABLE → CONSUMED/EXPIRED.

---

## Phase 5 — Bid Atomicity, Timers, Stale-State Protection 🔒

**Entities:** `BidAttempt`.

This is the highest-risk phase — implements the full decision flow in `state-machine-flows.md` §4.

- Bid command pipeline: authenticate → dedupe idempotency key → lock PlayerAuction → validate deadline → validate by bid type (`PLUS_ONE`, `MATCH`, `CUSTOM`, `AUTO_AGENT`, `COMMISSIONER_FOR_OWNER`) → validate roster/budget → anti-sniping classification → persist → commit → broadcast.
- Three independent timers (Nomination, Second-Bid, Rebid) as server-authoritative timestamps.
- Configurable anti-sniping (info/warn/enforce modes).
- Stale-state rejection for `+$1` and `MATCH`; exact-offer semantics for `CUSTOM` (never silently reprice).
- Full `BidAttempt` telemetry, including rejected attempts.

**Acceptance:** every scenario in `PRD.md` §44 (starter-first assignment is out of scope here, but +$1 stale state, custom bid, Match) passes as an automated test. No accepted event broadcasts before commit. p50/p95 latency targets are at least locally sane (real perf testing comes later).

---

## Phase 6 — Acquisition, Budget Ledger, Starter-First Roster Assignment 🔒

**Entities:** `Acquisition`, `RosterEntry`, `BudgetLedgerEntry`.

- Resolution transaction (§7): lock → determine winner → validate still legal → create Acquisition → debit ledger → assign roster slot → update DraftTeamState → checkpoint → broadcast.
- Starter-first algorithm (`data-model.md` §4.3): lowest `assignment_priority` among eligible unfilled starter slots, else Bench; never reshuffle prior assignments.
- Budget Ledger reconciliation: remaining budget = sum of active-timeline entries.

**Acceptance:** all three starter-first scenarios in PRD §44 pass; ledger reconciles after a sequence of acquisitions; max-legal-bid formula enforced (`remaining budget − $1 × other required remaining slots`).

---

## Phase 7 — Client Session / Reconnect Model 🔒

**Entities:** `DraftClientSession`.

- WebSocket protocol: event sequence numbers, snapshot-on-connect, missed-event replay.
- Multi-window disconnect detection (§10): team counted disconnected only when **zero** valid sessions remain; Draft View + War Room from the same owner count as one identity.
- Reconnect recovery payload per PRD §40 (current auction, price, leader, deadline, budget, roster, Match state, control mode, missed events).

**Acceptance:** killing and restarting the server mid-auction recovers all connected clients to correct state within the PRD's 5-second target; closing one of two windows for the same team does not trigger disconnect state.

---

## Phase 8 — Manual / Auto-Agent Control 🔒

**Entities:** extends `DraftTeamState`; adds `AutoAgentConfiguration` read path (data lives with Phase 9 but the control-mode machine is core).

- Control mode state machine (§9): `MANUAL_CONNECTED ↔ MANUAL_RECONNECTING → AUTO_AGENT_DISCONNECTED`; `MANUAL ↔ AUTO_AGENT_USER/COMMISSIONER`.
- Disconnect grace timer (`disconnect_auto_agent_delay_ms`), broadcast toasts on every transition.
- Auto-Agent offer calculation (§11): base value (Target or Primary AAV) → variance → `max_over_base_pct` ceiling → starter/bench distinction → clamp to max legal bid → Do Not Draft filter.
- Auto-Agent bids/nominates through the *same* Phase 4/5 pipeline — no separate code path.

**Acceptance:** all Auto-Agent acceptance scenarios in PRD §44 pass, including "reconnection does not auto-resume manual" and "War Room disconnect alone does not trigger Auto-Agent."

---

## Phase 9 — Owner Private Strategy Data 🧩

**Entities:** `OwnerPlayerTarget`, `WatchListEntry`, `NominationQueueEntry`, `DoNotDraftEntry`, `AutoAgentConfiguration` (the config values themselves, consumed by Phase 8's calculation).

- CRUD APIs, private to the owning team.
- Nomination Queue auto-nominate fallback wired into Phase 3's nomination flow.
- Watch List `Nominate` action wired into Phase 3.

**Acceptance:** an owner can maintain all four private lists; Watch List never triggers auto-nomination; Nomination Queue does.

---

## Phase 10 — Commissioner Corrections + Rollback 🔒

**Entities:** `CommissionerAction`, `DraftCheckpoint`, `DraftTimeline`.

- Correction flow (§14): reason required, preview consequences, append compensating events, never mutate historical BidAttempts.
- Rollback flow (§15): checkpoint selection, new `DraftTimeline` branched from event sequence, rebuild materialized state, old timeline stays queryable.

**Acceptance:** rollback scenario in PRD §44 passes; a rolled-back draft's original history remains queryable; ledger and roster state after rollback matches the checkpoint.

---

## Phase 11 — Whammy Framework 🧩

**Entities:** `WhammyConfiguration`, `WhammyDefinition`, `WhammyEvent`.

- Trigger evaluation, weighted selection, optional commissioner approval gate.
- Budget effects flow through the Phase 6 ledger (`WHAMMY` reason type) — reuses existing ledger API, does not reimplement it.

**Acceptance:** a configured Whammy can trigger, optionally require approval, and post a ledger entry that reconciles correctly.

---

## Phase 12 — Analytics, ESPN Reconciliation, Presentation 🧩

**Entities:** `DraftTeamEvaluation`, `ProviderTeamMapping`, `ExportJob`, `ReconciliationItem`. Plus bid analytics from `BidAttempt` telemetry (PRD §35).

- Draft completion flow (§17): final integrity validation against `data-model.md` §21 invariants, generate `DraftTeamEvaluation`, canonical CSV/JSON export.
- ESPN transfer workflow (PRD §37): team mapping, entry-order worksheet, reconciliation tracking.
- Bid analytics queries/UI.

**Acceptance:** a completed draft produces valid exports and an ESPN entry-order worksheet that a commissioner could follow manually.

---

## Frontend Screens 🧩 (once API/WS contract from Phases 3–8 is frozen)

Can be built in parallel per `screen-information-architecture.md` once the core is stable:

- Draft Room (primary auction view)
- War Room / second screen
- Commissioner Console
- Draft Board / presentation view
- Mobile Draft View

Each consumes the same WS event stream; no screen should require server-side changes to the core state machine.

---

## Sequencing Summary

```
🔒 Core, one continuous build:
  0 Scaffold → 1 Config → 2a Dataset+CSV adapter → 3 Draft/Nomination →
  4 PlayerAuction FSM → 5 Bid atomicity → 6 Acquisition/Ledger/Roster →
  7 Session/Reconnect → 8 Auto-Agent → 10 Corrections/Rollback

🧩 Fan out after core is frozen and tested:
  2b Additional ingestion adapters
  9  Owner private strategy data
  11 Whammy
  12 Analytics/ESPN
  Frontend screens (Draft Room, War Room, Commissioner Console, Board, Mobile)
```

Each 🔒 phase should end with automated tests covering its relevant `PRD.md` §44 acceptance scenarios and `data-model.md` §21 invariants before moving to the next phase.
