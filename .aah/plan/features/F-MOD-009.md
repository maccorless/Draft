## Id

F-MOD-009

## Title

Commissioner Whammy: Budget Entertainment Events

## Module Ref

MOD-009

## Description

This module adds the optional Whammy mechanic: commissioner-triggered budget events (positive or negative) that flow through the existing `BudgetLedgerEntry` system and broadcast to all connected draft clients in real time. Whammy is configured per-league and gated by that configuration on every trigger attempt.

**Stack:** Node.js 20 + Fastify 4.x (server), PostgreSQL 15 + Drizzle ORM (db), React 18 + Vite 5 (web), Zod 3.x shared types. Monorepo layout: `server/`, `web/`, `shared-types/` as established by MOD-000.

**Architecture references the implementer must read directly:**
- `architecture-overview.md` §2 (serialized command queue, money-as-integers, append-only invariants) and §5 (cross-cutting auth, structured logging)
- `data-model.md §18` — authoritative schema for `WhammyConfiguration`, `WhammyDefinition`, and `WhammyEvent`; `§16` — `BudgetLedgerEntry.reference_id` points to `WhammyEvent.id` for `WHAMMY`-typed entries; `§21` — invariants checklist (remaining budget must reconcile with ledger sum)
- `knowledge/state-machine-flows.md §16` — the Whammy trigger flow: enabled check → limits check → optional approval gate → roster-completion financial invariant check → `BudgetLedgerEntry` append → broadcast
- `knowledge/screen-information-architecture.md §9.5` — Commissioner Console Whammy panel states (trigger/status, pending approval, apply/reject); `§0.2` — Whammy configuration lives in Commissioner Setup
- `schema/MOD-009-api-schema.yaml` — REST and WS event contracts (verbatim in `## API Contracts` below)
- `plan/resolved-standards.yaml` EXTRACTED-014 — Whammy financial effects must be reversible generically by rollback (no Whammy-specific rollback logic); EXTRACTED-037 — a Whammy should not normally make roster completion mathematically impossible; EXTRACTED-046 — entertainment features must never compromise auction correctness

**What the module builds end to end:**

*Database layer:* Drizzle schema additions for `WhammyConfiguration` (per-league: `enabled`, `allow_positive`, `allow_negative`, `max_per_team`, `max_per_draft`, `commissioner_approval_required`), `WhammyDefinition` (per-configuration: `name`, `type`, `budget_delta_minor`, `trigger_rule_json`, `display_message`, `weight`, `active`), and `WhammyEvent` (per-draft: `definition_id`, `team_id`, `trigger_event_sequence`, `budget_ledger_entry_id`, `status` enum `PENDING_APPROVAL | APPLIED | REJECTED | REVERSED`). Also adds `entry_type=WHAMMY` support to `BudgetLedgerEntry` and `WHAMMY_APPLIED` to the `DraftEvent` type enum if not already present from MOD-000/MOD-002.

*API layer:* `POST /drafts/:id/whammy` is commissioner-only. It enqueues through the per-draft `AsyncQueue` (same concurrency guard as all other mutating commands, per `architecture-overview.md §2`), validates against `WhammyConfiguration` constraints, and — if `commissioner_approval_required` is true — creates a `WhammyEvent` with `status=PENDING_APPROVAL` without applying the budget effect yet. On approval (or when approval is not required), it checks the roster-completion financial invariant, appends a `BudgetLedgerEntry` (`entry_type=WHAMMY`, `reference_id=WhammyEvent.id`), updates `DraftTeamState.remaining_budget_minor`, appends a `DraftEvent` (`WHAMMY_APPLIED`), and broadcasts `WHAMMY_APPLIED` to all connected clients for that draft. The `DraftEvent` and its row effects commit in the same transaction (EXTRACTED-002). In-memory state updates only after commit (EXTRACTED-004). The server never silently alters the commissioner's entered `amount_minor` (EXTRACTED-022).

*UI layer:* In the Commissioner Console, `screen-information-architecture.md §9.5` defines the Whammy panel with three states: trigger/status view, pending-approval view, and apply/reject view. In the Draft Room, a brief toast notification surfaces on `WHAMMY_APPLIED` events showing the affected team and amount, then auto-dismisses, consistent with the toast taxonomy in `screen-information-architecture.md` (Whammy event is an explicit toast trigger; bids are not).

*Auto-trigger layer (added from post-launch gap review):* `data-model.md §18.2` already defines `WhammyDefinition` with `trigger_rule_json` and `weight` columns, but the existing manual-trigger implementation (`server/src/draft/whammy.ts`) never reads `WhammyDefinition` at all — the commissioner types a raw `amount_minor`/`description` directly into `POST /drafts/:id/whammy`. This module adds the automatic side of `state-machine-flows.md §16`'s Whammy Flow diagram, whose entry step is "Configured trigger occurs" leading into "Whammy enabled and limits permit?" then "Select weighted eligible definition" — i.e. the same enabled/limits/approval/roster-completion gate the manual path already implements, just reached automatically instead of via commissioner POST. Per PRD §33, "trigger rule" and "probability/weight" are themselves configuration inputs, and the PRD does not name a fixed polling cadence (no "once per timer tick" language anywhere in the Whammy section); the only discrete, already-serialized draft event this module can ground the check in is pick resolution, since `WhammyEvent.trigger_event_sequence` (`data-model.md §18.3`) is a `DraftEvent` sequence number and pick resolution (`PLAYER_AWARDED`) is the nearest such event in the existing command flow. Concretely: within the same per-draft serialized command that resolves a pick (after that resolution's own transaction commits, still before the command queue admits the next command for that draft), the server loads that league's `active=true` `WhammyDefinition` rows, evaluates each one's `trigger_rule_json` (a probability/weight check) once, and if one or more are eligible, picks exactly one via weighted random selection using `WhammyDefinition.weight`. The selected definition then runs through the identical `enabled` / `max_per_team` / `max_per_draft` / sign (`allow_positive`/`allow_negative`) / roster-completion-invariant / `commissioner_approval_required` gate that manual triggers already use, and — on success — calls the same `applyWhammy` function, producing the same `WhammyEvent` row shape, the same `BudgetLedgerEntry`, the same `DraftEvent(WHAMMY_APPLIED)`, and the same `broadcast(draft.id, { type: 'WHAMMY_APPLIED', payload: {...} })` call already used by the manual path — no new event type, no new broadcast channel, so MOD-002/MOD-008's client-side `WHAMMY_APPLIED` listener requires zero changes to pick up auto-triggered events. For a `WhammyDefinition` with a nonzero `budget_delta_minor` (a budget-affecting Whammy), the target team is the team just awarded the player in that pick resolution (the only team the trigger event names); a `WhammyDefinition` with no budget delta (a message-only/offline-action Whammy per PRD §33) applies with `team_id = null`, matching `WhammyEvent.team_id`'s nullability in `data-model.md §18.3`. Because `WhammyDefinition` previously had no API surface, this module also adds commissioner CRUD endpoints (Commissioner Setup, alongside the existing `WhammyConfiguration` panel) so `trigger_rule_json`, `weight`, `type`, `budget_delta_minor`, `display_message`, `offline_action_text`, and `active` can actually be set — see `## API Contracts`.

**Behavioral expectations:**

- Given `WhammyConfiguration.enabled = false` for the league, when `POST /drafts/:id/whammy` is called, then the server rejects with a typed error (code, message JSON) and no `WhammyEvent` row or ledger entry is created.
- Given `WhammyConfiguration.max_per_team` is set and the target team already has that many `WhammyEvent` rows with `status=APPLIED` in this draft, when `POST /drafts/:id/whammy` targets that team, then the server rejects and no ledger entry is created.
- Given `WhammyConfiguration.max_per_draft` is set and the draft has reached that count of applied Whammies, when `POST /drafts/:id/whammy` is called, then the server rejects.
- Given `WhammyConfiguration.allow_positive = false` and the request carries `amount_minor > 0`, when `POST /drafts/:id/whammy` is called, then the server rejects.
- Given `WhammyConfiguration.allow_negative = false` and the request carries `amount_minor < 0`, when `POST /drafts/:id/whammy` is called, then the server rejects.
- Given a `amount_minor` (negative) that would reduce `DraftTeamState.remaining_budget_minor` below the minimum required to legally complete the team's remaining roster spots (`max_legal_bid` invariant from `data-model.md §21`), when `POST /drafts/:id/whammy` is called without an explicit commissioner override, then the server rejects with a clear reason; this preserves auction correctness per EXTRACTED-046 and EXTRACTED-037.
- Given `WhammyConfiguration.commissioner_approval_required = true`, when `POST /drafts/:id/whammy` is called and passes all constraint checks, then a `WhammyEvent` row with `status=PENDING_APPROVAL` is created, no `BudgetLedgerEntry` is appended, no `WHAMMY_APPLIED` broadcast is sent, and the Commissioner Console Whammy panel transitions to the pending-approval state.
- Given a `WhammyEvent` in `status=PENDING_APPROVAL`, when the commissioner rejects it, then the `WhammyEvent.status` is set to `REJECTED`, no budget effect is applied, and the panel returns to trigger/status state.
- Given a `WhammyEvent` in `status=PENDING_APPROVAL`, when the commissioner approves it, then the approval path runs the same roster-completion invariant check, appends the `BudgetLedgerEntry` (entry_type=WHAMMY, reference_id=WhammyEvent.id), updates `DraftTeamState.remaining_budget_minor`, appends `DraftEvent WHAMMY_APPLIED`, sets `WhammyEvent.status=APPLIED`, and broadcasts `WHAMMY_APPLIED` to all clients — all in one transaction.
- Given `WhammyConfiguration.commissioner_approval_required = false`, when `POST /drafts/:id/whammy` passes all checks, then the full apply flow runs in a single transaction: `WhammyEvent (status=APPLIED)` + `BudgetLedgerEntry` + `DraftEvent` commit together, `DraftTeamState.remaining_budget_minor` is updated in memory only after commit, and `WHAMMY_APPLIED` is broadcast only after commit.
- Given a `WHAMMY_APPLIED` broadcast, then every connected client for that draft receives the payload `{team_id, amount_minor, description, new_remaining_budget_minor}` verbatim from the API schema.
- Given a non-commissioner JWT, when `POST /drafts/:id/whammy` is called, then the server returns a 403 and no Whammy state is written.
- Given `DraftTeamState.remaining_budget_minor` is updated by a Whammy, then it equals the team's initial budget minus the sum of all active `BudgetLedgerEntry` debits for that team in that draft (per `data-model.md §21` invariant); verify with a ledger-reconciliation assertion in tests.
- Given a rollback (MOD-005) undoes picks past the `trigger_event_sequence` of a `WhammyEvent`, then the associated `BudgetLedgerEntry` is reversed by the generic rollback logic (a compensating entry, `entry_type=ROLLBACK_COMPENSATION`); no Whammy-specific code is added to the rollback path; verify per EXTRACTED-014.
- Given the Commissioner Console is open with `WhammyConfiguration.enabled = true`, when the Whammy panel renders, then it shows team selector, `amount_minor` input (signed integer in cents), description input, and a fire button, matching the trigger/status state from `screen-information-architecture.md §9.5`.
- Given a Whammy is applied while the Draft Room is open, when the `WHAMMY_APPLIED` WS event arrives, then a toast notification appears showing the affected team name and formatted amount, and auto-dismisses without blocking the bid UI.
- Given the env checker (established by MOD-000 in `config/env-check.cjs`) runs at boot, when `DATABASE_URL` or `JWT_SECRET` is absent, then the process exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable; this module adds no new environment variables beyond those already registered.
- Given one or more `active=true` `WhammyDefinition` rows exist for a league with `WhammyConfiguration.enabled = true`, when a pick resolves for a draft in that league, then, within the same per-draft serialized command (after the resolution transaction commits), the server evaluates each definition's `trigger_rule_json` exactly once; no evaluation happens on nomination, bid, or timer-tick events.
- Given no `WhammyDefinition` rows exist for a league, or none are `active`, when a pick resolves, then auto-trigger evaluation is a no-op — no `WhammyEvent` is created — and `POST /drafts/:id/whammy` (manual trigger) continues to work exactly as before.
- Given more than one `WhammyDefinition`'s `trigger_rule_json` evaluates to eligible for the same pick resolution, when the server selects which one fires, then it picks exactly one via weighted random selection over `WhammyDefinition.weight`, per the "Select weighted eligible definition" step in `state-machine-flows.md §16`.
- Given a `WhammyDefinition` becomes eligible and fires, then it passes through the same `enabled`, `allow_positive`/`allow_negative`, `max_per_team`, `max_per_draft`, and roster-completion-invariant checks the manual trigger path already enforces, using the definition's own `type`/`budget_delta_minor`; if any check fails, no `WhammyEvent` is created and no budget or broadcast effect occurs (fails silently to the draft, consistent with Whammy being optional/entertainment per EXTRACTED-046).
- Given `WhammyConfiguration.commissioner_approval_required = true` and an eligible `WhammyDefinition` fires, then a `WhammyEvent(status=PENDING_APPROVAL, definition_id=<that definition>)` is created with no budget effect and no broadcast yet, and the existing `approveWhammy`/`rejectWhammy` endpoints apply/reject it exactly as they do for a manually-triggered `WhammyEvent` — no new approval endpoint is added for auto-triggered events.
- Given `WhammyConfiguration.commissioner_approval_required = false` and an eligible `WhammyDefinition` fires, then `applyWhammy` runs in one transaction (`WhammyEvent(status=APPLIED, definition_id=<that definition>)` + `BudgetLedgerEntry` + `DraftEvent(WHAMMY_APPLIED)`), and after commit the server broadcasts `WHAMMY_APPLIED` with the same `{team_id, amount_minor, description, new_remaining_budget_minor}` payload shape used by manual triggers — verify with a test asserting a MOD-002/MOD-008-style WS listener receives an indistinguishable event for an auto-triggered vs. a manually-triggered Whammy.
- Given a `WhammyDefinition` with `budget_delta_minor` set (a budget-affecting type), when it auto-fires at pick resolution, then the target team is the team just awarded the player in that resolution; given a `WhammyDefinition` with no `budget_delta_minor` (message/offline-action only), when it auto-fires, then `WhammyEvent.team_id` is `null` and no `BudgetLedgerEntry` is created (mirrors "Budget delta? No -> No financial mutation" in `state-machine-flows.md §16`).
- Given a commissioner submits `POST /leagues/:id/whammy-definitions` with `name`, `type`, `budget_delta_minor`, `trigger_rule_json`, `weight`, `display_message`, and optionally `offline_action_text`, then a `WhammyDefinition` row is created scoped to that league's `WhammyConfiguration`; `GET /leagues/:id/whammy-definitions` lists them and `PATCH /leagues/:id/whammy-definitions/:definitionId` updates `trigger_rule_json`, `weight`, `display_message`, `offline_action_text`, or `active` (not `type`/`budget_delta_minor`, which are immutable once any `WhammyEvent` references the definition, to keep historical `WhammyEvent` rows meaningful).
- Given a non-commissioner JWT, when any of `POST`/`GET`/`PATCH /leagues/:id/whammy-definitions*` is called, then the server returns a 403 and no `WhammyDefinition` state is written or returned.

## Layers

- db
- api
- ui

## Dependencies

- F-MOD-002

## API Contracts

```yaml
produces:
  - operation_id: triggerWhammy
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: WhammyRequest
    response_schema: WhammyResponse

  - operation_id: WHAMMY_APPLIED
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: ~
    response_schema: |
      team_id: uuid
      amount_minor: integer
      description: string
      new_remaining_budget_minor: integer

  - operation_id: approveWhammy
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: "(none)"
    response_schema: WhammyResponse

  - operation_id: rejectWhammy
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: "(none)"
    response_schema: WhammyRejectResponse

  - operation_id: createWhammyDefinition
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: WhammyDefinitionRequest
    response_schema: WhammyDefinitionResponse

  - operation_id: listWhammyDefinitions
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: "(none)"
    response_schema: |
      definitions: WhammyDefinitionResponse[]

  - operation_id: updateWhammyDefinition
    schema_file: schema/MOD-009-api-schema.yaml
    request_schema: WhammyDefinitionUpdateRequest
    response_schema: WhammyDefinitionResponse
```

New/changed endpoints added by this gap-review scope (auto-trigger, `POST /leagues/:id/whammy-definitions`, `GET /leagues/:id/whammy-definitions`, `PATCH /leagues/:id/whammy-definitions/:definitionId`) must be added to `schema/MOD-009-api-schema.yaml` alongside the existing `triggerWhammy`/`approveWhammy`/`rejectWhammy` paths; the `WHAMMY_APPLIED` WS event schema is unchanged — auto-triggered Whammys reuse it verbatim.

## Required Env Variables

- DATABASE_URL — PostgreSQL connection string (read by Drizzle/postgres.js for all DB operations)
- JWT_SECRET — JWT signing key (read by @fastify/jwt preHandler to verify commissioner role on whammy endpoint)

## Lint Config

## Test Config

- command: DATABASE_URL=postgres://localhost/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-009_whammy.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-009_whammy.test.ts

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
