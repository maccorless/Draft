# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project State

Built and promoted to `develop` (server/web/shared-types monorepo, Postgres schema via Drizzle, 9 migrations applied). Read the design docs before proposing or writing any auction/draft behavior — they remain the authoritative spec even though the code now exists:

- `knowledge/PRD.md` — full product requirements (the authoritative spec)
- `knowledge/data-model.md` — full domain/data model: entity schemas by bounded context, Mermaid ERD, and a critical-invariants checklist (section 21) that any implementation must satisfy
- `knowledge/state-machine-flows.md` — agent-consumable behavioral spec: state machines, bid decision flow, event types, and a recommended implementation order (section 20)
- `knowledge/screen-information-architecture.md` — UX/IA spec for each screen
- `knowledge/BUILD_PLAN.md` — chosen stack, phased build sequence, and which phases are core/sequential vs. safe to parallelize across agents

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

## Commands

```bash
npm install                      # root workspace install (server, web, shared-types)
cp .env.example .env             # then fill in DATABASE_URL, JWT_SECRET, NODE_ENV

# Backend — bare `npm run dev` will NOT load .env; env-check.cjs only validates
# process.env, it never populates it. Launch with Node's --env-file flag:
( cd server && node --env-file=../.env ../node_modules/.bin/tsx watch src/main.ts )

# Frontend (reads the same repo-root .env via vite.config.ts's envDir/loadEnv)
( cd web && npm run dev )        # http://localhost:5173, proxies /api,/ws,etc. to PORT (default 3000)

npm run db:migrate --workspace server   # apply drizzle migrations
npm run db:seed --workspace server      # seed a dev league (see server/db/seed-data.ts for credentials)

npm test                          # vitest run, whole workspace
npm run typecheck                 # tsc --noEmit, whole workspace
npm run build                     # tsc + vite build, whole workspace
```

## Local Dev Gotchas

- **`web/src/App.tsx`'s `DevIdentityPicker`** (dev-only one-click sign-in as Commissioner or any team) has hardcoded passwords that must exactly match `server/db/seed-data.ts`'s constants (`SITE_PASSWORD`, `COMMISSIONER_PASSWORD`, `TEAM_PASSWORD`). If either changes independently, dev login breaks silently with no obvious error.
- **On restart, a `RUNNING` draft always comes back `PAUSED`** (see constraint 4 above) — don't mistake this for a bug during manual/dogfood testing.

### Auth hook convention (`server/src/league/auth-hook.ts`)

`requireCommissioner` enforces COMMISSIONER role plus epoch-checked scope. For
routes an OWNER must also read (not mutate), use `requireLeagueMember`
instead — same league-scope/epoch checks, no role restriction. Both re-check
the auth_epoch against the correct table for the token's own role
(`leagues.auth_epoch` for COMMISSIONER/HOST, `teams.auth_epoch` for OWNER) —
never compare an OWNER token's epoch against the league row.

<!-- AAH:BEGIN -->
# AAH Delivery Project — Draft

This project (Draft, stack: <unspecified>) uses the AAH (Ascend Agentic
Harness) delivery framework for standardized AI-assisted software delivery.

## Core Rules

### State Management
- ALWAYS read `manifest.yaml` and `claude-progress.json` before starting any work
- ALWAYS read `decision-registry.yaml` for decision state (replaces phase-plan.yaml)
- ALWAYS update `claude-progress.json` at the end of every feature or session

### Testing — NO MOCKS
- NEVER use mock frameworks (jest.mock, unittest.mock, sinon, pytest-mock,
  nock, testdouble, vitest mock, proxyquire) in test code
- ALL tests must be functional — executing against the real running system
- ALL tests must be executable locally
- Do not generate mocks, stubs, or test doubles unless the feature spec
  explicitly defines a local test double

### Environment Configuration — NON-NEGOTIABLE
- `.env.example` is the SINGLE SOURCE OF TRUTH for what configuration this
  application needs. It is COMMITTED and holds variable NAMES with safe
  placeholders — NEVER a real secret, key, password, or endpoint
- `.env` holds the real values, is gitignored, and is the ONLY place values live.
  Never read a value from `.env.example`; never write a value into it
- The startup env checker (`config/env_check.py` or `config/env-check.cjs`,
  depending on stack) validates every required variable at boot and fails with
  `ERR_CDR_78_EX_CONFIG`, naming every missing variable at once and pointing the
  user at `cp .env.example .env`. Call it from the application entrypoint BEFORE
  any module reads configuration
- EVERY module that reads a new environment variable does THREE things in the
  same change: (1) lists the name in its feature file's
  `## Required Env Variables` section, (2) adds it to `.env.example` with a safe
  placeholder, (3) registers it in the checker's required list. Doing one or two
  of the three is what produces a runtime failure nobody can diagnose
- If the project's stack ships no checker (Go, Rust, Java, …), the scaffold-first
  feature implements the SAME contract in the project's own language: same error
  code, same message shape, same `.env.example` guidance
- NEVER work around a missing variable by hardcoding a value, inlining a default
  for a secret, or catching the config error — fix the environment

### Feature List Protection
- It is UNACCEPTABLE to remove or edit features in feature-list.json
- ONLY status changes (passes: true/false) are allowed
- Structural changes will be blocked by hooks

### Artifacts
- ALWAYS write artifacts to the correct `.aah/` subdirectory
- ALWAYS follow artifact templates when generating documents

### Git Discipline
- ALWAYS commit progress to git with descriptive messages after meaningful changes
- NEVER leave uncommitted work at the end of a feature or session
- Leave the environment in a clean, working state

### Orchestrator Loop — MANDATORY During Implement Phase
- ALWAYS use the orchestrator to determine what to do next:
  ```
  aah run core.build.orchestrator next-action
  ```
- NEVER run build-phase scripts directly without orchestrator guidance
- The orchestrator is the SINGLE SOURCE OF TRUTH for execution flow
- After every action completes, call `next-action` again to get the next step
- The orchestrator loop is:
  1. Call `orchestrator next-action` → receive ONE action
  2. Execute exactly that action (the command/script it tells you to run)
  3. Call `orchestrator next-action` again
  4. Repeat until `action: "complete"`
- NEVER skip steps, reorder steps, or improvise your own flow
- NEVER run quality_checks, validate_checkpoint, runtime_validation,
  run_regression_suite, or merge scripts unless the orchestrator told you to
- If the orchestrator returns an error, fix the underlying issue and re-call it
- NEVER judge a gate as "unnecessary" — every wave goes through every gate
  regardless of complexity. "Scaffold only" or "trivial" is NOT a reason to skip
- NEVER advance `current_wave` yourself — only the orchestrator's `merge` action
  advances waves after ALL gates pass
- NEVER write expertise/checkpoint markers without completing the full procedure
  — the orchestrator validates artifacts and will re-fire skipped gates
- When the orchestrator action includes a `skill` field, you MUST invoke
  that skill via the Skill tool — NEVER execute the steps manually

### Feedback Routing — NON-NEGOTIABLE
- ANY user message describing a bug, broken behavior, or change request
  MUST be routed through `Skill("aah-fix")` — NEVER act on it directly
- Bypass ONLY when the user explicitly says "do not update files" or
  "just tell me"

### Build Phase Constraints
- NEVER run raw test commands (`pytest`, `npm test`, `jest`) directly —
  use `aah run core.build.run_feature_tests` or `aah run core.build.run_regression_suite`
- ALL failures route through `Skill("aah-fix")` which dispatches the appropriate agent
- If a framework tool fails: fix only the git precondition (commit/checkout),
  retry. Everything else goes through `Skill("aah-fix")`

### Session Compaction Recovery
- If the session context is compacted, immediately reinvoke the skill that was
  active at the time of compaction using the Skill tool. This ensures full skill
  instructions are reloaded and no steps are missed.

### Orchestrator CLI Display — NON-NEGOTIABLE
- Bash tool output is COLLAPSED in the CLI (user must press Ctrl+O to see it)
- You MUST parse orchestrator JSON responses and re-render them as DIRECT
  markdown text in your response — NEVER rely on the Bash output being visible
- This applies to ALL orchestrator commands: `next-action`, `qa-report`,
  `wave-summary`, and any script that outputs checkpoint/gate banners
- After EVERY Bash call to an orchestrator or checkpoint script, immediately
  output a markdown heading + table with the key fields from the JSON response
- Example — after `next-action` returns `{"action": "run_qa", "wave": 3, "features": ["F005"]}`:

  ### ═══ QA GATE — Wave 3 ═══
  | Field    | Value                             |
  |----------|-----------------------------------|
  | Features | F005                              |
  | Action   | Run QA evaluator for each feature |

- This rule has the SAME priority as "NO MOCKS" — violating it means the user
  cannot see what is happening without manual intervention

### Work Increments
- Work on ONE feature at a time — complete it fully before starting the next
- Follow the DAG execution order defined in waves.json
- Get user confirmation between waves

### Branching Strategy
- `main` — production-ready code only, merge requires explicit criteria validation
- `develop` — integration branch, receives promoted code from integration branches
- `integration/wave-N` — temporary branches for cumulative testing after wave merges
- worktrees — isolated feature development branches off develop

## Directory Structure

- `.aah/discuss/` — Discuss phase artifacts
- `.aah/architecture/` — Architecture phase artifacts
- `.aah/plan/specs/` — Technical specifications
- `.aah/plan/features/` — Feature YAML definitions
- `.aah/plan/sprint-contracts/` — Sprint contracts per wave
- `.aah/build/` — Implementation state, test results
- `.aah/build/test-results/` — Per-feature and regression test results
- `.aah/deploy/` — Deployment configs and IaC
- `.aah/deploy/infra/` — Infrastructure provisioning templates
- `.aah/codebase-intel/` — Codebase intelligence artifacts (unified for greenfield and brownfield)
- `.aah/audit/` — Phase logs, traceability matrix
<!-- AAH:END -->
