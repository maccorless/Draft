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

State-stored, not event-sourced. Postgres rows (`DraftTeamState`, `PlayerAuction`, `Acquisition`, `RosterEntry`, ledger) are live authority; the `DraftEvent` log exists for audit and WebSocket reconnect replay ("what did I miss"), not for reconstructing arbitrary past state — bounded rollback means we never need to.

Three rules make this actually work, not just sound plausible (`data-model.md` §17.1, `state-machine-flows.md` §26):

1. **Per-draft command serialization.** All mutating commands for one `draft_id` are processed by a single in-memory, in-order queue — one command in flight per draft at a time. This, not the Postgres row lock, is what prevents two interleaved commands from both validating against the same stale state.
2. **DraftEvent and its row effects commit in the same transaction, always.** Never a separate write. `sequence` is allocated from a per-draft counter inside that transaction, so the event log and the materialized rows can never diverge — this is what makes reconnect replay trustworthy.
3. **In-memory state updates only after commit succeeds.** On commit failure, in-memory state is untouched and the command is rejected back to its client — never partially applied.

On restart, any `Draft` found `RUNNING` is force-restored to `PAUSED` (never resumed against an already-expired deadline, which would otherwise auto-award the live auction to whoever led at crash time with no human check) — see `state-machine-flows.md` §25.

### Rollback and correction model

Append-only, no timeline entity, no branching, no arbitrary-point reconstruction (`data-model.md` §17.2, §17.5). Two paths:

- **Price-only correction (in-place).** The only correction ever done in place, and it's gated by legality, not chronology: replay the winning team's ledger forward from the pick's `resolution_sequence` under the corrected price; if every later pick by that team stays legal, apply the fix (supersede the `Acquisition`/`RosterEntry` rows, reversing + reapplying ledger entries). If the replay fails, reject and require rollback.
- **Winner or player changes, or a failed replay (rollback).** Undo the most recently resolved picks in strict reverse `resolution_sequence` order, as one all-or-nothing transaction, with the draft `PAUSED` first. After commit, offer a re-apply assist so re-fixing the undone picks is a few clicks, not a live re-auction.

This was revised from an earlier "no-conflict single-pick correction" design after two independent adversarial reviews found the same bug: checking only the *outgoing* team on a winner change misses that an *incoming* team might not legally support the corrected award. Restricting in-place correction to price (which never changes eligibility or cascades to other teams) removes the need to validate a second team's feasibility inline.

### Multi-tenancy

The server supports multiple concurrently RUNNING drafts across different leagues in one deployment (MVP target: at least two at once). All draft state, timers, nomination cursors, command queues, and WS broadcast groups are keyed by `draft_id` — never a module-level singleton. This is enforced at two layers, not one: the routing layer only ever touches the `draft_id` a connection asked for, and the **auth layer independently rejects** any command whose target `draft_id` resolves to a `league_id` that doesn't match the session token's `league_id` (`data-model.md` §3.6) — isolation isn't just "the client only asked for its own draft," it's checked server-side on every command.

### Authentication (MVP)

Site-wide password gates the app → select League → Commissioner password, Host password (if configured), or Team + team password. A commissioner may also own a team (`League.commissioner_team_id`), in which case one login grants both console and bidding rights — no second window needed. All commissioner-configured, no self-service accounts, no email step; the setup UI generates passwords by default.

Session tokens are HMAC-signed, expire (~48h), and carry a per-League/Team `auth_epoch` — bumping it (password change, or an explicit commissioner revoke) invalidates every previously issued token for that scope, which is the actual "kick this device" mechanism. The token is presented as the first message on the WS connection (an `AUTH` message), not a query parameter. All traffic is TLS in any non-localhost deployment. See PRD.md §4.4, data-model.md §3.6.

---

## Build Mode Legend

- 🔒 **Core / sequential** — touches the shared authoritative state machine or the WebSocket protocol directly. Build in one continuous effort (not fanned out to parallel agents); correctness here depends on one coherent mental model of the invariants in `data-model.md` §21.
- 🧩 **Parallelizable** — decoupled from live auction state once the core API/schema is frozen. Safe to hand to separate agents/sessions against a fixed contract.

---

## Phase 0 — Project Scaffold + Protocol Foundation 🔒

**Goal:** monorepo boots; server and client speak a versioned, sequence-numbered WS envelope from day one, even though nothing meaningful flows through it yet.

- `server/`, `web/`, `shared-types/` packages; shared `tsconfig`.
- Postgres connection + migration tool (pick one: `node-pg-migrate`, Drizzle, or Prisma — decide before starting).
- `shared-types/protocol.ts`: the WS message envelope (`{seq, draft_id, event_type, payload, server_time}`), an `AUTH` handshake message shape (token presented as the first message on the socket, not a query param — see Authentication above), command/ack/error shapes, and a protocol version field. Every later phase's broadcasts use this from the start — retrofitting it later (as originally planned) was flagged as a real risk and is why it's in Phase 0.
- Fastify server with health-check route + a WS endpoint that accepts connections keyed by `draft_id`, closing any socket that doesn't send a valid `AUTH` within ~5s (proves multi-draft routing and the auth handshake shape work before any draft logic exists).
- Vite React app that connects and shows connection status; keep growing this into a crude dev console (bid/nominate buttons) alongside the core build rather than waiting until Phase 6's frontend fan-out — it's the cheapest way to keep protocol and latency assumptions honest.
- Lint/format/test harness wired (this is what CLAUDE.md's "build/test commands" section gets filled in from).
- CI: typecheck + lint + test on push.

**Acceptance:** `npm run dev` starts server + web; web shows "connected"; two browser tabs can open two different fake `draft_id`s and receive independent echoes; a socket that never sends `AUTH` is closed after ~5s; `npm test` runs; typechecker runs clean.

---

## Phase 1 — Authentication + League/Roster/Scoring Configuration 🔒

**Entities:** `League` (+ `commissioner_password_hash`, `host_password_hash`, `commissioner_team_id`, `auth_epoch`, `logo_asset_uri`), `User`, `Team` (+ `team_password_hash`, `owner_email`, `auth_epoch`), `Membership`, `TeamMedia`, `RosterConfiguration`, `RosterSlotDefinition`, `ScoringConfiguration`, `ScoringRule`, `AuctionConfiguration`, `AutoAgentLeagueDefaults`.

- Auth: site password (server config, hashed), login flow (site password → League → Commissioner/Host/Team-then-password), HMAC-signed session token `{role, league_id, team_id?, league_auth_epoch, team_auth_epoch?, iat, exp}` used for API and WS auth, with the `auth_epoch` check re-run on every command, not just at login (see Authentication above; PRD.md §4.4, data-model.md §3.6).
- Basic in-memory rate limiter on the three password checks (site/commissioner/team), e.g. 5 failures per IP+target per minute.
- Commissioner setup API + minimal UI (`screen-information-architecture.md` §0.2): league name/logo/passwords (generated by default), optional host password, optional `commissioner_team_id`, teams + team passwords, roster slots, scoring rules, auction timers/rules, `scheduled_start_at` (PRD §5.2).
- `User`/`Membership` rows are created deterministically at this point (one per Team, one for the Commissioner, one for Host if configured) — not lazily per login (`data-model.md` §3.2).
- Enforce invariants: `total_roster_size == total_starter_slots + bench_slots`; effective starting budget resolution (team override vs. league default); at most one non-`COMPLETE` Draft per League.
- Pre-draft lobby screen (`screen-information-architecture.md` §0.1): shows scheduled start time (or a past-due "waiting for commissioner" state) to all authenticated owners, plus tabs into the Phase 6 prep tools once those exist.

**Acceptance:** commissioner can create a full league config for a 12-team league, including generated passwords and a scheduled start time; an owner can log in via League→Team→password and land on the lobby seeing that scheduled time; a commissioner-owned-team login yields one session with both console and bidding rights; invalid roster configs are rejected server-side; a token whose league doesn't match a target draft's league is rejected on every command, not just at connect; 6 failed team-password attempts in a minute are rate-limited.

---

## Phase 2 — Player Master, Draft Dataset, Ingestion

**Entities:** `Player`, `PlayerPositionEligibility`, `ProviderPlayerMapping`, `DataSource`, `DraftDataset`, `DatasetImport`, `PlayerSeasonStats`, `PlayerProjection`, `PlayerStatus`, `PlayerTier`, `AAVSource`, `PlayerAAV`.

**Phase 2a 🔒 (core):** schema, the `DraftDataset` freeze/version lifecycle (DRAFT → VALIDATED → FROZEN), and **one** working ingestion adapter (commissioner CSV) end to end — this proves the ingestion contract everything else builds against.

**Phase 2b 🧩 (parallelizable once 2a's adapter interface is frozen):** additional adapters — ESPN AAV PDF import (PRD §10.1, with ambiguity-resolution UI), FantasyPros, Sleeper/nflverse if desired. PDF parsing and large CSV imports should run off the main event loop (a `worker_thread`, or at minimum chunked processing) — this is exactly the kind of synchronous work that would otherwise stall a concurrently RUNNING draft in another league sharing the process (Multi-tenancy, above).

**Acceptance:** a commissioner can load a CSV of players/projections/AAVs, review match/ambiguity counts (`DatasetImport`), and freeze a `DraftDataset` version. The live draft can start with a frozen dataset.

---

## Phase 3 — Auction Core 🔒

The single largest phase, kept as one unit deliberately: nomination, the PlayerAuction state machine, bid atomicity, and resolution/ledger/roster are one transactional pipeline (state-machine-flows.md §2–§7). Splitting them across separate "done" checkpoints invites acceptance criteria that can't actually be exercised in isolation — e.g. a PlayerAuction can't be meaningfully "resolved" without the ledger and roster-assignment logic that resolution requires.

**Entities:** `Draft`, `DraftTeamState` (+ `anti_snipe_penalty_remaining_auctions`, `anti_snipe_strike_count`), `TeamDraftMediaState`, `PlayerAuction`, `NominatorMatchRight`, `BidAttempt`, `Acquisition` (+ `resolution_sequence`), `RosterEntry`, `BudgetLedgerEntry`, `NominationQueueEntry` (schema + read path only — auto-nominate fallback is wired here; full CRUD/UI is Phase 6).

Internal milestones (build in order, but the phase isn't "done" until all pass together):

1. **Draft state machine + nomination order.** `UPCOMING → RUNNING ↔ PAUSED → COMPLETE`. Nomination turn flow: select next eligible nominator, start Nomination Timer, fall back to `NominationQueueEntry` on missed turn (need a defined fallback policy if the queue is also empty — pick one, e.g. skip the team's turn, and record the decision here before building). Nomination audio flow (§12), presentation-only, never blocks the auction.
2. **PlayerAuction state machine.** `SECOND_BID_OPEN → REBID_OPEN → RESOLVING → AWARDED` (+ `PAUSED`, `REVERSED`). Nominator Match availability (§6). No-competing-bid resolution: nominator wins at opening price when Second-Bid Timer expires.
3. **Bid atomicity, timers, stale-state protection, command serialization.** Full decision pipeline (§4): authenticate/authorize (cross-league + team check, every command) → dedupe idempotency key → enqueue on this draft's serialized command queue → lock PlayerAuction → validate deadline → validate by bid type (`PLUS_ONE`, `MATCH`, `CUSTOM`, `AUTO_AGENT`, `COMMISSIONER_FOR_OWNER`) → validate roster/budget → anti-sniping classification (`AUTO_AGENT` bids exempt from penalty accrual, §24) → persist + append `DraftEvent` in the same transaction → commit → update in-memory state → broadcast. Full `BidAttempt` telemetry including rejected attempts, with `session_id` non-null for every human bid type. Define "server receipt time" precisely: timestamped in the `ws` message handler before any await/queueing, so an event-loop stall can't flip an in-time bid to expired.
4. **Resolution: Acquisition, Budget Ledger, starter-first RosterEntry.** Resolution transaction (§7): lock → determine winner → validate still legal (with an explicit fallback branch — previous legal bid, else nominator at opening price — plus a commissioner alert, if it isn't) → create Acquisition with the next `resolution_sequence` → debit ledger → assign roster slot via starter-first algorithm (`data-model.md` §4.3) → update DraftTeamState → append event + commit together → broadcast. Runs through the same serialized queue as bids, so this failure branch is defensive, not load-bearing.
5. **DB-down handling and crash recovery.** On a Postgres write failure: leave in-memory state untouched, reject the failing command, and — if it was a resolution — auto-pause in memory (an unsequenced control frame, since sequencing itself needs a working DB write) and require explicit commissioner resume once the DB recovers (§26). On process restart, any `RUNNING` Draft comes back `PAUSED`, never resumed against a stale expired deadline (§25).

**Acceptance:** every bid/starter-first/nomination-audio scenario in `PRD.md` §44 passes as an automated test; ledger reconciles after a sequence of acquisitions; max-legal-bid formula enforced; no accepted event broadcasts before commit; killing the DB connection mid-bid rejects cleanly without corrupting in-memory state; killing and restarting the server mid-auction comes back `PAUSED`, not resolved.

---

## Phase 4 — Client Session / Reconnect + Multi-Draft Isolation 🔒

**Entities:** `DraftClientSession`.

- Reconnect protocol on top of Phase 0's envelope: snapshot-on-connect (tagged with the `state_version`/sequence it reflects, taken from the command queue's quiescent state, so replay picks up strictly after it with no gap or double-delivery), missed-event replay by sequence number.
- Multi-window disconnect detection (§10): team counted disconnected only when **zero** valid sessions remain; Draft View + War Room from the same owner — including a commissioner session that also carries `team_id` — count as one identity.
- Reconnect recovery payload per PRD §40 (current auction, price, leader, deadline, budget, roster, Match state, control mode, missed events).
- Multi-draft isolation, both layers (state-machine-flows.md §23): data/timer isolation confirmed under concurrent load, *and* a negative auth test — a valid token for League A's draft is rejected against League B's `draft_id`.

**Acceptance:** killing and restarting the server mid-auction recovers all connected clients within the PRD's 5-second target; closing one of two windows for the same team does not trigger disconnect state; two concurrently RUNNING drafts (different leagues) run bids simultaneously with zero cross-talk *and* zero cross-auth (League A's token rejected on League B's draft); Draft B's bid-ack p95 holds while Draft A is mid-ingestion or mid-completion (not just data isolation — a latency assertion under concurrent heavy work).

---

## Phase 5 — Manual / Auto-Agent Control 🔒

**Entities:** extends `DraftTeamState`; `AutoAgentConfiguration` schema + read path (full CRUD/UI is Phase 6).

- Control mode state machine (§9): `MANUAL_CONNECTED ↔ MANUAL_RECONNECTING → AUTO_AGENT_DISCONNECTED`; `MANUAL ↔ AUTO_AGENT_USER/COMMISSIONER`.
- Disconnect grace timer (`disconnect_auto_agent_delay_ms`), broadcast toasts on every transition.
- Auto-Agent offer calculation (§11): base value (Target or Primary AAV) → variance → `max_over_base_pct` ceiling → starter/bench distinction → clamp to max legal bid → Do Not Draft filter.
- **Bidding cadence (§24, corrects an earlier gap):** the trigger is *not* "react to losing leadership" alone — that never fires for an agent that's never held the lead, so it would never place a first competing bid. Correct trigger: on auction open, and again on every leadership change, if the team isn't currently leading and price is below its computed willingness, schedule a +$1 bid after a small randomized delay, re-validating at fire time. `AUTO_AGENT` bids are exempt from anti-snipe *penalty accrual* (still recorded as telemetry). Auto-Agent bids/nominates through the *same* Phase 3 pipeline — no separate code path.

**Acceptance:** all Auto-Agent acceptance scenarios in PRD §44 pass, including "reconnection does not auto-resume manual" and "War Room disconnect alone does not trigger Auto-Agent"; an Auto-Agent team places a first competing bid on a fresh nomination (not just reacts to being outbid); two Auto-Agent teams outbid simultaneously ladder correctly rather than double-accepting.

---

## Phase 6 — Owner Private Strategy Data 🧩

**Entities:** `OwnerPlayerTarget`, `WatchListEntry`, `NominationQueueEntry` (full CRUD/UI; schema already exists from Phase 3), `DoNotDraftEntry`, `AutoAgentConfiguration` (full CRUD/UI; schema already exists from Phase 5).

- CRUD APIs, private to the owning team.
- Watch List `Nominate` action wired into Phase 3's nomination command (client-side only; no core change needed).
- Pre-Draft Lobby tabs (`screen-information-architecture.md` §0.1): Watch List, Nomination Queue, Targets, Do Not Draft, Auto-Agent config, and media upload, all reachable while the Draft is `UPCOMING`.

**Acceptance:** an owner can maintain all four private lists from the lobby before the draft starts, and continue to during the draft; Watch List never triggers auto-nomination; Nomination Queue does.

---

## Phase 7 — Commissioner Corrections + Rollback 🔒

**Entities:** `CommissionerAction` (+ `idempotency_key`).

- Correction flow (`state-machine-flows.md` §14): for the currently open auction, unrestricted live-control edits. For an already-awarded pick, **only a price change may be corrected in place**, and only after replaying the team's ledger forward under the corrected price confirms every later pick by that team stays legal. A winner or player change, or a failed replay, always redirects to rollback.
- Rollback flow (§15): requires `Draft.status == PAUSED` (auto-pause on entry if needed); preview pinned to `state_version`, re-taken if state advances before confirm; undoes the most recently resolved picks in strict reverse `resolution_sequence` order as **one transaction** (void acquisition, ledger reversal, deactivate roster entry, mark `PlayerAuction` `REVERSED`, restore nomination cursor once the earliest undone pick is reached). After commit, offer the **re-apply assist**: the undone picks, in original order, one click each from re-award via the existing manual-award control.
- This phase is smaller than originally scoped: it reuses Phase 3's resolution primitives in reverse rather than building a general timeline-branching engine, and the price-only restriction removes the need to validate a second team's feasibility inline (see Rollback and correction model, above).

**Acceptance:** all correction/rollback scenarios in `PRD.md` §44 pass — a legal price replay corrects in place touching only one team; an illegal replay or any winner/player change is refused and redirected to rollback regardless of how recently that team last picked; a multi-pick rollback restores nomination order, budgets, and rosters correctly and offers a working re-apply assist; rollback refuses to start against a non-`PAUSED` draft; original events remain queryable as superseded history.

---

## Phase 8 — Whammy Framework 🧩

**Entities:** `WhammyConfiguration`, `WhammyDefinition` (+ `trigger_rule_json`), `WhammyEvent`.

- Trigger evaluation, weighted selection, optional commissioner approval gate.
- Budget effects flow through the Phase 3 ledger (`WHAMMY` reason type) — reuses existing ledger API, does not reimplement it.
- Whammy financial effects must be undoable generically by Phase 7's rollback (any ledger entry after the rollback's target `resolution_sequence` is reversed the same way any other entry is, purely by sequence — nothing Whammy-specific) — verify this holds rather than adding Whammy-specific rollback logic.

**Acceptance:** a configured Whammy can trigger, optionally require approval, post a ledger entry that reconciles correctly, and is correctly reversed if a rollback undoes past its trigger point.

---

## Phase 9 — Analytics, Draft Summary Report, ESPN Reconciliation, Presentation 🧩

**Entities:** `DraftTeamEvaluation`, `ProviderTeamMapping`, `ExportJob`, `ReconciliationItem`, `DraftSummaryReport` (league-level), `DraftTeamReport` (per-team), `ReportDeliveryAttempt`. Plus bid analytics from `BidAttempt` telemetry (PRD §35).

- Draft completion flow (§17): final integrity validation against `data-model.md` §21 invariants, generate `DraftTeamEvaluation`, canonical CSV/JSON export.
- Draft Summary Report generation (state-machine-flows.md §22, PRD §36.4): league summary (visible to all owners, no toggle) + per-team `DraftTeamReport` rows, always available in-app; emailed to each owner (`Team.owner_email`) and the commissioner if external email delivery is enabled (stub the email-send interface now, wire real SendGrid later — future integration per PRD §4.4). Report generation, like PDF/CSV ingestion (Phase 2b), should run off the main event loop if it's heavy enough to threaten a concurrently RUNNING draft's latency.
- Draft Room/War Room clients route to the Draft Summary Report screen on `DRAFT_COMPLETED`; an owner authenticating after completion lands there directly, not at the (UPCOMING-only) lobby.
- ESPN transfer workflow (PRD §37): team mapping, entry-order worksheet, reconciliation tracking.
- Bid analytics queries/UI.

**Acceptance:** a completed draft produces valid exports, an ESPN entry-order worksheet, a league summary every owner can view, and per-team reports each owner can only view their own of; with email delivery disabled, reports remain fully available in-app; with it enabled (stub), delivery attempts are recorded correctly for owners with an email on file and skipped for those without.

---

## Frontend Screens 🧩 (fan out once the Phase 3–5 API/WS contract is frozen)

Can be built in parallel per `screen-information-architecture.md`:

- Draft Room (primary auction view)
- War Room / second screen
- Commissioner Console
- Draft Board / presentation view
- Mobile Draft View

Login/lobby (§0) and Commissioner Setup (§0.2) are built inside Phase 1, not deferred here — you can't exercise Phase 1's acceptance criteria without them. Each later screen consumes the same WS event stream; none should require server-side changes to the core state machine.

---

## Sequencing Summary

```
🔒 Core, one continuous build:
  0 Scaffold+Protocol → 1 Auth+Config → 2a Dataset+CSV adapter →
  3 Auction Core (nomination + PlayerAuction FSM + bid atomicity +
    resolution/ledger/roster + command serialization + crash recovery) →
  4 Session/Reconnect+Multi-Draft → 5 Auto-Agent → 7 Corrections/Rollback

🧩 Fan out after core is frozen and tested:
  2b Additional ingestion adapters
  6  Owner private strategy data (CRUD/UI)
  8  Whammy
  9  Analytics/Draft Summary Report/ESPN
  Frontend screens (Draft Room, War Room, Commissioner Console, Board, Mobile)
```

Phases 1 and 2a don't touch the auction state machine and could in principle run parallel to early Phase 3 work if more than one person/agent is building — the 🔒 label there is about correctness-critical coupling, not raw effort. Phases 3, 4, 5, and 7 share one authoritative state machine and one command-serialization model and stay sequential regardless.

Each 🔒 phase should end with automated tests covering its relevant `PRD.md` §44 acceptance scenarios and `data-model.md` §21 invariants before moving to the next phase.
