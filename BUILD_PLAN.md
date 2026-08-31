# Build Plan — Fantasy Football Auction Draft Platform

**Status:** Planning
**Companion documents:** `PRD.md`, `data-model.md`, `state-machine-flows.md`, `screen-information-architecture.md`

---

## Stack

- **Backend:** Node + TypeScript (Fastify)
- **Realtime:** plain `ws` WebSockets, sequence-numbered envelope defined in `shared-types` from Phase 0 (see below)
- **Database:** Postgres
- **Frontend:** React + Vite + TypeScript
- **Validation:** Zod, shared between client and server via a `shared-types` package
- **Monorepo layout:** `server/`, `web/`, `shared-types/`

### Recovery model

State-stored, not event-sourced. Postgres rows (`DraftTeamState`, `PlayerAuction`, `Acquisition`, `RosterEntry`, ledger) are live authority; every accepted mutation commits before broadcast. The `DraftEvent` log exists for audit and for WebSocket reconnect replay ("what did I miss"), not for reconstructing arbitrary past state — we don't need that, because rollback is bounded (see below), not arbitrary-point.

### Rollback model

A draft has exactly **one** timeline, growing forward, never branching. Two correction paths, chosen by whether a conflict exists:

- **No conflict (single-pick correction):** an already-awarded pick may be corrected in place if the winning team has made no acquisition since. Reverse that one pick's ledger/roster effects, apply the fix. Nothing else changes.
- **Conflict, or undoing more than one pick (rollback):** undo the most recently resolved picks in strict reverse order, one at a time — a mirror image of the resolution transaction (void acquisition, reversing ledger entry, deactivate roster entry, restore nomination cursor once the earliest undone pick is reached). "Roll back to an arbitrary point" is just "undo the last N picks"; there is no separate checkpoint/snapshot machinery. See `data-model.md` §17.5 and `state-machine-flows.md` §14–15.

This eliminates the need for event-sourcing discipline anywhere in the core, and eliminates `DraftCheckpoint`/timeline-branching entirely.

### Multi-tenancy

The server supports multiple concurrently RUNNING drafts across different leagues in one deployment (MVP target: at least two at once). All draft state, timers, nomination cursors, and WS broadcast groups are keyed by `draft_id` — never a module-level singleton.

### Authentication (MVP)

Site-wide password gates the app → select League → select Team → team password (Owner), or league password (Commissioner). All commissioner-configured, no self-service accounts, no email step. Passwords hashed at rest. See PRD.md §4.4.

---

## Build Mode Legend

- 🔒 **Core / sequential** — touches the shared authoritative state machine or the WebSocket protocol directly. Build in one continuous effort (not fanned out to parallel agents); correctness here depends on one coherent mental model of the invariants in `data-model.md` §21.
- 🧩 **Parallelizable** — decoupled from live auction state once the core API/schema is frozen. Safe to hand to separate agents/sessions against a fixed contract.

---

## Phase 0 — Project Scaffold + Protocol Foundation 🔒

**Goal:** monorepo boots; server and client speak a versioned, sequence-numbered WS envelope from day one, even though nothing meaningful flows through it yet.

- `server/`, `web/`, `shared-types/` packages; shared `tsconfig`.
- Postgres connection + migration tool (pick one: `node-pg-migrate`, Drizzle, or Prisma — decide before starting).
- `shared-types/protocol.ts`: the WS message envelope (`{seq, draft_id, timeline_id, event_type, payload, server_time}`), command/ack/error shapes, and a protocol version field. Every later phase's broadcasts use this from the start — retrofitting it later (as originally planned) was flagged as a real risk and is why it's in Phase 0.
- Fastify server with health-check route + a WS endpoint that accepts connections keyed by `draft_id` (proves multi-draft routing works before any draft logic exists).
- Vite React app that connects and shows connection status; keep growing this into a crude dev console (bid/nominate buttons) alongside the core build rather than waiting until Phase 6's frontend fan-out — it's the cheapest way to keep protocol and latency assumptions honest.
- Lint/format/test harness wired (this is what CLAUDE.md's "build/test commands" section gets filled in from).
- CI: typecheck + lint + test on push.

**Acceptance:** `npm run dev` starts server + web; web shows "connected"; two browser tabs can open two different fake `draft_id`s and receive independent echoes; `npm test` runs; typechecker runs clean.

---

## Phase 1 — Authentication + League/Roster/Scoring Configuration 🔒

**Entities:** `League` (+ `commissioner_password_hash`, `logo_asset_uri`), `User`, `Team` (+ `team_password_hash`), `Membership`, `TeamMedia`, `RosterConfiguration`, `RosterSlotDefinition`, `ScoringConfiguration`, `ScoringRule`, `AuctionConfiguration`, `AutoAgentLeagueDefaults`.

- Auth: site password (server config, hashed), login flow (site password → League → Commissioner-password-or-Team-select-then-team-password), signed session token `{role, league_id, team_id?}` used for API and WS auth. See PRD.md §4.4, data-model.md §3.6.
- Commissioner setup API + minimal UI: league name/logo/passwords, teams + team passwords, roster slots, scoring rules, auction timers/rules, `scheduled_start_at` (PRD §5.2).
- Enforce invariants: `total_roster_size == total_starter_slots + bench_slots`; effective starting budget resolution (team override vs. league default).
- Pre-draft lobby screen (`screen-information-architecture.md` §0.1): shows scheduled start time to all authenticated owners.

**Acceptance:** commissioner can create a full league config for a 12-team league, including passwords and a scheduled start time; an owner can log in via League→Team→password and land on the lobby seeing that scheduled time; invalid roster configs are rejected server-side.

---

## Phase 2 — Player Master, Draft Dataset, Ingestion

**Entities:** `Player`, `PlayerPositionEligibility`, `ProviderPlayerMapping`, `DataSource`, `DraftDataset`, `DatasetImport`, `PlayerSeasonStats`, `PlayerProjection`, `PlayerStatus`, `PlayerTier`, `AAVSource`, `PlayerAAV`.

**Phase 2a 🔒 (core):** schema, the `DraftDataset` freeze/version lifecycle (DRAFT → VALIDATED → FROZEN), and **one** working ingestion adapter (commissioner CSV) end to end — this proves the ingestion contract everything else builds against.

**Phase 2b 🧩 (parallelizable once 2a's adapter interface is frozen):** additional adapters — ESPN AAV PDF import (PRD §10.1, with ambiguity-resolution UI), FantasyPros, Sleeper/nflverse if desired.

**Acceptance:** a commissioner can load a CSV of players/projections/AAVs, review match/ambiguity counts (`DatasetImport`), and freeze a `DraftDataset` version. The live draft can start with a frozen dataset.

---

## Phase 3 — Auction Core 🔒

The single largest phase, kept as one unit deliberately: nomination, the PlayerAuction state machine, bid atomicity, and resolution/ledger/roster are one transactional pipeline (state-machine-flows.md §2–§7). Splitting them across separate "done" checkpoints invites acceptance criteria that can't actually be exercised in isolation — e.g. a PlayerAuction can't be meaningfully "resolved" without the ledger and roster-assignment logic that resolution requires.

**Entities:** `Draft`, `DraftTeamState`, `TeamDraftMediaState`, `PlayerAuction`, `NominatorMatchRight`, `BidAttempt`, `Acquisition`, `RosterEntry`, `BudgetLedgerEntry`, `NominationQueueEntry` (schema + read path only — auto-nominate fallback is wired here; full CRUD/UI is Phase 6).

Internal milestones (build in order, but the phase isn't "done" until all pass together):

1. **Draft state machine + nomination order.** `UPCOMING → RUNNING ↔ PAUSED → COMPLETE`. Nomination turn flow: select next eligible nominator, start Nomination Timer, fall back to `NominationQueueEntry` on missed turn (need a defined fallback policy if the queue is also empty — pick one, e.g. skip the team's turn, and record the decision here before building). Nomination audio flow (§12), presentation-only, never blocks the auction.
2. **PlayerAuction state machine.** `SECOND_BID_OPEN → REBID_OPEN → RESOLVING → AWARDED` (+ `PAUSED`, `REVERSED`). Nominator Match availability (§6). No-competing-bid resolution: nominator wins at opening price when Second-Bid Timer expires.
3. **Bid atomicity, timers, stale-state protection.** Full decision pipeline (§4): authenticate → dedupe idempotency key → lock PlayerAuction → validate deadline → validate by bid type (`PLUS_ONE`, `MATCH`, `CUSTOM`, `AUTO_AGENT`, `COMMISSIONER_FOR_OWNER`) → validate roster/budget → anti-sniping classification → persist → commit → broadcast. Anti-snipe penalty state needs a home on `DraftTeamState` (e.g. `anti_snipe_penalty_remaining_auctions`) — add it here, the original schema didn't have anywhere to store it. Full `BidAttempt` telemetry including rejected attempts. Define "server receipt time" precisely: timestamped in the `ws` message handler before any await/queueing, so an event-loop stall can't flip an in-time bid to expired.
4. **Resolution: Acquisition, Budget Ledger, starter-first RosterEntry.** Resolution transaction (§7): lock → determine winner → validate still legal → create Acquisition → debit ledger → assign roster slot via starter-first algorithm (`data-model.md` §4.3: lowest `assignment_priority` among eligible unfilled starter slots, else Bench; never reshuffle prior assignments) → update DraftTeamState → commit → broadcast. Also define and implement the DB-down behavior here: on a Postgres write failure, auto-pause the draft in memory, broadcast PAUSED, retry, resume with restored deadlines (reuses the pause/resume machinery from milestone 1).

**Acceptance:** every bid/starter-first/nomination-audio scenario in `PRD.md` §44 passes as an automated test; ledger reconciles after a sequence of acquisitions; max-legal-bid formula enforced; no accepted event broadcasts before commit.

---

## Phase 4 — Client Session / Reconnect + Multi-Draft Isolation 🔒

**Entities:** `DraftClientSession`.

- Reconnect protocol on top of Phase 0's envelope: snapshot-on-connect, missed-event replay by sequence number.
- Multi-window disconnect detection (§10): team counted disconnected only when **zero** valid sessions remain; Draft View + War Room from the same owner count as one identity.
- Reconnect recovery payload per PRD §40 (current auction, price, leader, deadline, budget, roster, Match state, control mode, missed events).
- Multi-draft isolation (state-machine-flows.md §23): confirm no state leaked across `draft_id` boundaries under concurrent load.

**Acceptance:** killing and restarting the server mid-auction recovers all connected clients within the PRD's 5-second target; closing one of two windows for the same team does not trigger disconnect state; two concurrently RUNNING drafts (different leagues) run bids simultaneously with zero cross-talk.

---

## Phase 5 — Manual / Auto-Agent Control 🔒

**Entities:** extends `DraftTeamState`; `AutoAgentConfiguration` schema + read path (full CRUD/UI is Phase 6).

- Control mode state machine (§9): `MANUAL_CONNECTED ↔ MANUAL_RECONNECTING → AUTO_AGENT_DISCONNECTED`; `MANUAL ↔ AUTO_AGENT_USER/COMMISSIONER`.
- Disconnect grace timer (`disconnect_auto_agent_delay_ms`), broadcast toasts on every transition.
- Auto-Agent offer calculation (§11): base value (Target or Primary AAV) → variance → `max_over_base_pct` ceiling → starter/bench distinction → clamp to max legal bid → Do Not Draft filter.
- Define and implement Auto-Agent bidding cadence explicitly (unspecified in the PRD): react to losing leadership with a +$1 bid after a small randomized delay, never inside the same transaction as the bid that triggered it. Auto-Agent bids/nominates through the *same* Phase 3 pipeline — no separate code path.

**Acceptance:** all Auto-Agent acceptance scenarios in PRD §44 pass, including "reconnection does not auto-resume manual" and "War Room disconnect alone does not trigger Auto-Agent."

---

## Phase 6 — Owner Private Strategy Data 🧩

**Entities:** `OwnerPlayerTarget`, `WatchListEntry`, `NominationQueueEntry` (full CRUD/UI; schema already exists from Phase 3), `DoNotDraftEntry`, `AutoAgentConfiguration` (full CRUD/UI; schema already exists from Phase 5).

- CRUD APIs, private to the owning team.
- Watch List `Nominate` action wired into Phase 3's nomination command (client-side only; no core change needed).

**Acceptance:** an owner can maintain all four private lists; Watch List never triggers auto-nomination; Nomination Queue does.

---

## Phase 7 — Commissioner Corrections + Rollback 🔒

**Entities:** `CommissionerAction`, `DraftTimeline` (single row per draft, created at Phase 3).

- Correction flow (`state-machine-flows.md` §14): for the currently open auction, unrestricted live-control edits. For an already-awarded pick, check conflict (has the winning team acquired anything since?) — no conflict: reverse-and-reapply in place; conflict: redirect to rollback.
- Rollback flow (§15): undo the most recently resolved picks in strict reverse order, one at a time, reusing Phase 3's resolution primitives in reverse (void acquisition, reversing ledger entry, deactivate roster entry, restore nomination cursor once the earliest undone pick is reached). Also restores Match state, team-completion state, and relevant Whammy/Auto-Agent state for each undone pick.
- This phase is smaller than originally scoped, because it's built as the mirror image of Phase 3's resolution logic rather than a general timeline-branching engine.

**Acceptance:** all correction/rollback scenarios in PRD §44 pass (no-conflict single-pick correction touches only one team; conflict correctly forces rollback; a 3-pick rollback restores nomination order, budgets, and rosters correctly); original events remain queryable as superseded history.

---

## Phase 8 — Whammy Framework 🧩

**Entities:** `WhammyConfiguration`, `WhammyDefinition`, `WhammyEvent`.

- Trigger evaluation (needs a `trigger_rule_json` field — add it, the PRD names "trigger rule" as configuration but the original schema had nowhere to store it), weighted selection, optional commissioner approval gate.
- Budget effects flow through the Phase 3 ledger (`WHAMMY` reason type) — reuses existing ledger API, does not reimplement it.
- Whammy financial effects must be undoable generically by Phase 7's rollback (any ledger entry on an undone pick's sequence is reversed by reason/timeline membership, not by special-casing Whammy) — verify this holds rather than adding Whammy-specific rollback logic.

**Acceptance:** a configured Whammy can trigger, optionally require approval, post a ledger entry that reconciles correctly, and is correctly reversed if a rollback undoes past its trigger point.

---

## Phase 9 — Analytics, Draft Summary Report, ESPN Reconciliation, Presentation 🧩

**Entities:** `DraftTeamEvaluation`, `ProviderTeamMapping`, `ExportJob`, `ReconciliationItem`, `DraftSummaryReport`, `ReportDeliveryAttempt`. Plus bid analytics from `BidAttempt` telemetry (PRD §35).

- Draft completion flow (§17): final integrity validation against `data-model.md` §21 invariants, generate `DraftTeamEvaluation`, canonical CSV/JSON export.
- Draft Summary Report generation (state-machine-flows.md §22, PRD §36.4): Owner view + League summary view, always available in-app; emailed to each owner/commissioner if external email delivery is enabled (stub the email-send interface now, wire real SendGrid later — this is explicitly a future integration per PRD §4.4).
- ESPN transfer workflow (PRD §37): team mapping, entry-order worksheet, reconciliation tracking.
- Bid analytics queries/UI.

**Acceptance:** a completed draft produces valid exports, an ESPN entry-order worksheet, and both Draft Summary Report views; with email delivery disabled, reports remain fully available in-app; with it enabled (stub), delivery attempts are recorded correctly.

---

## Frontend Screens 🧩 (fan out once the Phase 3–5 API/WS contract is frozen)

Can be built in parallel per `screen-information-architecture.md`:

- Draft Room (primary auction view)
- War Room / second screen
- Commissioner Console
- Draft Board / presentation view
- Mobile Draft View

Login/lobby (§0 of the screen doc) is built inside Phase 1, not deferred here — you can't exercise Phase 1's acceptance criteria without it. Each later screen consumes the same WS event stream; none should require server-side changes to the core state machine.

---

## Sequencing Summary

```
🔒 Core, one continuous build:
  0 Scaffold+Protocol → 1 Auth+Config → 2a Dataset+CSV adapter →
  3 Auction Core (nomination + PlayerAuction FSM + bid atomicity + resolution/ledger/roster) →
  4 Session/Reconnect+Multi-Draft → 5 Auto-Agent → 7 Corrections/Rollback

🧩 Fan out after core is frozen and tested:
  2b Additional ingestion adapters
  6  Owner private strategy data (CRUD/UI)
  8  Whammy
  9  Analytics/Draft Summary Report/ESPN
  Frontend screens (Draft Room, War Room, Commissioner Console, Board, Mobile)
```

Phases 1 and 2a don't touch the auction state machine and could in principle run parallel to early Phase 3 work if more than one person/agent is building — the 🔒 label there is about correctness-critical coupling, not raw effort. Phases 3, 4, 5, and 7 share one authoritative state machine and stay sequential regardless.

Each 🔒 phase should end with automated tests covering its relevant `PRD.md` §44 acceptance scenarios and `data-model.md` §21 invariants before moving to the next phase.
