# Data Flow

> **Note:** Pre-implementation. All flows are `[PLANNED]`.

## Overview

Three primary data flows: (1) the bid atomicity pipeline — the hottest and most invariant-sensitive path; (2) ingestion — player data loaded pre-draft into a frozen DraftDataset; (3) reconnect replay — snapshot + missed-event catch-up on WS reconnect.

## Bid Atomicity Pipeline (primary runtime flow)

```mermaid
flowchart TD
    CLIENT["Client sends WS command<br/>(bid / nominate / pause)"] --> TS["Timestamp server_receipt_time<br/>in WS handler BEFORE any await<br/>PLANNED"]
    TS --> AUTH{"Auth middleware<br/>token valid + auth_epoch<br/>current + league_id matches?<br/>PLANNED"}
    AUTH -->|"rejected"| NACK["Send NACK to client<br/>PLANNED"]
    AUTH -->|"accepted"| DEDUP{"Idempotency key<br/>already seen?<br/>PLANNED"}
    DEDUP -->|"duplicate"| PREV["Return previous ack<br/>PLANNED"]
    DEDUP -->|"new"| ENQUEUE["Enqueue on per-draft<br/>serialized command queue<br/>PLANNED"]
    ENQUEUE --> LOCK["Lock PlayerAuction<br/>PLANNED"]
    LOCK --> DEADLINE{"server_receipt_time<br/>≤ deadline?<br/>PLANNED"}
    DEADLINE -->|"expired"| REJECT["Reject with DEADLINE_EXPIRED<br/>PLANNED"]
    DEADLINE -->|"valid"| VALIDATE{"Bid type validation<br/>PLUS_ONE / MATCH / CUSTOM /<br/>AUTO_AGENT / COMMISSIONER<br/>PLANNED"}
    VALIDATE -->|"invalid"| REJECT2["Reject with reason<br/>PLANNED"]
    VALIDATE -->|"valid"| ROSTERBUDGET{"Roster + budget<br/>check — max legal bid<br/>formula<br/>PLANNED"}
    ROSTERBUDGET -->|"illegal"| REJECT3["Reject<br/>PLANNED"]
    ROSTERBUDGET -->|"legal"| ANTISNIPE["Anti-sniping classification<br/>AUTO_AGENT exempt from penalty<br/>PLANNED"]
    ANTISNIPE --> TX["BEGIN TRANSACTION<br/>PLANNED"]
    TX --> WRITEBID["INSERT BidAttempt (accepted)<br/>PLANNED"]
    WRITEBID --> WRITEEVENT["INSERT DraftEvent (sequence<br/>allocated inside transaction)<br/>PLANNED"]
    WRITEEVENT --> COMMIT{"COMMIT<br/>PLANNED"}
    COMMIT -->|"failure"| ROLLBACKTX["Reject command<br/>in-memory state untouched<br/>PLANNED"]
    COMMIT -->|"success"| INMEM["Update in-memory DraftTeamState<br/>+ PlayerAuction<br/>PLANNED"]
    INMEM --> BROADCAST["Broadcast to all draft<br/>sessions<br/>PLANNED"]
```

## Data Ingestion Pipeline (pre-draft)

```mermaid
flowchart LR
    subgraph "Sources"
        CSV["Commissioner CSV<br/>players / projections / AAVs"]
        PDF["ESPN AAV PDF<br/>Phase 2b PLANNED"]
        FP["FantasyPros / Sleeper<br/>Phase 2b PLANNED"]
    end

    CSV --> PARSE["Parse + normalize<br/>PLANNED"]
    PDF --> PARSE
    FP --> PARSE
    PARSE --> MATCH{"Player match /<br/>ambiguity resolution<br/>PLANNED"}
    MATCH -->|"unmatched"| REVIEW["Commissioner review UI<br/>PLANNED"]
    REVIEW --> MATCH
    MATCH -->|"matched"| IMPORT["DatasetImport row<br/>PLANNED"]
    IMPORT --> FREEZE{"Commissioner<br/>freezes dataset<br/>PLANNED"}
    FREEZE --> FROZEN[("DraftDataset FROZEN<br/>Immutable player snapshot<br/>PLANNED")]
    FROZEN -->|"referenced by"| DRAFT["Draft (live auction)<br/>PLANNED"]
```

## WS Reconnect Replay

```mermaid
flowchart TD
    CONN["Client reconnects<br/>PLANNED"] --> HANDSHAKE["AUTH message<br/>(token, draft_id)<br/>PLANNED"]
    HANDSHAKE --> AUTHCHECK{"Token valid?<br/>PLANNED"}
    AUTHCHECK -->|"no"| CLOSE["Close socket<br/>PLANNED"]
    AUTHCHECK -->|"yes"| SNAPSHOT["Take state snapshot<br/>from quiescent command queue<br/>PLANNED"]
    SNAPSHOT --> SENDSNAPSHOT["Send snapshot<br/>tagged with state_version<br/>PLANNED"]
    SENDSNAPSHOT --> REPLAY["Replay DraftEvents<br/>with seq > snapshot_seq<br/>PLANNED"]
    REPLAY --> LIVE["Resume live event stream<br/>PLANNED"]
```

## Data Pipelines

| Pipeline | Source | Processing | Destination |
|----------|--------|-----------|-------------|
| Bid atomicity | WS command | Auth → dedup → queue → validate → tx | PostgreSQL + in-memory + WS broadcast [PLANNED] |
| Player ingestion | CSV / PDF / API | Parse → match → review → freeze | DraftDataset (PostgreSQL) [PLANNED] |
| WS reconnect | Reconnecting client | Snapshot + event replay | Client WS stream [PLANNED] |
| Nomination turn | Draft timer / owner action | FSM transition → create PlayerAuction | PostgreSQL + WS broadcast [PLANNED] |
| Auction resolution | Deadline expiry | Acquire → debit ledger → assign roster | Acquisition, RosterEntry, BudgetLedgerEntry [PLANNED] |
| Auto-Agent bid | Leadership change / auction open | Willingness calc → +$1 bid via Phase 3 pipeline | Same as bid atomicity [PLANNED] |
| Rollback | Commissioner action | Reverse-order undo → compensating rows | Superseded Acquisition / RosterEntry / Ledger entries [PLANNED] |
| Draft summary | Draft COMPLETE | Integrity check → report generation (off main loop) | DraftSummaryReport + optional email [PLANNED] |

## Integration Points

- **Inbound:** Commissioner CSV upload (player master + AAVs) [PLANNED]
- **Inbound:** ESPN AAV PDF (Phase 2b) [PLANNED]
- **Inbound:** FantasyPros / Sleeper / nflverse (Phase 2b) [PLANNED]
- **Outbound:** WS broadcast to all connected draft sessions per event [PLANNED]
- **Outbound:** ESPN entry-order worksheet (Phase 9) [PLANNED]
- **Outbound:** SendGrid email for draft summary reports (Phase 9, stub first) [PLANNED]
