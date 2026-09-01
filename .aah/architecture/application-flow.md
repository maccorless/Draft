# Application Flow

**Project:** Draft — Fantasy Football Auction Platform
**Date:** 2026-08-31
**Tier:** mvp
**Scope:** Global (one per project)

---

## 1. Overview

The system has three primary runtime flows:

1. **Auth flow** — site password → league → team/commissioner token
2. **Auction command flow** — bid, nomination, resolution (the hot path; p99 < 200ms target)
3. **Dataset import flow** — CSV/Excel/PDF parsed off-thread into a versioned frozen dataset

All mutating commands for a draft route through that draft's per-draft serialized AsyncQueue. No command is broadcast before its DB transaction commits.

---

## 2. Authentication Flow

Three-tier password model. No account creation; passwords are pre-configured by the commissioner.

```mermaid
sequenceDiagram
    autonumber
    participant C as "Client (Browser)"
    participant API as Fastify API
    participant DB as PostgreSQL

    C->>API: POST /auth/site (site_password)
    API->>DB: SELECT league WHERE site_password_hash matches
    DB-->>API: League row (id, auth_epoch)
    API-->>C: 200 {league_id, league_name} (no token yet)

    C->>API: POST /auth/league/:id (role, password)
    note over API: role = COMMISSIONER or OWNER (team_id required for OWNER)
    API->>DB: SELECT league/team row, auth_epoch
    DB-->>API: password_hash, current auth_epoch
    API->>API: bcrypt.verify(password, hash)
    API->>API: sign JWT {league_id, team_id, role, auth_epoch}
    API-->>C: 200 {token, expires_in: 48h}

    note over C,DB: Every subsequent command
    C->>API: WS CONNECT + authenticate {token}
    API->>DB: SELECT auth_epoch for league/team
    DB-->>API: current auth_epoch
    API->>API: verify JWT and compare payload.auth_epoch == DB row
    alt auth_epoch mismatch
        API-->>C: WS close 4401 AUTH_EPOCH_INVALID
    else valid
        API-->>C: WS AUTHENTICATED
    end
```

**auth_epoch** is re-read from the DB on every command handler (not cached from the token payload). Bumping `auth_epoch` (password change or explicit revoke) instantly invalidates all previously issued tokens.

---

## 3. Bid Command Flow (Hot Path)

This is the highest-frequency and highest-latency-sensitivity path. The entire flow from WS receipt to broadcast must complete in < 200ms p99.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant WS as "WS Handler (Fastify)"
    participant Q as "AsyncQueue (per draft)"
    participant CMD as Command Handler
    participant DB as PostgreSQL
    participant BCAST as Broadcast

    C->>WS: WS message BID_COMMAND {player_auction_id, amount_minor, bid_type, expected_version}
    note over WS: server_receipt_time = Date.now() stamped HERE before any await
    WS->>Q: enqueue(bid_command)

    note over Q: Serialized, one command in-flight per draft
    Q->>CMD: dequeue and execute

    CMD->>DB: SELECT auth_epoch for league/team (re-read unconditionally, never from cache)
    CMD->>CMD: validate bid: auction status OPEN, budget check, version match
    alt validation fails
        CMD-->>C: WS ERROR {code, reason}
    else valid
        CMD->>DB: BEGIN TRANSACTION
        CMD->>DB: UPDATE player_auction SET current_bid, leader, auction_version++
        CMD->>DB: INSERT bid_attempt (accepted=true, server_receipt_time)
        CMD->>DB: INSERT draft_event (BID_ACCEPTED, sequence++)
        CMD->>CMD: anti-snipe check: server_receipt_time vs rebid_deadline
        opt anti-snipe triggered
            CMD->>DB: UPDATE player_auction SET rebid_deadline += extension_ms
        end
        CMD->>DB: COMMIT
        CMD->>CMD: update in-memory DraftState
        CMD->>BCAST: broadcast BID_ACCEPTED to all connected clients in draft
    end
```

**Key invariants enforced here:**
- `server_receipt_time` stamped before any `await`
- DB transaction wraps the update + bid_attempt INSERT + draft_event INSERT atomically
- In-memory state updated AFTER commit, never before
- Broadcast happens AFTER commit

---

## 4. Nomination and Timer Expiry Flow

```mermaid
sequenceDiagram
    autonumber
    participant TIMER as "Timer (setInterval)"
    participant Q as AsyncQueue
    participant CMD as Command Handler
    participant DB as PostgreSQL
    participant BCAST as Broadcast

    note over TIMER: Server polls expired auctions every ~500ms
    TIMER->>Q: enqueue(check_expired_auctions)
    Q->>CMD: execute

    alt nomination_deadline expired, no bids
        CMD->>CMD: identify next nominator (nomination_cursor)
        CMD->>CMD: check team's NominationQueue for queued player
        alt queue has player
            CMD->>DB: UPDATE player_auction status=OPEN, set deadlines
            CMD->>DB: INSERT draft_event NOMINATION_STARTED
            CMD->>BCAST: NOMINATION_STARTED {player, nominator, deadline}
        else queue empty
            CMD->>CMD: argmax(aav_minor) from available PlayerDatasetEntries
            CMD->>DB: UPDATE player_auction status=OPEN (system auto-nominate)
            CMD->>DB: INSERT draft_event NOMINATION_STARTED (system)
            CMD->>BCAST: NOMINATION_STARTED {player, system_nominated: true}
        end
    else rebid_deadline expired, bids exist
        CMD->>DB: UPDATE player_auction status=CLOSED
        CMD->>DB: INSERT draft_event AUCTION_CLOSED
        CMD->>CMD: enter resolution (see §5)
    end
```

---

## 5. Resolution Flow (Award + Ledger + Roster)

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Handler
    participant DB as PostgreSQL
    participant BCAST as Broadcast

    CMD->>DB: BEGIN TRANSACTION
    CMD->>DB: UPDATE player_auction status=AWARDED, resolution_sequence=next_seq
    CMD->>DB: INSERT acquisition {team_id, player_auction_id, price_minor, resolution_sequence, active=true}
    CMD->>DB: INSERT budget_ledger_entry {amount_minor=-price, entry_type=AWARD, active=true}
    CMD->>DB: UPDATE draft_team_state SET remaining_budget_minor -= price
    CMD->>DB: SELECT lowest-priority unfilled starter slot (starter-first assignment)
    CMD->>DB: INSERT roster_entry {acquisition_id, roster_slot_id, active=true}
    CMD->>DB: UPDATE draft_team_state SET roster_filled_count++, required_remaining_spots--
    CMD->>DB: INSERT draft_event PLAYER_AWARDED {sequence++}
    CMD->>DB: COMMIT
    CMD->>CMD: update in-memory DraftState
    CMD->>BCAST: PLAYER_AWARDED {player, team, price, roster_slot}

    CMD->>CMD: advance nomination_cursor and trigger next nomination window
```

**Roster assignment rule:** deterministic — lowest `priority` number among unfilled starter slots first, then bench. Never reshuffles prior assignments.

---

## 6. Dataset Import Flow

All parsing is off the main event loop via `node:worker_threads`. The dataset is FROZEN before a draft can reference it; a FROZEN dataset is immutable.

```mermaid
flowchart LR
    subgraph "Ingestion (main thread)"
        UP[Commissioner uploads file] --> ROUTE{File type?}
        ROUTE -->|CSV| WK_CSV[Spawn worker: csv-parser]
        ROUTE -->|Excel XLSX| WK_EXCEL[Spawn worker: SheetJS]
        ROUTE -->|ESPN PDF| WK_PDF[Spawn worker: pdfjs-dist]
        ROUTE -->|FantasyPros| FP_API[GET FantasyPros API]
    end

    subgraph "worker_threads (off main event loop)"
        WK_CSV --> ROWS[Parsed rows: name, position, aav_minor, projected_pts, tier]
        WK_EXCEL --> ROWS
        WK_PDF --> ROWS
    end

    FP_API --> ROWS

    subgraph "Main thread persist"
        ROWS --> UPSERT[UPSERT into Player master table]
        UPSERT --> PDE[INSERT PlayerDatasetEntry rows]
        PDE --> VALIDATE{Dataset valid?}
        VALIDATE -->|errors| ERR[Return validation errors to commissioner]
        VALIDATE -->|clean| PREVIEW[Return preview to commissioner]
        PREVIEW --> FREEZE[Commissioner freezes dataset]
        FREEZE --> FROZEN[(DraftDataset status=FROZEN)]
    end

    FROZEN --> DRAFT[Draft can reference frozen dataset]
```

---

## 7. Session Reconnect Flow

A client reconnecting after a disconnect receives a full state snapshot and replays any missed `DraftEvent` rows.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant WS as WS Handler
    participant DB as PostgreSQL
    participant BCAST as Broadcast

    C->>WS: WS CONNECT (token, last_seen_sequence)
    WS->>WS: verify JWT + auth_epoch (re-read from DB)
    WS->>DB: SELECT DraftState snapshot (all in-memory state)
    WS->>DB: SELECT DraftEvent WHERE sequence > last_seen_sequence ORDER BY sequence ASC
    DB-->>WS: snapshot + missed events

    WS-->>C: STATE_SNAPSHOT {full draft state, budgets, roster, auction status}
    WS-->>C: replay missed DraftEvents in sequence order

    note over C: Client displays "Reconnecting..." banner during gap
    note over C: Banner changes to draft state once sync complete

    WS->>BCAST: register client in draft room broadcast list
```

**Crash recovery:** On server restart, any `RUNNING` draft is set to `PAUSED` before the WS server accepts connections. Commissioners resume explicitly. This prevents a late-firing deadline from being applied against stale in-memory state.

---

## 8. Auto-Agent Flow

```mermaid
flowchart TD
    DISCONNECT[All team sessions disconnect] --> TIMER[Start grace timer<br/>e.g. 30s]
    TIMER -->|timer expires| AUTO[Set control_mode=AUTO_AGENT<br/>broadcast TEAM_AUTO_AGENT_ENABLED]
    AUTO --> TRIGGER{Auction event?}
    TRIGGER -->|NOMINATION_STARTED| CHECK{Am I the leader?}
    TRIGGER -->|BID_ACCEPTED new leader| CHECK
    CHECK -->|leader = me| HOLD[No action needed]
    CHECK -->|leader != me, current_bid < willingness_ceiling| BID[Enqueue auto-bid +$1]
    BID --> Q["AsyncQueue, same path as manual bid"]
    RECONNECT[Any team session reconnects] --> MANUAL[control_mode stays AUTO_AGENT<br/>must be manually switched]
    MANUAL --> PROMPT["Client shows Take control banner"]
```

Auto-Agent does NOT auto-resume manual mode on reconnect. The owner sees a banner and explicitly takes control. All mode transitions are audited as DraftEvents.

---

## 9. Rollback Flow (Commissioner)

```mermaid
sequenceDiagram
    autonumber
    participant COMM as Commissioner
    participant API as REST API
    participant DB as PostgreSQL
    participant BCAST as Broadcast

    COMM->>API: POST /drafts/:id/rollback {count: N}
    API->>API: auth check, COMMISSIONER role only
    API->>DB: BEGIN TRANSACTION (draft is PAUSED guard check)
    API->>DB: SELECT last N acquisitions WHERE active=true ORDER BY resolution_sequence DESC
    loop For each acquisition in reverse resolution_sequence order
        API->>DB: UPDATE acquisition SET active=false
        API->>DB: UPDATE roster_entry SET active=false WHERE acquisition_id=?
        API->>DB: INSERT budget_ledger_entry {amount=+price, entry_type=ROLLBACK}
        API->>DB: UPDATE player_auction SET status=PENDING, resolution_sequence=NULL
        API->>DB: UPDATE draft_team_state SET remaining_budget += price, roster_filled_count--
    end
    API->>DB: INSERT draft_event ROLLBACK_APPLIED {count: N}
    API->>DB: COMMIT
    API-->>COMM: 200 {rolled_back: N}
    API->>BCAST: ROLLBACK_APPLIED {picks_reversed: [player_ids]}
```

**Constraint:** rollback requires the draft to be PAUSED first. Undoes picks in strict reverse `resolution_sequence` order as one all-or-nothing transaction.

---

## 10. External Integration Surface

| System | Direction | Mechanism | When |
|--------|-----------|-----------|------|
| FantasyPros API | Inbound | REST GET (main thread) | Dataset import, triggered by commissioner |
| ESPN PDF | Inbound | File upload → pdfjs-dist in worker_thread | Dataset import |
| Excel/CSV | Inbound | File upload → SheetJS / node:readline in worker_thread | Dataset import |
| SendGrid | Outbound | REST POST (fire-and-forget) | Post-draft — summary email to all owners |
| ESPN (worksheet) | Outbound | File download (generated server-side) | Post-draft — commissioner downloads |
| Railway PostgreSQL | Inbound | postgres.js pool (DATABASE_URL) | All persistence |
| Railway platform | n/a | NODE_ENV, RAILWAY_PUBLIC_DOMAIN env vars | Service coordination |

---

## Provenance

| Section | Origin | Source |
|---------|--------|--------|
| Overview | Inherited | `decision-registry.yaml` → `concurrency-model`, `bid-latency-target`, `state-management-model` |
| Authentication Flow | Inherited | `knowledge/PRD.md` (§4.4 Auth model), `decision-registry.yaml` → `password-hashing`, `jwt-signing` |
| Bid Command Flow | Inherited | `knowledge/state-machine-flows.md` (§4 bid atomicity, §26 command queue), `discuss-prd.md` (Architectural Constraints) |
| Nomination/Timer Expiry | Inherited | `knowledge/state-machine-flows.md` (§8 nomination timers), `decision-registry.yaml` → `empty-nomination-queue` |
| Resolution Flow | Inherited | `knowledge/state-machine-flows.md` (§10 resolution), `knowledge/PRD.md` (§7 roster assignment) |
| Dataset Import Flow | Inherited | `decision-registry.yaml` → `csv-parsing-worker`, `pdf-parsing-library`, `phase2b-adapters` |
| Session Reconnect Flow | Inherited | `decision-registry.yaml` → `ws-reconnect-strategy`, `session-state-location`, `crash-recovery-ux` |
| Auto-Agent Flow | Inherited | `knowledge/state-machine-flows.md` (§24 Auto-Agent), `knowledge/PRD.md` (§Auto-Agent transitions) |
| Rollback Flow | Inherited | `knowledge/PRD.md` (§31 corrections/rollback), `knowledge/data-model.md` (§17.5) |
| External Integration Surface | Inherited | `discuss-prd.md` (Integration Surface table), `decision-registry.yaml` → `phase2b-adapters` |
