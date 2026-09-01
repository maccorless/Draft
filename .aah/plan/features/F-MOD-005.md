## Id

F-MOD-005

## Title

Commissioner Price Correction and Bounded Rollback

## Module Ref

MOD-005

## Description

This module implements the commissioner's post-award correction tools: in-place price correction (the only mutation allowed in place) and bounded rollback (all other outcome changes). It is built on top of the session and state foundation established in MOD-003.

**What it does, end to end:**

Price correction allows the commissioner to change the recorded price of any already-awarded pick without re-running the auction. The operation replays the acquiring team's BudgetLedgerEntry history forward from that pick through all later picks by the same team, confirming that no later pick would become illegal under the corrected budget. If the replay finds a violation, the request is rejected with HTTP 409 and no row is changed. If the replay succeeds, the existing Acquisition row's price is updated in place, the original BudgetLedgerEntry is superseded (active=false), a new CORRECTION-type BudgetLedgerEntry is appended, DraftTeamState.remaining_budget_minor is recalculated, and a PRICE_CORRECTED DraftEvent is appended — all in one transaction. A PRICE_CORRECTED WS broadcast follows commit. No winner, player, or roster slot changes are permitted by this path; those require rollback per CLAUDE.md constraint #10.

Rollback undoes the most recently resolved picks in strict reverse resolution_sequence order. Before accepting the request, the API enforces that the draft status is PAUSED (HTTP 409 otherwise). For each acquisition being reversed (from highest resolution_sequence to lowest), in one all-or-nothing transaction: the Acquisition row's active flag is set false, the RosterEntry row's active flag is set false, a ROLLBACK-type BudgetLedgerEntry (positive amount, reversing the debit) is appended, the PlayerAuction row is reset to status=PENDING with resolution_sequence cleared, and DraftTeamState.remaining_budget_minor and roster_filled_count are updated. After all picks are reversed, a ROLLBACK_APPLIED DraftEvent is appended and the transaction commits. A ROLLBACK_APPLIED WS broadcast follows. This transaction is atomic: any failure rolls the entire database operation back and returns an error — no partial state is possible.

Per CLAUDE.md constraint #10 and data-model.md §17.5: the rollback mechanism is bounded to last N picks; there is no jump-to-any-checkpoint. Per data-model.md §1 and architecture-overview.md §2: Acquisition, RosterEntry, and BudgetLedgerEntry rows are never deleted — compensating rows supersede. Per resolved-standards.yaml rule EXTRACTED-033: correction never erases history.

**Stack and structure:** Node.js 20 + Fastify 4.x backend in `server/src/draft/` (new `corrections.ts` handler), Drizzle ORM for schema column additions in `server/db/schema/`, React 18 + Vite 5 frontend panels inside `web/src/screens/commissioner/`. Shared Zod types for request/response shapes in `shared-types/src/schemas/`. See architecture-overview.md §7 for the full folder layout.

**Design references:**
- Entity schemas: `data-model.md` §3.3 (Acquisition, RosterEntry, BudgetLedgerEntry, PlayerAuction, DraftTeamState) and §3.4 (DraftEvent)
- Invariant checklist: `data-model.md §21` — particularly the constraint that `DraftTeamState.remaining_budget_minor` must equal initial budget minus the sum of all active BudgetLedgerEntry debits
- Rollback transaction sequence: `application-flow.md §9` (full Rollback Flow sequence diagram)
- Event type names: `knowledge/state-machine-flows.md §19` (PRICE_CORRECTED, ROLLBACK_STARTED, ROLLBACK_APPLIED, ACQUISITION_SUPERSEDED)
- PRD acceptance scenario: `knowledge/PRD.md §31` (corrections/rollback), `knowledge/PRD.md §44` (acceptance scenarios)
- API schema: `schema/MOD-005-api-schema.yaml` (correctPrice, rollbackPicks operations)

**UI screens (Commissioner Console additions):**

- **Correction panel** — pick selector (lists awarded picks with player name, team, current price), new-price integer input (minimum $1.00 = 100 minor), ledger preview showing the projected effect on the team's remaining budget, and a submit button. Displays a "Would make pick illegal" error inline when the server rejects with 409. On success, shows the new price and updated remaining budget.
- **Rollback panel** — count input (default 1), a preview listing which picks (player name, team, price) will be reversed (populated from the same data the server will use), a confirmation dialog ("Roll back these N picks?"), and a confirm button. The panel is disabled and shows "Pause the draft first" when Draft.status is not PAUSED. On success, lists the reversed picks.
- **Draft Board highlight** — corrected picks are visually distinguished (e.g., a "corrected" badge showing old and new price); rolled-back picks are shown as inactive/struck-through rather than removed.

**Behavioral expectations:**

- Given a commissioner sends POST /drafts/:id/corrections/price with a valid acquisition_id and new_price_minor, when the ledger replay for that team confirms no later pick becomes illegal, then: the Acquisition.price_minor is updated, the original BudgetLedgerEntry is set active=false, a new BudgetLedgerEntry with entry_type=CORRECTION is inserted, DraftTeamState.remaining_budget_minor is updated to reflect the delta, a PRICE_CORRECTED DraftEvent is appended, a PRICE_CORRECTED WS broadcast is sent to all connected clients, and the HTTP response includes old_price_minor, new_price_minor, team_id, and new_remaining_budget_minor — all in one committed transaction.

- Given a commissioner sends POST /drafts/:id/corrections/price, when the ledger replay determines that correcting the price would cause any later pick by the same team to exceed that team's budget, then: the server returns HTTP 409, no rows are modified, no DraftEvent is appended, and no WS broadcast is sent.

- Given a non-commissioner token (team owner or no role) sends POST /drafts/:id/corrections/price or POST /drafts/:id/rollback, then: the server rejects with HTTP 401/403 and no operation is performed.

- Given a commissioner sends POST /drafts/:id/rollback with count=N, when Draft.status is PAUSED, then: the N acquisitions with the highest resolution_sequence values (among active=true rows) are identified, and in one all-or-nothing transaction each has active set false, its associated RosterEntry rows set active=false, a BudgetLedgerEntry of entry_type=ROLLBACK with positive amount_minor equal to the original price is inserted, the PlayerAuction is reset to status=PENDING with resolution_sequence cleared, and DraftTeamState.remaining_budget_minor and roster_filled_count are updated for the acquiring team. On commit: a ROLLBACK_APPLIED DraftEvent is appended and a ROLLBACK_APPLIED WS broadcast is sent. The HTTP response contains rolled_back (count) and picks_reversed (array of acquisition_id, player_name, team_id, price_minor).

- Given a commissioner sends POST /drafts/:id/rollback, when Draft.status is not PAUSED (e.g., RUNNING), then: the server returns HTTP 409, the database is not modified, and no WS broadcast is sent.

- Given POST /drafts/:id/rollback is called with count=N and fewer than N active acquisitions exist, then: the server rolls back only the available picks and returns the actual rolled_back count in the response (or returns 409 if count=0 acquisitions are available, per schema minimum=1).

- Given any step of the rollback transaction fails (e.g., DB error mid-loop), then: the entire transaction is rolled back, no rows are partially modified, and the server returns an error response; in-memory DraftTeamState is not updated.

- Given a PRICE_CORRECTED or ROLLBACK_APPLIED WS broadcast is sent, then: all WebSocket sessions currently subscribed to that draft_id receive the broadcast; clients not connected to that draft are unaffected (per MOD-003 multi-draft isolation).

- Given the Commissioner Console Correction panel is rendered, then: the pick selector lists all active Acquisition rows for the draft, the new-price input accepts only integers >= 100 (minor units), the ledger preview computes the budget delta client-side from the entered value before submission, and the panel disables the submit button while a request is in flight.

- Given the Commissioner Console Rollback panel is rendered when Draft.status is not PAUSED, then: the confirm button is disabled and a "Pause the draft first" message is displayed; no rollback request is sent.

- Given the Commissioner Console Rollback panel is rendered when Draft.status is PAUSED, then: the pick preview lists the N picks that will be reversed (in reverse resolution_sequence order), a confirmation dialog must be acknowledged before submission, and the panel shows the reversed picks on success.

- Given the Draft Board renders after a successful price correction, then: the corrected pick displays both the original price (struck through or labelled "was") and the new price, plus a "corrected" indicator, and the team's remaining budget reflects the corrected value.

- Given the Draft Board renders after a successful rollback, then: the rolled-back picks are shown as inactive (e.g., struck-through or greyed out) rather than removed from the board, preserving the append-only history display.

- Given DATABASE_URL, JWT_SECRET, and NODE_ENV are required by the application, then: each name is listed in `.env.example` with a safe placeholder, and the startup env checker (config/env-check.cjs) validates all three at boot, failing with ERR_CDR_78_EX_CONFIG (naming every missing variable) before any module reads configuration.

## Layers

- db
- api
- ui

## Dependencies

- F-MOD-003

## API Contracts

```yaml
produces:
  - operation_id: correctPrice
    schema_file: schema/MOD-005-api-schema.yaml
    request_schema: PriceCorrectionRequest
    response_schema: PriceCorrectionResponse

  - operation_id: rollbackPicks
    schema_file: schema/MOD-005-api-schema.yaml
    request_schema: RollbackRequest
    response_schema: RollbackResponse
```

## Required Env Variables

- DATABASE_URL — PostgreSQL connection string
- JWT_SECRET — JWT signing key
- NODE_ENV — Runtime environment

## Lint Config

Before writing any application code, for each root below: create its manifest first, then run
`aah run core.scaffold.project ensure-lint-config --project-path "$PROJECT_DIR" --package-root <root> --install`
— it reads the manifest to pick the linter, writes the config, adds the linter to dev dependencies
and installs it, and never clobbers an existing config. Where a source path is given, copy that file
into the root first, then run the same command. Commit the configs with this module.

- server — default
- web — default

## Test Config

## Constraints
