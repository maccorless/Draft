# Architecture Review Board — Findings

## Review Summary
- Date: 2026-08-31
- Tier: mvp
- Cycle: 1
- Modules reviewed: 10 (MOD-000 through MOD-009)
- Documents reviewed: 7 (module-map.yaml, architecture-overview.md, data-model.md, application-flow.md, api-interface-contract.md, risk-security-compliance.md, 10 × MOD-NNN-api-schema.yaml)

---

## Findings

| # | Lens | Finding | Severity | Resolution Type |
|---|------|---------|----------|-----------------|
| F-001 | 1 — Module Demoability | MOD-000 demo criteria (health check only) does not exercise the auth and config layer it contains | MAJOR | design-level |
| F-002 | 2 — Doc-Module Consistency | MOD-000 vs MOD-001 boundary: league/team/config endpoints owned by MOD-000 in module-map but by MOD-001 in api-interface-contract and all schema files | MAJOR | design-level |
| F-003 | 2 — Doc-Module Consistency | MOD-001 URL patterns conflict across module-map, api-interface-contract, and schema | MAJOR | design-level |
| F-004 | 4 — Flow-Isolation Survival | Auto-Agent bid trigger uses PLAYER_AWARDED (auction-close event) instead of BID_ACCEPTED leadership-change event | MAJOR | decision-level |
| F-005 | 4 — Flow-Isolation Survival | application-flow §3 says auth_epoch is "re-read from in-memory state, refreshed from DB" — implies caching, contradicting the locked no-cache decision | MAJOR | decision-level |
| F-006 | 5 — Schema Completeness | DraftSummary declared in both MOD-001 and MOD-003 schemas with structurally different required fields | MAJOR | design-level |
| F-007 | 5 — Schema Completeness | ImportResult declared in both MOD-001 and MOD-007 schemas with structurally different property sets | MAJOR | design-level |
| F-008 | 5 — Schema Completeness | Widespread inline anonymous object shapes in components.schemas bodies across 8 of 10 schema files | MAJOR | design-level |
| F-009 | 3 — Data-Model Shared-Core | WhammyConfig entity defined in module-map MOD-009 but absent from data-model.md | MINOR | design-level |
| F-010 | 4 — Flow-Isolation Survival | Rollback broadcast event named ROLLBACK_COMPLETED in module-map but ROLLBACK_APPLIED in application-flow and api-interface-contract | MINOR | design-level |
| F-011 | 1 — Module Demoability | MOD-006 description claims coverage of "final auto-nomination on empty queue," logic owned and built in MOD-002 | MINOR | design-level |

---

## Detailed Findings

### Finding F-001: MOD-000 demo criteria does not cover its own auth and config layer

- **Lens:** 1 — Module Demoability
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-000 layers):**
  > `api: … POST /auth/site … POST /auth/league/:id … League CRUD (POST /leagues, GET /leagues/:id) … Team CRUD … RosterConfiguration + RosterSlotDefinition endpoints … AuctionConfiguration endpoints … Login endpoints … Draft creation endpoint`
- **Evidence (module-map.yaml, MOD-000 demo_criteria):**
  > `"Server boots, /health responds 200, tsc --noEmit passes, Vitest passes"`
- **Evidence (module-map.yaml, MOD-000 smoke_test):**
  > `"npm run build && curl http://localhost:3000/health"`
- **Contradiction:** The module contains a full auth flow (site login, league login, JWT issuance), league and team CRUD, and roster/auction configuration endpoints. The demo criteria and smoke test exercise only the health check. An implementer can pass the MOD-000 gate without ever building auth or config. MOD-001's demo (commissioner uploads a CSV to a frozen dataset) requires a working auth layer and league/team to already exist — both owned by MOD-000 — but MOD-000's gate never verifies them.
- **Recommended Action:** Extend MOD-000 demo_criteria and smoke_test to exercise the auth and config endpoints it contains. At minimum: POST /auth/site succeeds, POST /auth/league/:id returns a JWT, POST /leagues creates a league, and POST /leagues/:id/teams creates a team. Alternatively, split the auth/config endpoints out of MOD-000 into MOD-001's layer where the schema and api-interface-contract already place them (see F-002).

---

### Finding F-002: MOD-000 vs MOD-001 module boundary inconsistency

- **Lens:** 2 — Doc-Module Consistency
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-000 api layer):**
  > `League CRUD (POST /leagues, GET /leagues/:id) … Team CRUD (POST /leagues/:id/teams, GET /leagues/:id/teams) … RosterConfiguration + RosterSlotDefinition endpoints … AuctionConfiguration endpoints … Draft creation endpoint (POST /leagues/:id/drafts)`
- **Evidence (api-interface-contract.md §3.3, Commissioner Setup Screen):**
  > `Create league | REST POST | MOD-001 | createLeague → POST /leagues`
  > `Add teams | REST POST | MOD-001 | createTeam → POST /leagues/:id/teams`
  > `Configure roster slots | REST PUT | MOD-001 | setRosterConfig → PUT /leagues/:id/config/roster`
  > `Configure auction timers/budget | REST PUT | MOD-001 | setAuctionConfig → PUT /leagues/:id/config/auction`
  > `Create draft | REST POST | MOD-001 | createDraft → POST /leagues/:id/drafts`
- **Evidence (MOD-001-api-schema.yaml):** `operationId: createLeague`, `createTeam`, `setRosterConfig`, `setAuctionConfig`, `createDraft` are all defined in MOD-001's schema file. MOD-000-api-schema.yaml contains only: `getHealth`, `authSite`, `authLeague`.
- **Contradiction:** The module-map places these five capability groups in MOD-000. The api-interface-contract and all ten schema files place the same capabilities in MOD-001. An implementer of MOD-000 using the module-map would build league/team/config/draft creation in MOD-000; the schema and contract say these belong in MOD-001. This creates two possible implementations with different module boundaries.
- **Recommended Action:** Decide the canonical boundary. The schema and api-interface-contract are consistent with each other and represent the more specific, contract-level view. The simpler fix is to remove the league/team/config/draft-creation entries from MOD-000's api layer in module-map.yaml, leaving MOD-000 as auth + scaffold only. MOD-001 already claims these in its schema.

---

### Finding F-003: MOD-001 URL patterns conflict across three documents

- **Lens:** 2 — Doc-Module Consistency
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-001 api layer):**
  > `POST /leagues/:id/draft-dataset (multipart CSV upload; worker_threads parsing)`
  > `GET /draft-dataset/:id/ambiguities (list unresolved player matches)`
  > `POST /draft-dataset/:id/resolve-ambiguity (commissioner resolves one)`
  > `POST /draft-dataset/:id/freeze (validate all resolved; set FROZEN)`
- **Evidence (module-map.yaml, MOD-001 smoke_test):**
  > `POST /leagues/:id/draft-dataset (CSV upload) → GET /draft-dataset/:id (check status=VALIDATED) → POST /draft-dataset/:id/resolve-ambiguity → POST /draft-dataset/:id/freeze → GET /draft-dataset/:id (status=FROZEN)`
- **Evidence (MOD-001-api-schema.yaml, paths):**
  > `/leagues/{leagueId}/datasets` (POST → createDataset)
  > `/leagues/{leagueId}/datasets/{datasetId}/import/csv` (POST → importDatasetCsv)
  > `/leagues/{leagueId}/datasets/{datasetId}/freeze` (POST → freezeDataset)
- **Evidence (api-interface-contract.md §3.3):**
  > `importDatasetCsv → POST /leagues/:id/datasets/:id/import/csv`
  > `freezeDataset → POST /leagues/:id/datasets/:id/freeze`
- **Contradiction:** The module-map uses a flat `/draft-dataset/` resource with a combined create+import endpoint. The schema and contract use a nested `/datasets/{datasetId}/import/csv` structure with separate create and import endpoints. The smoke_test references `GET /draft-dataset/:id` (a status endpoint) which doesn't exist in the schema. The ambiguity resolution endpoints (`GET /draft-dataset/:id/ambiguities`, `POST /draft-dataset/:id/resolve-ambiguity`) appear in the module-map but not in the schema at all. MOD-001's demo criteria requires ambiguity resolution ("sees matched and ambiguous players, resolves ambiguities") but the schema provides no endpoint for it.
- **Recommended Action:** Align module-map api layer to the schema URL patterns. Add ambiguity resolution endpoints (`GET /datasets/:id/ambiguities`, `POST /datasets/:id/resolve-ambiguity`) to MOD-001-api-schema.yaml if the feature is in scope, or remove the ambiguity resolution language from the demo criteria and description.

---

### Finding F-004: Auto-Agent bid trigger uses PLAYER_AWARDED instead of BID_ACCEPTED

- **Lens:** 4 — Flow-Isolation Survival
- **Severity:** MAJOR
- **Resolution Type:** decision-level
- **Evidence (module-map.yaml, MOD-004 api layer):**
  > `Auto-Agent bidding: on NOMINATION_STARTED and on PLAYER_AWARDED (leadership change) → if below ceiling → BID_ABSOLUTE at max legal up to willingness ceiling`
- **Evidence (application-flow.md §8 Auto-Agent Flow, flowchart):**
  > `TRIGGER → BID_ACCEPTED new leader → CHECK (Am I the leader?) → leader != me + below ceiling → BID`
- **Evidence (CLAUDE.md constraint #7):**
  > `Its bidding cadence triggers on auction open and on every leadership change while below its willingness ceiling — not just "reacts to losing leadership," which would never fire for an agent that's never led`
- **Contradiction:** PLAYER_AWARDED is the event that fires when a PlayerAuction transitions to status=AWARDED, meaning the auction is already closed and no further bids are accepted. Annotating PLAYER_AWARDED as "(leadership change)" is incorrect: there is no open auction after PLAYER_AWARDED. Leadership changes within an open auction are signaled by BID_ACCEPTED events carrying a new leading_team_id. If the Auto-Agent triggers on PLAYER_AWARDED, it enqueues BID_ABSOLUTE commands against an already-AWARDED PlayerAuction, which will be rejected with ERR_AUCTION_NOT_OPEN on every bid. The agent would never outbid a rival. The application-flow.md correctly identifies BID_ACCEPTED as the trigger; the module-map is wrong.
- **Recommended Action:** Reopen the `auto-agent-bid-trigger` decision (or file a new gray-area entry) and correct module-map MOD-004 api layer to: "on NOMINATION_STARTED and on BID_ACCEPTED where new leading_team_id != this team's team_id → if below ceiling → BID_ABSOLUTE." This matches application-flow §8, CLAUDE.md constraint #7, and the state machine design.

---

### Finding F-005: application-flow implies auth_epoch in-memory caching

- **Lens:** 4 — Flow-Isolation Survival
- **Severity:** MAJOR
- **Resolution Type:** decision-level
- **Evidence (application-flow.md §3 Bid Command Flow, step 3):**
  > `CMD->>CMD: auth_epoch check (re-read from in-memory state, refreshed from DB)`
- **Evidence (risk-security-compliance.md §2.2):**
  > `auth_epoch must NOT be cached in-memory between commands. It is always re-read.`
- **Evidence (decision-registry.yaml, slug jwt-signing):**
  > `auth_epoch re-check on every command implemented as a preHandler hook that calls request.jwtVerify() then reads auth_epoch from DB`
- **Evidence (CLAUDE.md constraint #12):**
  > `this is the only revocation mechanism, so it must actually be checked on every command, not just at login`
- **Contradiction:** The application-flow phrase "re-read from in-memory state, refreshed from DB" allows an interpretation where auth_epoch is cached in-memory and only periodically refreshed from the DB — the opposite of the locked decision. If an implementer follows the flow diagram literally and caches auth_epoch in the in-memory DraftState (which is kept hot for performance), a revoked token could continue to operate until the next cache refresh event. The security model's token revocation guarantee is violated.
- **Recommended Action:** Rewrite the application-flow §3 step to: `CMD->>DB: SELECT auth_epoch for league/team (re-read unconditionally; never from cache)`. This is a design-level doc fix that makes the diagram unambiguous. The locked decision (jwt-signing, decision-registry) is correct; the diagram text must match it.

---

### Finding F-006: DraftSummary schema drifts between MOD-001 and MOD-003

- **Lens:** 5 — Schema Completeness
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence (MOD-001-api-schema.yaml, components.schemas.DraftSummary):**
  ```yaml
  DraftSummary:
    type: object
    required: [id, status]
    properties:
      id: { type: string, format: uuid }
      status: { type: string, enum: [CREATED, RUNNING, PAUSED, COMPLETE] }
  ```
- **Evidence (MOD-003-api-schema.yaml, components.schemas.DraftSummary):**
  ```yaml
  DraftSummary:
    type: object
    required: [id, status, league_id]
    properties:
      id: { type: string, format: uuid }
      league_id: { type: string, format: uuid }
      status: { type: string, enum: [CREATED, RUNNING, PAUSED, COMPLETE] }
      started_at: { type: string, format: date-time }
      completed_at: { type: string, format: date-time }
  ```
- **Contradiction:** The same schema name is declared in two files with different required fields and different property sets. MOD-001's DraftSummary is missing league_id, started_at, and completed_at. A shared-types package derived from both files would produce a type conflict or silently use whichever is compiled last. The createDraft response (MOD-001) returns a minimal DraftSummary; listDrafts (MOD-003) returns a richer one — these should be distinct named types or one canonical type with all fields optional where appropriate.
- **Recommended Action:** Rename the MOD-001 response to `CreateDraftResponse` (or use a minimal inline schema), and establish MOD-003's fuller DraftSummary as the canonical named type used everywhere. Alternatively, define a single canonical DraftSummary in a shared schema location with all fields and apply it consistently.

---

### Finding F-007: ImportResult schema drifts between MOD-001 and MOD-007

- **Lens:** 5 — Schema Completeness
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence (MOD-001-api-schema.yaml, components.schemas.ImportResult):**
  ```yaml
  ImportResult:
    type: object
    required: [rows_imported, errors]
    properties:
      rows_imported: { type: integer }
      errors: { type: array, items: { ... } }
  ```
- **Evidence (MOD-007-api-schema.yaml, components.schemas.ImportResult):**
  ```yaml
  ImportResult:
    type: object
    required: [rows_imported, errors]
    properties:
      rows_imported: { type: integer }
      source: { type: string, enum: [CSV, EXCEL, ESPN_PDF, FANTASYPROS] }
      errors: { type: array, items: { ... } }
  ```
- **Contradiction:** MOD-007's ImportResult adds a `source` field not present in MOD-001. Both files declare the same type name. MOD-007 depends on MOD-001 (both are adapter flows into the same normalization pipeline), so implementations using both modules will encounter conflicting type definitions. The `source` field is relevant to all import operations (including the CSV adapter in MOD-001), making the omission from MOD-001 an incomplete definition rather than an intentional subset.
- **Recommended Action:** Consolidate ImportResult into a single definition in MOD-001 (the base adapter module) with the `source` field included as optional or required. MOD-007 schemas should reference it (or both should reference a shared definition).

---

### Finding F-008: Inline anonymous shapes in components.schemas bodies

- **Lens:** 5 — Schema Completeness
- **Severity:** MAJOR
- **Resolution Type:** design-level
- **Evidence:** The following schema files define anonymous inline objects within components.schemas property values instead of using `$ref` into named component schemas:

  - **MOD-000** `SiteAuthResponse.leagues.items`: anonymous `{id: uuid, name: string}` — should be `$ref: "#/components/schemas/LeagueBrief"`
  - **MOD-001** `RosterConfigRequest.slots.items`: anonymous object with `{position, priority, is_starter, slot_count}` — should be `$ref: "#/components/schemas/RosterSlotConfigItem"`
  - **MOD-001** `ImportResult.errors.items`: anonymous `{row: integer, message: string}` — should be `$ref: "#/components/schemas/ImportError"`
  - **MOD-003** `DraftStateSnapshot.teams.items`: anonymous `{team_id, remaining_budget_minor, roster_filled_count, control_mode}` — should be `$ref: "#/components/schemas/TeamStateEntry"`
  - **MOD-003** `DraftStateSnapshot.current_auction`: anonymous inline object — should be `$ref: "#/components/schemas/ActiveAuctionState"`
  - **MOD-005** `RollbackResponse.picks_reversed.items`: anonymous `{acquisition_id, player_name, team_id, price_minor}` — should be `$ref: "#/components/schemas/ReversedPick"`
  - **MOD-006** `DraftSummaryReport.teams.items`: anonymous object with nested `acquisitions` array of anonymous objects — requires two new named schemas
  - **MOD-007** `ImportResult.errors.items`: same anonymous pattern as MOD-001
  - **MOD-008** `TargetValueList.values.items`, `SetTargetValuesRequest.values.items`, `WatchListResponse.items.items`, `NominationQueueResponse.items.items`: four anonymous inline objects across four schemas

- **Contradiction:** The review rule requires all response and request bodies in components.schemas to use `$ref` into named schemas. Anonymous inline shapes prevent code generators and validators from producing named types, making the schema harder to consume from shared-types and creating undiscoverable type aliases.
- **Recommended Action:** Extract all anonymous inline object definitions into named entries in each file's `components.schemas` section and replace the inline definition with `$ref`.

---

### Finding F-009: WhammyConfig entity absent from data-model

- **Lens:** 3 — Data-Model Shared-Core
- **Severity:** MINOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-009 db layer):**
  > `WhammyConfig (per-league: enabled, max_amount_minor, allowed_event_types)`
- **Evidence (data-model.md §3.1 through §3.5):** No WhammyConfig entity appears in any entity schema section. The ERD does not show WhammyConfig. The BudgetLedgerEntry entry_type=WHAMMY is present, but the configuration entity governing when/how Whammies fire is not modeled.
- **Contradiction:** The module-map introduces an entity not defined in the data model. Implementers have no canonical field list, constraints, or ownership context for WhammyConfig beyond what the module-map mentions. The `allowed_event_types` field is particularly underspecified.
- **Recommended Action:** Add WhammyConfig to data-model.md §3.1 (League & Configuration) with full field schema: id, league_id FK, enabled bool, max_amount_minor int, allowed_event_types (clarify what this enum is). Add to ERD: `League ||--o| WhammyConfig`.

---

### Finding F-010: Rollback broadcast event name inconsistency

- **Lens:** 4 — Flow-Isolation Survival
- **Severity:** MINOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-005 api layer):**
  > `WS broadcast: PRICE_CORRECTED, ROLLBACK_COMPLETED events`
- **Evidence (application-flow.md §9 Rollback Flow):**
  > `API->>BCAST: ROLLBACK_APPLIED {picks_reversed: [player_ids]}`
- **Evidence (api-interface-contract.md §3.5 Draft Room):**
  > `Receive rollback | WS receive | MOD-005 | ROLLBACK_APPLIED`
- **Contradiction:** The module-map names the event ROLLBACK_COMPLETED; the application-flow and api-interface-contract both name it ROLLBACK_APPLIED. No schema WS event block in MOD-005 acts as tiebreaker (MOD-005-api-schema.yaml has no x-websocket-events section). ROLLBACK_APPLIED appears in two documents vs one, but the schema gap means there is no canonical definition.
- **Recommended Action:** Pick one name (ROLLBACK_APPLIED is used in two documents and matches event-naming convention for past-tense applied events), update module-map to match, and add an x-websocket-events section to MOD-005-api-schema.yaml documenting ROLLBACK_APPLIED and PRICE_CORRECTED with their payloads.

---

### Finding F-011: MOD-006 claims auto-nomination behavior owned by MOD-002

- **Lens:** 1 — Module Demoability
- **Severity:** MINOR
- **Resolution Type:** design-level
- **Evidence (module-map.yaml, MOD-006 description):**
  > `Also covers Nominator Match (one-per-draft tie-at-current-price right) and final auto-nomination on empty queue.`
- **Evidence (module-map.yaml, MOD-002 api layer):**
  > `Auto-nominate: on empty queue + timer expiry → argmax(aav_minor) from frozen dataset`
- **Contradiction:** Auto-nomination on an empty queue is built and owned by MOD-002's api layer. MOD-006's description says it "covers" this behavior, implying MOD-006 is responsible for delivering it. Since MOD-006 depends transitively on MOD-002, the auto-nomination capability exists when MOD-006 is demoed, but the attribution creates the false expectation that MOD-006 implements it.
- **Recommended Action:** Remove "and final auto-nomination on empty queue" from MOD-006's description. If the MOD-006 demo needs to exercise auto-nomination, note it as a dependency on MOD-002's existing behavior rather than claiming ownership.

---

## Verdict

**Board Verdict: Rework-Required**

Eight MAJOR findings were identified. Under verdict rules, 2+ MAJOR findings require rework. The highest-priority items to resolve before planning can proceed:

1. **F-004** (Auto-Agent trigger — decision-level): The wrong bid trigger event makes the Auto-Agent non-functional as designed. Requires reopening the decision.
2. **F-005** (auth_epoch caching — decision-level): The diagram language contradicts the revocation security model. Requires doc fix to eliminate ambiguity.
3. **F-002 / F-003** (module boundary and URL drift): The module-map's MOD-000/MOD-001 boundary and URL patterns conflict with the schema and api-interface-contract on every league/team/dataset endpoint. Requires choosing one canonical definition and aligning all documents.
4. **F-006 / F-007 / F-008** (schema completeness): Schema files cannot safely be used to generate shared-types until DraftSummary drift, ImportResult drift, and anonymous shapes are resolved.

The two design-level decision conflicts (F-004, F-005) require user-level resolution before the skill patches docs. All other findings are patchable inline by the calling skill.
