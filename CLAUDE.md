# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project State

Pre-implementation. This repo currently contains only design documents; there is no code, build system, or test suite yet. Read the design docs before proposing or writing any code:

- `PRD.md` — full product requirements (the authoritative spec)
- `data-model.md` — full domain/data model: entity schemas by bounded context, Mermaid ERD, and a critical-invariants checklist (section 21) that any implementation must satisfy
- `state-machine-flows.md` — agent-consumable behavioral spec: state machines, bid decision flow, event types, and a recommended implementation order (section 20)
- `screen-information-architecture.md` — UX/IA spec for each screen
- `DataModel.png` — data model diagram (rendered image of the model in `data-model.md`)
- `BUILD_PLAN.md` — chosen stack, phased build sequence, and which phases are core/sequential vs. safe to parallelize across agents

## What This Is

A fantasy-football **auction draft** platform: 12-team salary-cap live auction, server-authoritative bidding, with post-draft roster transfer to ESPN. It conducts the draft only; season-long league management is explicitly out of scope (PRD §3.2).

## Core Architectural Constraints

These come from the PRD and must hold in any implementation:

1. **Server authority.** The server owns all auction state: prices, deadlines, winners, budgets, roster assignment. Client countdowns and client-displayed prices never determine outcomes. Anti-sniping classification uses server receipt time.
2. **Append-only history, no timeline branching.** Every bid attempt (accepted and rejected) is persisted as immutable telemetry (PRD §34). Corrections and rollbacks append new/compensating rows and events; existing rows are superseded (marked inactive) but never mutated or deleted, and there is no separate timeline entity to branch into (data-model.md §17.2, §17.5).
3. **Stale-state protection.** Relative operations (+$1, Match) carry expected current bid + auction version and are rejected on mismatch. Custom absolute bids are accepted as the exact entered amount or rejected; the server never silently changes a user's amount (PRD §15–16).
4. **Bid atomicity.** Every mutating command for a draft runs through that draft's per-draft serialized command queue (one in flight at a time) — validate → persist + append DraftEvent in the same transaction → commit → update in-memory state → broadcast. No accepted event is broadcast before commit, and in-memory state never gets ahead of a failed commit (PRD §39, state-machine-flows §4, §26).
5. **Money is exact integer units**, all financial calculations server-side. `max legal bid = remaining budget − ($1 reserve × other required remaining roster spots)`.
6. **No strategic valuation.** AAVs are static reference data. The system never computes fair value, recommended bids, or blended AAVs. Owner Target Values are private per-team data.
7. **Auto-Agent is explicit and simple.** Team control mode (`MANUAL` / `AUTO_AGENT`) is separate from connection state. Disconnect of ALL of a team's sessions (multi-window counts as one identity) starts a grace timer before Auto-Agent takeover; reconnection never auto-resumes manual control. All transitions broadcast and are audited. Its bidding cadence triggers on auction open and on every leadership change while below its willingness ceiling — not just "reacts to losing leadership," which would never fire for an agent that's never led (state-machine-flows.md §24).
8. **Starter-first roster assignment** is deterministic: lowest priority-number eligible unfilled starter slot, then bench. Never reshuffle prior assignments (PRD §7).
9. **External data populates the draft; it does not operate it.** Player data, projections, AAVs, and tiers are imported pre-draft into a frozen versioned Draft Dataset; the live auction must run even if sources are down.
10. **Only price is corrected in place; everything else is rollback.** An already-awarded pick's price may be corrected in place, gated by replaying the team's ledger forward to confirm no later pick by that team becomes illegal — chronology doesn't matter, legality does. A winner or player change always goes through rollback: undo the most recently resolved picks in strict reverse `resolution_sequence` order, as one transaction, with the draft paused first. There is no jump-to-any-checkpoint mechanism (PRD §31, data-model.md §17.5).
11. **Multi-draft isolation, enforced at two layers.** One deployment may host multiple concurrently RUNNING drafts across different leagues. State, timers, and command queues are keyed by `draft_id` (never a module-level singleton), *and* every command independently re-checks that its target draft's `league_id` matches the session token's `league_id` — routing alone is not the isolation mechanism (data-model.md §3.6).
12. **Auth is password-based and session-scoped, not account-based.** Site password → League → Commissioner/Host/Team password. Tokens expire (~48h) and carry a per-League/Team `auth_epoch`; bumping it (password change or explicit revoke) invalidates every previously issued token for that scope — this is the only revocation mechanism, so it must actually be checked on every command, not just at login (PRD §4.4, data-model.md §3.6).

## Key Domain Concepts

- **Three timers**: Nomination, Second-Bid (after opening nomination), Rebid (after first competing bid), plus configurable anti-sniping deadline modification.
- **Nominator Match**: one-per-auction right to tie the current high bid at the same price (the only same-price leader change). Consumed permanently once used.
- **Nomination Queue** auto-nominates when an owner misses their turn; **Watch List** never auto-nominates.
- **Whammy**: optional commissioner-configured random budget/entertainment events, flowing through the Budget Ledger.
- **Draft Room vs War Room**: acting vs thinking. Same owner may open both as synchronized windows sharing one team identity.

## Vocabulary and Schema

- Use the event type names in `state-machine-flows.md` §19 (e.g. `BID_ACCEPTED`, `PLAYER_AWARDED`, `TEAM_AUTO_AGENT_ENABLED`) rather than inventing new ones.
- Use the entity names and field shapes in `data-model.md` (e.g. `PlayerAuction`, `BidAttempt`, `DraftTeamState`, `BudgetLedgerEntry`). Money fields are `*_minor` integers; durations are `*_ms`.
- Before implementing any draft/auction behavior, check it against the invariants list in `data-model.md` §21.

## Stack (chosen — see `BUILD_PLAN.md`)

Node + TypeScript (Fastify) backend, plain `ws` WebSockets with a sequence-numbered envelope defined from Phase 0, Postgres, React + Vite + TypeScript frontend, Zod for shared client/server validation. Monorepo: `server/`, `web/`, `shared-types/`. State-stored (not event-sourced): Postgres rows are live authority; the `DraftEvent` log is for audit and WS reconnect replay, not arbitrary state reconstruction — rollback is bounded to "undo the last N picks," not arbitrary-point, so this is sufficient (see constraints 2 and 10 above). On restart, a `RUNNING` draft always comes back `PAUSED`, never resumed against a stale expired deadline.

## Build Sequence

Follow `BUILD_PLAN.md` phase by phase, in order: 0 Scaffold+Protocol → 1 Auth+Config → 2a Dataset+CSV adapter → 3 Auction Core (nomination + PlayerAuction FSM + bid atomicity + resolution/ledger/roster + command serialization + crash recovery, kept as one phase deliberately) → 4 Session/Reconnect+Multi-Draft → 5 Auto-Agent → 7 Corrections/Rollback. These share one authoritative state machine and one command-serialization model and must be built as one continuous effort, not fanned out to parallel agents. Phases 2b, 6, 8, 9, and the frontend screens are **parallelizable** once the core API/schema is frozen and tested. Each core phase should pass its relevant `PRD.md` §44 acceptance scenarios and `data-model.md` §21 invariants before starting the next.

## When Code Exists

Update this file with actual build, test, and lint commands once Phase 0 (scaffold) lands. None exist yet; do not assume any.
