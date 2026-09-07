---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: Complete remaining feature backlog (post-AAH)"
created: 2026-09-06
---

# feat: Complete remaining feature backlog (post-AAH)

**Target repo:** current repo (fantasy-football auction draft platform — `server/`, `web/`, `shared-types/`)

## Product Contract preservation

No upstream unified plan or brainstorm exists for this work. Scope comes directly from six already-written, already-detailed rework feature spec files under `.aah/plan/features/` (each with a full `## Description` and `## Api Contracts`, produced by the now-abandoned AAH framework). Those spec files are treated here as the origin document: this plan carries forward every behavioral expectation they define, sequences the six features against each other, and right-sizes each into TDD-ready implementation units. It does not invent new product behavior.

---

## Summary

Six features remain to close out the build backlog before the project moves into the testing/bug-fix phase the user asked for next. All six already have implementation-ready specs (`.aah/plan/features/F-MOD-0{08,09,10,12,13,14}-rework-01.md`); this plan sequences them by real dependency, not spec-file order, and breaks each into TDD-sized units.

**Delivery order:** F-MOD-010 → F-MOD-009 → F-MOD-012 → F-MOD-014 → F-MOD-008 → F-MOD-013. Rationale in Key Technical Decisions below.

---

## Problem Frame

The project has 31/38 tracked features done, regression suite green (451/451 as of the last recorded run), but 6 features are not yet built:

- F-MOD-008-rework-01 — Owner Strategy Tools and War Room Screen
- F-MOD-009-rework-01 — Commissioner Whammy: Budget Entertainment Events (auto-trigger)
- F-MOD-010-rework-01 — Commissioner League Setup and Readiness Checklist
- F-MOD-012-rework-01 — Commissioner Corrections, Rollback, and Whammy UI
- F-MOD-013-rework-01 — Draft Summary Report Routing and Metrics
- F-MOD-014-rework-01 — Pre-Draft Lobby Restyle and Prep Tools

Two of these (F-MOD-010, F-MOD-014) also carry post-launch gap-review fixes for real bugs found by hands-on testing (see `todo.md` §0), most notably a stored-value budget corruption bug (constraint violation: CLAUDE.md #5, money must be exact integer minor units) and dead-code UI (Ambiguity Resolution, Teams management) that already has a working backend half-built.

**Non-goals for this plan:** the three other `todo.md` direct-testing bugs not owned by these six features (fixed header overlap, 403 on `/leagues/:id/players`) and the broader UI/UX design-system pass are explicitly deferred — see Scope Boundaries.

---

## Key Technical Decisions

**KTD1 — Delivery order is dependency-driven, not spec-file order.**
- F-MOD-010-rework-01 first: it fixes a live, confirmed core-invariant bug (stored budget value corruption, CLAUDE.md #5) that other in-progress manual testing keeps tripping over, and it is the only one of the six with no dependency on another undone feature.
- F-MOD-009-rework-01 second: extends `WhammyConfiguration`/`WhammyDefinition`/`WhammyEvent`, which F-MOD-010's Whammy config form and F-MOD-012's Whammy panel both touch or consume.
- F-MOD-012-rework-01 third: its Whammy panel wires to F-MOD-009's trigger/approve/reject endpoints; its rollback preview already has its dependency (F-MOD-005-rework-01's dry-run preview endpoint, commit `1a98422`) satisfied.
- F-MOD-014-rework-01 fourth: builds the Do Not Draft backend (table + 3 endpoints) that F-MOD-008 consumes for its War Room "Do Not Draft" tab. Also fully independent of 009/012/010 otherwise (its DB migration, Lobby restyle, and login restyle touch none of their tables).
- F-MOD-008-rework-01 fifth: consumes F-MOD-014's Do Not Draft endpoints (`## Api Contracts` `consumes` block cites `schema/MOD-014-api-schema.yaml` directly) — must follow it.
- F-MOD-013-rework-01 last: fully independent of the other five (its only dependency, F-MOD-006-rework-01's ESPN transfer + SendGrid rework, already shipped per commit `4755a1b`). Lowest coupling, safest to land whenever slack appears; sequenced last only because nothing else needs it first.

**KTD2 — F-MOD-010's budget bug gets a root-cause investigation unit before any fix is written.**
The spec itself (see its item 3) says the obvious dollars→minor-units conversion code is *already correct* in both the League Setup save/read path and the config PUT/GET handlers — meaning the actual defect is somewhere else (candidates named in the spec: `server/src/auction/routes.ts`'s draft-start handler, which currently ignores `teams.starting_budget_override_minor` entirely, or a stale write from an earlier bug/migration/seed run). This plan does not assume a fix; U1's first unit is a reproduction-and-trace step, matching the project's Debugging convention (root CLAUDE.md: show exact log output, exact line, and why the theory explains all symptoms before proposing a fix).

**KTD3 — Every unit reuses the existing per-team auth + per-draft serialized-queue pattern; no new auth or concurrency model is introduced.**
All five backend-touching features add endpoints under the same JWT `preHandler` + `auth_epoch`-reread + `team_id`/`league_id` cross-check pattern already established by `server/src/draft/strategy.ts` (MOD-008) and `server/src/auction/auto-agent-routes.ts` (MOD-004), and the same per-draft `AsyncQueue` serialization already used for all other mutating draft commands (CLAUDE.md constraints #4, #11, #12). No unit invents a new authorization or concurrency mechanism.

**KTD4 — Whammy auto-trigger evaluation point is pick resolution, not a timer tick (per spec, not a plan invention).**
F-MOD-009's auto-trigger fires once per `PLAYER_AWARDED` resolution, inside the same serialized command, after that resolution's transaction commits and before the queue admits the next command. This is carried forward from the spec verbatim (it already justifies this against PRD §33's silence on cadence) — flagged here only because it constrains U-unit sequencing (the auto-trigger check cannot run in a separate async job).

---

## Scope Boundaries

**In scope:** the six features listed above, exactly as specified in their `.aah/plan/features/*.md` files, including each feature's own post-launch gap-review additions (they are integral to the spec, not separate work).

**Deferred to Follow-Up Work** (explicitly out of this plan — separate from the testing/bug-fix pass the user says comes next):
- `todo.md` §0's fixed-header-overlap bug and the `/leagues/:id/players` 403-for-Owner bug — neither is owned by any of these six features.
- The general UI/UX design-system pass `todo.md` §8 flags as needing its own sprint.
- Any feature not in the six above (all other tracked features are already `done`).

---

## Requirements Traceability

Each unit below cites its owning feature spec file's title and the specific behavioral-expectation bullets it implements; the spec files are the requirements source (no separate R-ID scheme is introduced — the specs already read as Given/When/Then acceptance criteria, and this plan does not duplicate that text, it points to it by feature ID + section).

---

## Implementation Units

### F-MOD-010-rework-01 — Commissioner League Setup and Readiness Checklist

### U1. Root-cause the starting-budget corruption bug
**Goal:** Determine why every team's starting budget renders as a garbled value (e.g. `200250` instead of `200`) before writing any fix.
**Requirements:** F-MOD-010-rework-01 Description item 3; behavioral expectations "Given the commissioner saves a starting budget of $200... all three display exactly $200."
**Dependencies:** none.
**Files:** `web/src/screens/commissioner/LeagueSetup.tsx` (`submitAuctionConfig` ~L380, `refreshAuctionConfig` ~L250), `server/src/league/routes.ts` (`PUT`/`GET /leagues/:id/config/auction`), `server/src/auction/routes.ts` (draft-start handler ~L151).
**Approach:**
1. Reproduce against a fresh save cycle: enter a budget in League Setup, save, and trace the exact value written to `auction_configurations.initial_budget_minor` via a direct DB read (not through any UI formatter).
2. If the write path is confirmed correct (as the spec's own reading of the code suggests), check whether already-stored rows are simply bad (leftover from a previously-fixed bug, a migration default, or a stale seed) — if so, this is a one-time data-correction problem, not a code-fix problem.
3. Independently confirm the draft-start handler bug named in the spec: it currently applies `cfg.initial_budget_minor` to every team's `draft_team_states.remaining_budget_minor` uniformly, ignoring `teams.starting_budget_override_minor` — this is a real bug regardless of what U1 step 1-2 find, and must be fixed in the same unit since it's the same code path this bug's root-cause hunt is auditing.
**Execution note:** This is a debugging unit — do not write a fix commit until the exact write path producing the bad value is identified and reproduced with a concrete before/after value.
**Test scenarios:**
- Reproduction: save $200 via League Setup, read `auction_configurations.initial_budget_minor` directly from Postgres, assert it equals `20000` (integer cents).
- Draft-start seeding: team with `starting_budget_override_minor` set seeds `remaining_budget_minor` from the override at draft start; team without an override seeds from `initial_budget_minor`.
- Regression: an already-corrupted row (simulated) is corrected by whatever one-time correction path U1 determines necessary (data-fix migration or admin script) — verify the corrected value, not just the new-write path.
**Verification:** A team's budget shown in Draft Room, War Room, and Draft Control all read $200 for a $200 save, confirmed against the DB value, not a display patch.

### U2. League identity, status message, and schedule
**Goal:** `PUT /leagues/:id` extended for name/logo/name-lock/status_message/scheduled_draft_start_at; migration for the four new `leagues` columns plus `teams.starting_budget_override_minor`.
**Requirements:** F-MOD-010-rework-01 behavioral expectations for migration, league identity form, status message, scheduled start time.
**Dependencies:** none.
**Files:** `server/db/schema/index.ts` (new columns), new Drizzle migration, `server/src/league/routes.ts` (`PUT /leagues/:id`), `shared-types/src/schemas/league.ts` (`UpdateLeagueRequest`), `web/src/screens/commissioner/LeagueSetup.tsx` (identity form, status message field, schedule picker), `server/src/__tests__/F-MOD-010_league-setup.test.ts`.
**Test scenarios:**
- `PUT /leagues/:id` with a valid commissioner JWT updates name/logo/name_lock and returns the updated summary.
- Same call without a JWT, or with a non-commissioner JWT, is rejected.
- `status_message` set → persists and reads back; never set → reads back `null` and Pre-Draft Lobby (F-MOD-014) renders nothing for that section (cross-checked in F-MOD-014's own tests, not duplicated here).
- `scheduled_draft_start_at` set/cleared round-trips; unset reads render "Not yet scheduled" wherever consumed.
**Verification:** Migration applies cleanly against the existing dev DB; `PUT /leagues/:id` covers all five new fields.

### U3. Host password + HOST login role
**Goal:** `leagues.host_password_hash` column, password-generation endpoint extended to the host scope, and a `role: 'HOST'` branch on the existing league login endpoint.
**Requirements:** F-MOD-010-rework-01 behavioral expectations for host password generation and HOST JWT issuance/restriction.
**Dependencies:** U2 (same migration).
**Files:** `server/src/auth/routes.ts` (`POST /auth/league/:id`, `LeagueAuthRequestSchema`), `server/src/league/routes.ts` (`POST /leagues/:id/passwords/generate`), `server/src/__tests__/F-MOD-010_host-auth.test.ts`.
**Approach:** Mirror the existing bcrypt work-factor-12 convention already used for `commissioner_password_hash`/`team_password_hash`; bump `auth_epoch` on generate, exactly as the existing commissioner/team password generation already does.
**Test scenarios:**
- `host_password_hash` set + correct password → JWT with `role: 'HOST'`, league `id`, no `team_id`.
- `host_password_hash` unset → HOST login rejected (not accepted against a null/empty comparison).
- HOST token accepted by a presentation-only endpoint, rejected (403) by a commissioner-mutation endpoint.
- `POST /leagues/:id/passwords/generate` for host/commissioner/team: random generation returns plaintext once, stores only the hash, bumps `auth_epoch`; explicit custom password supplied → stores exactly that value.
**Verification:** A generated host password can log in as HOST and is rejected everywhere a commissioner action is attempted.

### U4. Team roster table extensions + Teams CRUD
**Goal:** `PUT /leagues/:id/teams/:teamId` (budget override, name-lock, draft-order), `DELETE /leagues/:leagueId/teams/:teamId`, and the "Teams" nav section wired to real UI instead of `ComingSoon`.
**Requirements:** F-MOD-010-rework-01 gap-review item 1 and its behavioral expectations (Add/Remove Team, no dead Teams nav).
**Dependencies:** U2.
**Files:** `server/src/league/routes.ts` (new `PUT`/`DELETE` team endpoints), `web/src/screens/commissioner/LeagueSetup.tsx` (roster table additions), `web/src/screens/commissioner/index.tsx` (`teams` nav section), `server/src/__tests__/F-MOD-010_teams-crud.test.ts`.
**Test scenarios:**
- `PUT .../teams/:teamId` with `starting_budget_override_minor` (or `null` to clear) persists; effective budget shown is override-or-fallback.
- `name_lock` toggle persists and is readable by other modules.
- `draft_order` reorder persists and is the value MOD-002's nomination rotation reads (no separate display-only field).
- `DELETE .../teams/:teamId` succeeds while the league's draft is `CREATED` or has none; returns 409 once the draft has left `CREATED`.
- "Teams" nav renders the same team list as League Setup's table (no duplicate UI), with Add/Remove wired to the above endpoints.
**Verification:** Adding a team via "Add Team" makes it immediately editable via the existing per-team fields; removing a team removes it from both views and updates the readiness checklist's team-count row.

### U5. Ambiguity Resolution wiring
**Goal:** Make the already-built `AmbiguityResolution.tsx` component reachable: structured `ambiguous_rows` from `upsertRows`, a resolve endpoint, and `App.tsx` wiring.
**Requirements:** F-MOD-010-rework-01 gap-review item 2 and its behavioral expectations.
**Dependencies:** none (independent of U1-U4).
**Files:** `server/src/player/routes.ts` (`upsertRows`, import endpoints' response shape), `shared-types/src/schemas/league.ts` (`ImportResultSchema` + new `AmbiguousRowSchema`/`PlayerCandidateSchema`), new `POST /leagues/:leagueId/datasets/:datasetId/ambiguities/resolve`, `web/src/App.tsx` (`CommissionerRoute` state + `onResolveAmbiguity`), `server/src/__tests__/F-MOD-010_ambiguity-resolution.test.ts`.
**Test scenarios:**
- A CSV import row matching multiple existing players returns `ambiguous_rows: [{row_number, raw_name, raw_position, candidates}]` alongside `errors`, instead of only a string error.
- `POST .../ambiguities/resolve` with `{row_number: player_id}` creates the `playerAavSources` link; with `{row_number: 'skip'}` discards the row.
- `App.tsx` stores `ambiguous_rows` from the last import, passes to `CommissionerConsole`, and `AmbiguityResolution` renders when non-empty (previously unreachable — assert it now mounts).
- Resolving a row clears it from `ambiguousRows` state so only pending rows remain.
**Verification:** A dataset import with a genuine name collision (two players sharing a raw name/position) surfaces in the UI and is resolvable end-to-end.

### U6. Whammy config write endpoint + form, AAV source dropdowns, readiness checklist
**Goal:** `PUT /leagues/:id/config/whammy`, the Whammy configuration form, AAV Primary/Secondary dropdowns (wired to existing MOD-016 endpoint), and `GET /leagues/:id/readiness`.
**Requirements:** F-MOD-010-rework-01 behavioral expectations for Whammy config, AAV dropdowns, and readiness checklist rows.
**Dependencies:** U2 (league row), none on F-MOD-009 (writes the existing `WhammyConfiguration` row shape; does not require F-MOD-009's new tables).
**Files:** `server/src/league/routes.ts` (`PUT /leagues/:id/config/whammy`, `GET /leagues/:id/readiness`), `web/src/screens/commissioner/LeagueSetup.tsx` (Whammy form, AAV dropdowns, readiness checklist), `server/src/__tests__/F-MOD-010_whammy-config-readiness.test.ts`.
**Test scenarios:**
- `PUT /leagues/:id/config/whammy` upserts the league's single `WhammyConfig` row; a subsequent `POST /drafts/:id/whammy` immediately validates against the new constraints.
- AAV dropdowns populate from the loaded dataset's sources; render disabled when none loaded.
- `GET /leagues/:id/readiness` returns one deterministic PASS/FAIL row per PRD §41 item (team count, roster config, budget feasibility, unresolved ambiguous rows, dataset frozen, AAV source selection, timers, Auto-Agent defaults, team media, Whammy config) — every row PASS when every prerequisite is met.
**Verification:** Toggling any one readiness prerequisite off flips exactly that row to FAIL, not others.

---

### F-MOD-009-rework-01 — Commissioner Whammy: Budget Entertainment Events

### U7. Schema + manual-trigger definition support
**Goal:** `WhammyConfiguration`/`WhammyDefinition`/`WhammyEvent` tables (or their extension, if U6 confirms some already exist), `entry_type=WHAMMY` on `BudgetLedgerEntry`, `WHAMMY_APPLIED` on `DraftEvent`.
**Requirements:** F-MOD-009-rework-01 Description "Database layer"; behavioral expectations for config-gated rejection (disabled, max-per-team, max-per-draft, sign, roster-completion invariant).
**Dependencies:** F-MOD-010 U6 (writes to the same `WhammyConfiguration` row shape — confirm no migration conflict before writing this unit's migration).
**Files:** `server/db/schema/index.ts`, new Drizzle migration, `server/src/draft/whammy.ts`, `server/src/__tests__/F-MOD-009_whammy-config.test.ts`.
**Test scenarios:** all of F-MOD-009-rework-01's first nine behavioral-expectation bullets (disabled → reject with no row/ledger entry; max-per-team/max-per-draft exceeded → reject; sign disallowed → reject; roster-completion-invariant violation → reject without override; approval-required → `PENDING_APPROVAL` with no ledger entry/broadcast; approve → full apply in one transaction; reject → `REJECTED`, no budget effect; approval not required → full apply in one transaction; broadcast payload shape).
**Verification:** Ledger-reconciliation assertion — `remaining_budget_minor` equals initial budget minus the sum of all active ledger debits, after any Whammy path.

### U8. Rollback interaction (no new code, verification only)
**Goal:** Confirm a rollback past a `WhammyEvent`'s `trigger_event_sequence` reverses it via the *generic* rollback/compensation path with no Whammy-specific logic.
**Requirements:** behavioral expectation "no Whammy-specific code is added to the rollback path... per EXTRACTED-014."
**Dependencies:** U7.
**Files:** `server/src/__tests__/F-MOD-009_whammy-rollback.test.ts` (test-only; exercises existing MOD-005 rollback against a Whammy-bearing draft state).
**Test scenarios:** Apply a Whammy, then roll back past its sequence; assert a compensating `ROLLBACK_COMPENSATION` ledger entry reverses it and no Whammy-aware code path was needed.
**Verification:** Test passes against the existing generic rollback implementation with zero production-code changes in this unit.

### U9. Whammy definitions CRUD
**Goal:** `POST/GET/PUT /leagues/:id/whammy-definitions*`.
**Requirements:** F-MOD-009-rework-01 behavioral expectations for definition CRUD and commissioner-only gating.
**Dependencies:** U7.
**Files:** `server/src/league/routes.ts` or `server/src/draft/whammy.ts` (definitions CRUD), `server/src/__tests__/F-MOD-009_whammy-definitions.test.ts`.
**Test scenarios:** create/list/update a definition with full field set; non-commissioner JWT → 403 on all three verbs, no state written.
**Verification:** A created definition is immediately eligible for auto-trigger evaluation (feeds U10).

### U10. Auto-trigger evaluation at pick resolution
**Goal:** Weighted-random eligible-definition selection inside the same serialized command as pick resolution, reusing `applyWhammy` verbatim.
**Requirements:** F-MOD-009-rework-01's auto-trigger behavioral expectations (evaluation timing, weighted selection, identical gating, null-team for message-only definitions, identical broadcast shape).
**Dependencies:** U9.
**Files:** `server/src/auction/engine.ts` (pick-resolution command, post-commit hook), `server/src/draft/whammy.ts` (evaluation entry point), `server/src/__tests__/F-MOD-009_whammy-autotrigger.test.ts`.
**Approach:**
1. After a pick-resolution transaction commits, before the per-draft queue admits the next command, load `active=true` `WhammyDefinition` rows for the league.
2. Evaluate each `trigger_rule_json` once; if ≥1 eligible, weighted-random-select exactly one via `weight`.
3. Run the selected definition through the identical `enabled`/sign/`max_per_team`/`max_per_draft`/roster-completion-invariant/`commissioner_approval_required` gate U7 already implements, targeting the team just awarded the player (or `team_id=null` for a zero-`budget_delta_minor` definition).
**Test scenarios:**
- No active definitions → no-op, manual trigger still works unchanged.
- Multiple eligible definitions → exactly one selected, weighted by `weight` (statistical assertion over many trials, or a seeded-RNG determinism test).
- A definition failing any gate → no `WhammyEvent`, no budget/broadcast effect, draft continues normally.
- `commissioner_approval_required=true` → `PENDING_APPROVAL` via the same `approveWhammy`/`rejectWhammy` endpoints U7 built (no new approval endpoint).
- Auto-triggered vs. manually-triggered `WHAMMY_APPLIED` broadcasts are indistinguishable in shape to a WS listener.
**Verification:** A MOD-002/MOD-008-style WS listener test receives an auto-triggered event it cannot distinguish from a manual one.

---

### F-MOD-012-rework-01 — Commissioner Corrections, Rollback, and Whammy UI

### U11. Price correction + rollback UI
**Goal:** Replace `ComingSoon` in "Corrections & Rollback" with price-correction form and rollback panel wired to already-built backend endpoints.
**Requirements:** F-MOD-012-rework-01 behavioral expectations for price correction (client-computed preview, `POST .../corrections/price`, `409 CORRECTION_ILLEGAL` → "Roll back instead") and rollback (cost-statement preview, pause-before-submit, `409` handling, re-apply assist).
**Dependencies:** none new (MOD-005's rollback preview endpoint already shipped, commit `1a98422`).
**Files:** `web/src/screens/commissioner/Corrections.tsx` (new), `web/src/screens/commissioner/index.tsx` (nav wiring), `web/src/screens/commissioner/corrections.css`, `web/src/__tests__/F-MOD-012_corrections-rollback.test.tsx` (or project's existing frontend test convention).
**Test scenarios:** every bullet in F-MOD-012-rework-01's behavioral expectations from "Given the commissioner opens... Corrections & Rollback" through "the first (erroneous) pick's fields are editable before its re-award", plus the `409 DRAFT_NOT_PAUSED`/`NO_PICKS_TO_ROLLBACK` inline-rejection cases.
**Verification:** A price correction that would make a later pick illegal surfaces the exact refusal and offers rollback; a completed rollback shows the re-apply assist in original oldest-first order.

### U12. Detailed rollback preview (roster-slot + Whammy breakdown)
**Goal:** Extend the rollback preview UI to show, per reversed pick, the budget returned, the roster slot vacated, and any associated Whammy interaction unwound.
**Requirements:** F-MOD-012-rework-01 gap-review "Detailed rollback preview" section and its behavioral expectations, including the stale-preview re-fetch-on-`state_version`-mismatch requirement.
**Dependencies:** U11; MOD-005's preview response shape (already shipped) — confirm its exact fields before writing this unit, per the spec's own caveat that the shape must be checked, not assumed.
**Files:** `web/src/screens/commissioner/Corrections.tsx` (extend rollback preview), `web/src/__tests__/F-MOD-012_rollback-preview-detail.test.tsx`.
**Test scenarios:**
- Preview shows budget-returned and vacated-roster-slot per pick.
- A pick with an associated Whammy ledger entry shows the unwound amount/team; a pick without one omits that line (no `$0`/blank placeholder).
- `state_version` advances between preview fetch and confirm → UI re-fetches before confirming rather than submitting against a stale preview.
**Verification:** Triggering a Whammy then rolling back past it shows the Whammy line in the preview before confirming.

### U13. Whammy panel (trigger/approve/reject)
**Goal:** Trigger form + pending-approval list wired to `POST .../whammy`, `.../approve`, `.../reject`.
**Requirements:** F-MOD-012-rework-01 Whammy panel behavioral expectations, including all documented `409` codes and the `WHAMMY_NOT_PENDING` double-resolve race.
**Dependencies:** F-MOD-009 U7 (manual trigger/approve/reject endpoints).
**Files:** `web/src/screens/commissioner/Corrections.tsx` (Whammy panel section), `web/src/__tests__/F-MOD-012_whammy-panel.test.tsx`.
**Test scenarios:** immediate-apply vs. pending-approval branch on response shape; Approve/Reject remove from pending list; every documented 409 shown inline with no pending-list mutation except `WHAMMY_NOT_PENDING`, which does remove the entry.
**Verification:** A double-click race on Approve (simulated as two rapid calls) resolves once and the second shows `WHAMMY_NOT_PENDING` cleanly.

---

### F-MOD-014-rework-01 — Pre-Draft Lobby Restyle and Prep Tools

### U14. Do Not Draft backend
**Goal:** `do_not_draft_items` table + 3 REST endpoints + Auto-Agent exclusion wiring.
**Requirements:** F-MOD-014-rework-01 section (3) and its behavioral expectations, including the Auto-Agent-only restriction (manual bidding unaffected).
**Dependencies:** none.
**Files:** `server/db/schema/index.ts`, new migration, `server/src/draft/do-not-draft.ts` (new, mirrors `server/src/draft/strategy.ts`'s auth pattern), `server/src/auction/auto-agent.ts` (`triggerAutoAgentBidsOnNomination`, `triggerAutoAgentBidsOnLeaderChange`), `server/src/__tests__/F-MOD-014_do-not-draft.test.ts`.
**Test scenarios:**
- Add/list/remove round-trip on `(draft_id, team_id, player_id)`.
- `token.team_id != :teamId` → 403, no read/write; `token.league_id != draft.league_id` → 403.
- A team with a Do Not Draft entry in `AUTO_AGENT` mode is excluded from bid candidates for that player in both `triggerAutoAgentBidsOnNomination` and `...OnLeaderChange`; a team without the entry is unaffected.
- Same team in `MANUAL` mode can still manually bid on that player.
**Verification:** An Auto-Agent-controlled team never bids on its own Do Not Draft players across a full simulated auction; a manual owner can.

### U15. SiteLogin/LeagueLogin restyle
**Goal:** Replace inline `styles` object usage with token-driven CSS classes; zero behavior change.
**Requirements:** F-MOD-014-rework-01 section (1) and its behavioral expectations (429 handling, wrong-password message, success path unchanged).
**Dependencies:** none.
**Files:** `web/src/App.tsx` (`SiteLogin`, `LeagueLogin`), new `web/src/screens/auth/auth.css`, `web/src/__tests__/F-MOD-014_login-restyle.test.tsx`.
**Execution note:** Behavior-preserving refactor — write a characterization test against current behavior before touching styles, per the project's legacy-code caution.
**Test scenarios:** no element uses `styles.*` after the change; 429 → "Too many attempts" still renders; wrong password → "Wrong site password" still renders; success → `onLeagues` still called with league list + password.
**Verification:** Existing auth flow (site password → league/role/team selection) works identically before/after, verified by the characterization test passing unchanged.

### U16. Pre-Draft Lobby: readiness message + prep-tool tabs
**Goal:** `lobby.css`, status-message section, and Watch List/Nomination Queue/Target Values/Auto-Agent tabs mirroring War Room's existing "My Preparation" pattern, plus a Do Not Draft tab (consumes U14) and the media upload control.
**Requirements:** F-MOD-014-rework-01 section (2) and its behavioral expectations.
**Dependencies:** U14 (Do Not Draft tab), F-MOD-010 U2 (`status_message` field).
**Files:** `web/src/screens/lobby/index.tsx`, new `web/src/screens/lobby/lobby.css`, `web/src/App.tsx` (thread `draftId` prop into `<Lobby>`), `web/src/__tests__/F-MOD-014_lobby-tabs.test.tsx`.
**Test scenarios:** `status_message` set → renders; null → renders nothing (no empty box); Watch List/Nomination Queue/Target Values tabs call the same MOD-008 endpoints War Room already uses, same response shapes; Auto-Agent tab calls `PUT .../auto-agent` with `willingness_pct` and round-trips; Do Not Draft tab empty state renders without error; media upload control calls MOD-015's existing endpoint without reimplementing upload logic; Lobby rendered with no `active` draft → prep tabs omitted/unavailable, no crash on missing `draftId`.
**Verification:** All five tabs function against a live dev-seeded league without any new backend calls beyond U14 and already-shipped MOD-008/MOD-004/MOD-015 endpoints.

### U17. Editable Target Values tab + Enter Draft Room link
**Goal:** Wire the Lobby's read-only Target Values tab to the existing `PUT .../target-values` endpoint; add a persistent "Enter Draft Room" link unconditioned on draft status.
**Requirements:** F-MOD-014-rework-01 sections (4) and (5) and their behavioral expectations.
**Dependencies:** U16.
**Files:** `web/src/screens/lobby/index.tsx`, `web/src/App.tsx` (`DraftGateway`), `web/src/__tests__/F-MOD-014_targets-and-entry.test.tsx`.
**Test scenarios:** set a target for a not-yet-targeted player → `PUT` called with updated `targets` array → `GET` reflects it; edit an existing target → `PUT` called with updated amount → `GET` reflects the new amount, not a duplicate row; "Enter Draft Room" link present for any `active` draft status (`CREATED`/`RUNNING`/`PAUSED`/`COMPLETE`), absent when no `active` draft.
**Verification:** An owner can set, edit, and see a target value round-trip entirely from the Lobby without visiting War Room.

---

### F-MOD-008-rework-01 — Owner Strategy Tools and War Room Screen

### U18. Strategy REST APIs (Target Values, Watch List, Nomination Queue)
**Goal:** Three Drizzle tables + five REST endpoints under `server/src/draft/strategy.ts`.
**Requirements:** F-MOD-008-rework-01 behavioral expectations for all five endpoints, including the "no My Target column when unset" (EXTRACTED-019) and never-broadcast-target-values rules.
**Dependencies:** none (F-MOD-014's Do Not Draft is separate; Watch List/Nomination Queue/Target Values are this feature's own new tables).
**Files:** `server/db/schema/index.ts`, new migration, `server/src/draft/strategy.ts`, `server/src/__tests__/F-MOD-008_strategy-api.test.ts`.
**Test scenarios:** every bullet in F-MOD-008-rework-01's first nine behavioral expectations (team-scoped reads/writes, 403 on team-id mismatch, Watch List never auto-nominates, Nomination Queue ordering, auto-nominate-on-timer-expiry data supply, target values never in any WS broadcast).
**Verification:** A `target_value_minor` set for one team never appears in a WS capture for any other team's session.

### U19. War Room screen core
**Goal:** Second-screen view: live bid display, budget tracker, historical awards, player tiers, over the existing WS connection (no new handshake).
**Requirements:** F-MOD-008-rework-01 behavioral expectations for War Room rendering and the <200ms update-lag target.
**Dependencies:** U18 (strategy panel data feeds the same screen).
**Files:** `web/src/screens/war-room/index.tsx`, `web/src/screens/war-room/war-room.css`, `web/src/__tests__/F-MOD-008_war-room-core.test.tsx`.
**Test scenarios:** second tab with same JWT joins the existing `Set<ws>` for the team; `BID_ACCEPTED`/`PLAYER_AWARDED` updates render within one cycle; initial render shows all four required zones (active auction, budget tracker, awarded-players history, player tiers).
**Verification:** Manual/dev-server timing check confirms the <200ms broadcast-to-UI lag target on a local network (matches architecture-overview.md §2).

### U20. Draft Room strategy sidebar
**Goal:** `StrategyPanel.tsx` rendering Target Values/Watch List/Nomination Queue against U18's endpoints, with drag-to-reorder.
**Requirements:** F-MOD-008-rework-01 strategy-panel behavioral expectations.
**Dependencies:** U18.
**Files:** `web/src/screens/draft-room/StrategyPanel.tsx`, `web/src/__tests__/F-MOD-008_strategy-panel.test.tsx`.
**Test scenarios:** parallel fetch on load; empty list → empty state with add affordance, not an error; no target set for a visible player → no "My Target" cell for that row; reorder → `reorderNominationQueue` called with new `ordered_player_ids`.
**Verification:** Panel renders correctly with zero data (new team, no targets/watchlist/queue yet).

### U21. War Room gap-review enrichments
**Goal:** Do Not Draft tab (consumes F-MOD-014 U14), Market Context AAV-baseline + remaining-by-tier, Recent Activity `unique_bidder_count`/`aav_diff_minor`, Player Intelligence prior-season stats, Comparable Remaining Proj/My Target columns, Watch List AAV/customized-flag/status columns, Nomination Queue opening-price/availability columns, Targets tab all-players toggle, Roster/Budget Grid position-focus highlighting, Whammy toast, anti-snipe penalty indicator.
**Requirements:** F-MOD-008-rework-01's full "Post-launch gap-review additions" section, one bullet per sub-feature listed there.
**Dependencies:** U18, U19, U20; F-MOD-014 U14 (Do Not Draft tab); F-MOD-009 U10 (Whammy toast fires only once MOD-002's rework broadcasts it — the spec explicitly treats this as additive/non-blocking, not a hard dependency: "if no such event is ever received, then no toast ever renders and nothing else in the screen is affected").
**Files:** `web/src/screens/war-room/index.tsx`, `server/src/draft/war-room.ts` (extend `GET /drafts/:draftId/activity` response fields, document `GET /drafts/:draftId/config`), `web/src/__tests__/F-MOD-008_war-room-enrichments.test.ts`.
**Approach:** Every sub-bullet here is additive to already-fetched client state (per the spec's own repeated "no new endpoint required" framing) except the two `war-room.ts` response-field additions (`unique_bidder_count`, `aav_diff_minor`) and documenting the already-implemented `getDraftConfig` operation. Implement and test each sub-bullet as its own small commit within this unit rather than one giant diff.
**Test scenarios:** one scenario per sub-bullet as specified in the source spec (e.g. zero awarded players → AAV-baseline comparison shows $0/0%, not NaN; zero competing bids beyond opener → `unique_bidder_count = 1` not `0`; null `prior_season_stats` → block omitted entirely; "All tracked players" toggle → unset target shows blank cell not `$0`).
**Verification:** Each sub-bullet's own Given/When/Then in the spec passes as written; no sub-bullet blocks another (per the spec's explicit non-blocking framing for the Whammy toast and anti-snipe indicator).

---

### F-MOD-013-rework-01 — Draft Summary Report Routing and Metrics

### U22. Draft-complete routing
**Goal:** `/draft-complete` route; navigate-away-on-`COMPLETE` from Draft Room/War Room; `DraftGateway` routes a `COMPLETE` draft directly to the report instead of the Lobby.
**Requirements:** F-MOD-013-rework-01 "Routing behavior to build" and its first three behavioral expectations.
**Dependencies:** none.
**Files:** `web/src/App.tsx` (new route, `DraftGateway`), `web/src/screens/draft-room/index.tsx`, `web/src/screens/war-room/index.tsx`, `web/src/__tests__/F-MOD-013_routing.test.tsx`.
**Test scenarios:** connected client on Draft Room/War Room receiving `DRAFT_COMPLETE` navigates to `/draft-complete?draftId=...`; fresh auth or reconnect against an already-`COMPLETE` draft routes there directly, never to `/lobby`/`/draft-room`/`/war-room`; `/draft-complete` fetches its own report data on mount (no reliance on in-memory state from a prior screen).
**Verification:** The old inline "Draft complete." dead-end text no longer appears anywhere in the client.

### U23. Evaluation metrics
**Goal:** `projected_starter_points`, `roster_depth_score`, `aav_efficiency_pct` added to `GET /drafts/:draftId/report`'s per-team entries.
**Requirements:** F-MOD-013-rework-01 "Metrics to add" and its metric-specific behavioral expectations.
**Dependencies:** none.
**Files:** `server/src/draft/reports.ts` (`generateReport()`), `server/src/__tests__/F-MOD-013_metrics.test.ts`.
**Test scenarios:** bench-slot player excluded from `projected_starter_points` sum; `roster_depth_score` carries a distinguishable formula-version identifier; `aav_efficiency_pct` computed against frozen-dataset `aav_minor`, labeled only as "AAV efficiency" (never skill/fair-value/recommendation language, per CLAUDE.md #6); existing `DRAFT_NOT_COMPLETE` 409 unchanged.
**Verification:** A hand-computed expected value for each metric on a small fixture roster matches the endpoint's response exactly.

### U24. Owner/League summary view split
**Goal:** Split `DraftComplete`'s flat standings into Owner view and League summary view, each independently downloadable by any owner.
**Requirements:** F-MOD-013-rework-01 "UI split" and its behavioral expectations.
**Dependencies:** U22, U23.
**Files:** `web/src/screens/draft-complete/index.tsx`, `web/src/__tests__/F-MOD-013_view-split.test.tsx`.
**Test scenarios:** any owner (not just commissioner) sees Owner view showing only their own picks/spend/budget/metrics; League summary view shows all teams' spend/completion/metrics + league-wide spend vs. AAV; download action available on both views for any owner; existing commissioner-only "Export worksheet"/"Send summary email" unaffected by the split.
**Verification:** A non-commissioner owner's session can download both views; a commissioner's existing export/email buttons still render and function.

### U25. Guided ESPN transfer flow UI
**Goal:** Multi-step commissioner-only flow consuming F-MOD-006-rework-01's already-shipped team-mapping, mark-player-transfer-confirmed, and canonical-JSON-export endpoints.
**Requirements:** F-MOD-013-rework-01 "Guided ESPN roster transfer flow to build" and its behavioral expectations.
**Dependencies:** U22 (route exists); F-MOD-006-rework-01 endpoints (already shipped — commit `4755a1b`, confirm exact response shapes before wiring, per this spec's own caution about "check the exact preview endpoint/response shape... rather than assuming a shape," which applies equally here to F-MOD-006's endpoints).
**Files:** `web/src/screens/draft-complete/EspnTransferFlow.tsx` (new), `web/src/__tests__/F-MOD-013_espn-transfer.test.tsx`.
**Test scenarios:** ambiguous/unresolved team mapping surfaced before entry-order proceeds for that team; a checked reconciliation control persists via the confirm endpoint and survives page reload; canonical JSON export available alongside existing CSV/worksheet downloads, neither altered.
**Verification:** A full walkthrough (map teams → step through entry order → confirm players → reach reconciled state) completes without the app ever treating the guided flow as a second source of truth for winning prices.

### U26. Working email report status
**Goal:** "Send summary email" reflects the real SendGrid outcome (success/failure) instead of always showing accepted.
**Requirements:** F-MOD-013-rework-01 "Working email report to build" and its behavioral expectation.
**Dependencies:** F-MOD-006-rework-01's SendGrid wiring (already shipped).
**Files:** `web/src/screens/draft-complete/index.tsx`, `web/src/__tests__/F-MOD-013_email-status.test.tsx`.
**Test scenarios:** send succeeds → real confirmation shown; send fails → distinct error state shown; rest of `/draft-complete` (both views, existing downloads) remains usable regardless of email outcome.
**Verification:** A simulated SendGrid failure leaves the report screen otherwise fully functional.

---

## Verification Contract

- Every unit's test file runs green via `npm test` (no orchestrator wrapper — see CLAUDE.md's current Delivery Workflow section).
- `npm run typecheck` passes after every unit (per root CLAUDE.md: run the type checker after every code change).
- No unit introduces mocks in test code (project convention carried forward from the prior framework's NO-MOCKS rule — functional tests against the real running system remain the standard even though the framework enforcing it is gone).
- Full regression suite (`npm test`, whole workspace) run once after each feature (not each unit) completes, to catch cross-feature regressions before starting the next feature in the KTD1 sequence.
- Money-handling units (U1, U6, U7, U9, U10, U23) additionally verify via direct DB reads, not just API responses, per the project's existing "money is exact integer minor units" invariant (CLAUDE.md #5).

## Definition of Done

All 26 units above implemented, their own test scenarios passing, `npm run typecheck` clean, full regression suite green, and `.aah/feature-list.json`'s six `planned`/`in_progress` entries for these modules updated to reflect completion (informational only — no longer a protected/gated file per the current CLAUDE.md).

---

## Completion Status (2026-09-06)

Executed as a `/goal` run. Before writing any code, a repo audit (`npm test` on the untouched tree) found the codebase already far more complete than this plan assumed: 481/483 tests passing, with dedicated test files already existing for all six target features. Each unit below was individually verified against actual repo state rather than assumed unbuilt; where a unit's premise turned out already-satisfied, that is recorded as **Already implemented (pre-session)**, verified by reading the code and its passing tests before moving on — not simply assumed.

**F-MOD-010** (U1-U6)
- **U1** — Root-caused and fixed. `server/src/auction/routes.ts`'s draft-start handler seeded every team from the league-wide `initial_budget_minor`, ignoring `teams.starting_budget_override_minor` entirely — the real remaining half of the reported bug. New test: `F-MOD-010_budget_seeding.test.ts`.
- **U2, U3, U6** — Already implemented (pre-session): league identity/status/schedule, host password + HOST login, Whammy config write + readiness checklist. Verified via `F-MOD-010_league_setup.test.ts`'s pre-existing passing coverage.
- **U4** — Built. `DELETE /leagues/:leagueId/teams/:teamId` (409-gated on draft status) + Add/Remove Team UI in `LeagueSetup.tsx`. Tests added to `F-MOD-010_league_setup.test.ts` (server) and its `.tsx` counterpart.
- **U5** — Built. `upsertRows` now returns structured `ambiguous_rows`; new `POST /leagues/:id/datasets/:id/ambiguities/resolve`; `App.tsx`'s `CommissionerRoute` now actually supplies `ambiguousRows`/`onResolveAmbiguity` (previously always empty — dead code). Tests: `F-MOD-001_dataset.test.ts` (3 new), `F-MOD-010_ambiguity_wiring.test.tsx` (new file).

**F-MOD-009** (U7-U10)
- **U7** — Manual trigger/approve/reject already implemented (pre-session). Schema (WhammyDefinition table, nullable `whammy_events.team_id`, `definition_id`/`trigger_event_sequence` columns) newly added this session — migration `0010_whammy_definitions.sql`.
- **U8** — **Scope correction, not a no-op.** The plan assumed generic rollback reversal of Whammy ledger entries already existed; it did not — `corrections.ts`'s rollback handler only ever refunded the acquisition's own award price. Fixed: rollback now reverses any `APPLIED` Whammy whose triggering event sequence is at or after the earliest rolled-back pick (compensating `ROLLBACK` ledger entry, budget adjustment, status → `REVERSED`). Tests added to `F-MOD-005_corrections.test.ts` (reversal case + earlier-Whammy-untouched boundary case).
- **U9, U10** — Built. Definitions CRUD + auto-trigger-at-pick-resolution (weighted random selection over eligible `WhammyDefinition` rows, same gating as manual triggers, message-only null-team path). New test file `F-MOD-009-rework-01_whammy_autotrigger.test.ts` (5 tests) plus regression coverage in the base `F-MOD-009_whammy.test.ts`.

**F-MOD-012** (U11-U13)
- **U11, U13** — Already implemented (pre-session): price correction + rollback UI base, Whammy panel. Verified via `F-MOD-012_corrections.test.tsx`'s pre-existing coverage.
- **U12** — Built. Wired the client-computed preview over to F-MOD-005-rework-01's real `GET /drafts/:draftId/rollback/preview` (budget returned, roster slot vacated, Whammy interactions, `state_version` staleness re-check before confirming). `F-MOD-012_corrections.test.tsx` extended with 3 new tests; 6 existing tests updated for the now-async preview fetch.

**F-MOD-014** (U14-U17)
- **U14, U15, U16** — Already implemented (pre-session): Do Not Draft backend, login restyle, Lobby prep-tool tabs. Verified via existing passing test files.
- **U17** — Built. Editable Target Values tab (`TargetRow`/`TargetPicker` components, wired to the existing `PUT .../target-values` endpoint) + persistent "Enter Draft Room" link in `DraftGateway`. New test file `F-MOD-014_enter_draft_room_link.test.tsx`; `F-MOD-014_lobby.test.tsx` extended with 2 new tests (one existing test's assertion updated for the input-based rendering).

**F-MOD-008** (U18-U21)
- **U18, U19, U20** — Already implemented (pre-session): Strategy REST APIs, War Room core, Draft Room strategy sidebar (inline, not a separate `StrategyPanel.tsx` file — functionally equivalent).
- **U21** — Built, all sub-items: Do Not Draft tab, Market Context AAV-baseline + remaining-by-tier, Recent Activity `unique_bidder_count`/`aav_diff_minor` (new `war-room.ts` query fields, with a caught bug — initial join used a nonexistent `player_auctions.dataset_id` column, fixed before landing), prior-season stats, Comparable Remaining Proj/My Target columns, Watch List AAV/target-flag/status, Nomination Queue opening-price/availability, Targets all-players toggle, Whammy toast, Roster/Budget Grid position-focus highlighting. New test file `F-MOD-008-rework-01_war_room_enrichments.test.tsx` (9 tests); server test `F-MOD-010_war_room.test.ts` extended with `unique_bidder_count`/`aav_diff_minor` assertions.

**F-MOD-013** (U22-U26)
- **U22, U23, U24** — Already implemented (pre-session): draft-complete routing, evaluation metrics, Owner/League view split.
- **U25** — Built. Guided ESPN transfer flow (`EspnTransferFlow.tsx`: team mapping with ambiguity gating, per-player reconciliation confirm surviving reload, canonical JSON export download) wired to F-MOD-006-rework-01's already-shipped endpoints. New test file `F-MOD-013-rework-01_espn_transfer_flow.test.tsx` (4 tests).
- **U26** — Built. `POST /drafts/:draftId/report/email` now returns `failed_count`; the UI distinguishes real send success from partial/total failure instead of always showing success. Test assertions added to `F-MOD-006-rework-01_transfer_and_email.test.ts`; 4 new tests in `F-MOD-013_draft_complete_component.test.tsx`.

**Verification cadence actually run:** `npm run typecheck` (both workspaces) after every unit touched; targeted `npx vitest run <file>` after every change before moving to the next; one full `npm test` regression run after each of the six features in dependency order (F-MOD-010 → F-MOD-009 → F-MOD-012 → F-MOD-014 → F-MOD-008 → F-MOD-013), each 524/524 green (one run needed a single retry — the F-MOD-010 pass hit one of the known WS-timing flakes documented below, clean on immediate re-run).

**Two additional pre-existing defects fixed for a literal 100%-green suite** (initially left as "pre-existing, unrelated" — revisited and fixed rather than left as accepted exceptions):
- `F-MOD-000_env-check.test.ts` and `F-MOD-007_data_adapters.test.ts` each had one test asserting the env-checker exits 0 given only `DATABASE_URL`/`JWT_SECRET`/`NODE_ENV` — stale since F-MOD-006-rework-01 added `SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL` to `env-check.cjs`'s required list without updating these two tests. Fixed by adding the two SendGrid vars to each test's payload.
- `identity_switch_url_reset.test.tsx` failed `npm run typecheck` (a `vi.fn()` mock not cast to `typeof fetch`, unlike every other test file in the suite). Fixed with the same `as unknown as typeof fetch` cast already used everywhere else.

Both `npm run typecheck` (all three workspaces) and `npm test` are now clean with zero exceptions: 54/54 files, 524/524 tests, no typecheck errors anywhere.

**Two real regressions caught and fixed before landing (not just theoretical risk — both reproduced and root-caused):**
1. The whammy-definitions migration hadn't been applied to the `draft_test` database vitest actually uses (only to the dev DB) — surfaced as silent 500s / missing-column errors in the base `F-MOD-009_whammy.test.ts` suite; fixed by running the migration against `draft_test`.
2. `war-room.ts`'s new activity-endpoint AAV join referenced a nonexistent `player_auctions.dataset_id` column, caught via a reproducible 500 in `F-MOD-010_war_room.test.ts` before it could land.

**Pre-existing flakiness explicitly ruled out as a regression source:** several WS-timing-dependent tests (`F-MOD-002_auction.test.ts`, `F-MOD-010_war_room.test.ts`, `F-MOD-017_close_card_and_popover.test.ts`) intermittently failed under full-suite sequential load throughout this session. Each was verified via `git stash` (reverting all session changes) to fail at the same rate on the untouched baseline — confirmed environmental/timing fragility in this sandbox, not a regression introduced by this work.
