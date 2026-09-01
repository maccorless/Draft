# Data Model

> **Note:** Pre-implementation. All entities are `[PLANNED]`. Derived from `data-model.md`.

## Overview

State-stored (not event-sourced) Postgres schema. Live rows (`DraftTeamState`, `PlayerAuction`, `Acquisition`, `RosterEntry`, ledger) are authoritative truth. `DraftEvent` is append-only audit log and WS reconnect replay source — not used for arbitrary state reconstruction. Money is integer minor units (cents). Rollback appends compensating rows; history is never mutated.

## Entity Relationship Diagram

```mermaid
erDiagram
    League ||--o{ Team : has
    League ||--o| RosterConfiguration : "configured by"
    League ||--o| AuctionConfiguration : "configured by"
    League ||--o| ScoringConfiguration : "configured by"
    League ||--o{ Draft : hosts
    League ||--o{ WhammyConfiguration : "may have"

    League {
        uuid id PK
        string name
        int season
        uuid commissioner_user_id FK
        string commissioner_password_hash
        string host_password_hash
        uuid commissioner_team_id FK
        int auth_epoch
        enum status
    }

    Team ||--o{ DraftTeamState : "has per draft"
    Team ||--o{ NominationQueueEntry : "owns"
    Team ||--o{ WatchListEntry : "owns"
    Team ||--o{ DoNotDraftEntry : "owns"
    Team ||--o{ OwnerPlayerTarget : "owns"
    Team ||--o| AutoAgentConfiguration : "configures"
    Team {
        uuid id PK
        uuid league_id FK
        string name
        string team_password_hash
        string owner_email
        int auth_epoch
        int starting_budget_override_minor
        int draft_order
        enum status
    }

    Draft ||--o{ PlayerAuction : runs
    Draft ||--o{ DraftTeamState : tracks
    Draft ||--o{ DraftEvent : logs
    Draft ||--o{ CommissionerAction : records
    Draft {
        uuid id PK
        uuid league_id FK
        uuid dataset_id FK
        enum status
        int nomination_cursor
        int state_version
        timestamp scheduled_start_at
        timestamp started_at
        timestamp completed_at
    }

    DraftTeamState {
        uuid id PK
        uuid draft_id FK
        uuid team_id FK
        int remaining_budget_minor
        int roster_filled_count
        enum control_mode
        int disconnect_grace_timer_remaining_ms
        int anti_snipe_penalty_remaining_auctions
        int anti_snipe_strike_count
    }

    PlayerAuction ||--o{ BidAttempt : records
    PlayerAuction ||--o| NominatorMatchRight : "grants"
    PlayerAuction ||--o| Acquisition : "resolves to"
    PlayerAuction {
        uuid id PK
        uuid draft_id FK
        uuid dataset_player_id FK
        uuid nominating_team_id FK
        int opening_price_minor
        int current_price_minor
        uuid current_leader_team_id FK
        enum status
        timestamp second_bid_deadline
        timestamp rebid_deadline
        int sequence_at_nomination
    }

    BidAttempt {
        uuid id PK
        uuid player_auction_id FK
        uuid team_id FK
        uuid session_id FK
        enum bid_type
        int amount_minor
        enum result
        timestamp server_receipt_time
        string idempotency_key
        bool anti_snipe_classified
    }

    Acquisition ||--o{ RosterEntry : produces
    Acquisition ||--o{ BudgetLedgerEntry : triggers
    Acquisition {
        uuid id PK
        uuid player_auction_id FK
        uuid draft_id FK
        uuid team_id FK
        uuid dataset_player_id FK
        int price_minor
        int resolution_sequence
        bool active
        uuid superseded_by FK
    }

    RosterEntry {
        uuid id PK
        uuid acquisition_id FK
        uuid team_id FK
        uuid draft_id FK
        uuid roster_slot_definition_id FK
        enum slot_type
        bool active
    }

    BudgetLedgerEntry {
        uuid id PK
        uuid draft_id FK
        uuid team_id FK
        int amount_minor
        enum reason
        uuid acquisition_id FK
        uuid whammy_event_id FK
        bool active
    }

    DraftEvent {
        uuid id PK
        uuid draft_id FK
        int sequence
        enum event_type
        jsonb payload
        timestamp created_at
    }

    DraftDataset ||--o{ PlayerAuction : "scopes players for"
    DraftDataset {
        uuid id PK
        uuid league_id FK
        enum status
        int version
        timestamp frozen_at
    }
```

## Key Entities

| Entity | Purpose | Key Fields | Relationships |
|--------|---------|------------|---------------|
| League | League configuration and auth | commissioner_password_hash, auth_epoch | 1:N Teams, 1:N Drafts [PLANNED] |
| Team | Team identity and budget override | team_password_hash, auth_epoch, starting_budget_override_minor | N:1 League, 1:N DraftTeamState [PLANNED] |
| Draft | Live draft event FSM | status, nomination_cursor, state_version | 1:1 DraftDataset, 1:N PlayerAuction [PLANNED] |
| DraftTeamState | Per-team live state | remaining_budget_minor, control_mode, anti_snipe_penalty_remaining_auctions | N:1 Draft, N:1 Team [PLANNED] |
| PlayerAuction | Single-player auction FSM | status, current_price_minor, current_leader_team_id, deadlines | N:1 Draft, 1:N BidAttempt [PLANNED] |
| BidAttempt | All bid attempts incl. rejected | bid_type, result, server_receipt_time, idempotency_key | N:1 PlayerAuction [PLANNED] |
| Acquisition | Awarded pick (append-only, supersede to correct) | price_minor, resolution_sequence, active | 1:N RosterEntry, 1:N BudgetLedgerEntry [PLANNED] |
| RosterEntry | Starter-first slot assignment | slot_type, active | N:1 Acquisition [PLANNED] |
| BudgetLedgerEntry | Ledger-backed budget changes | amount_minor, reason, active | N:1 Team, N:1 Draft [PLANNED] |
| DraftEvent | Immutable audit log + WS replay | sequence, event_type, payload | N:1 Draft [PLANNED] |
| DraftDataset | Frozen versioned player snapshot | status (FROZEN), version | Referenced by Draft [PLANNED] |

## Data Stores

| Store | Type | Purpose |
|-------|------|---------|
| PostgreSQL | Relational RDBMS | All persistent state — teams, draft, auctions, ledger, events [PLANNED] |
| In-memory (Node.js Map) | Process memory | Hot draft state per draft_id; authoritative only after DB commit [PLANNED] |
