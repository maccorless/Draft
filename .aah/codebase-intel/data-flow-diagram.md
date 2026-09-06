# Data Flow

## Overview

Three primary data flows, all implemented: (1) the bid atomicity pipeline — the hottest and most invariant-sensitive path, in `server/src/auction/engine.ts` + `ws/auction-handler.ts`; (2) ingestion — player/AAV data loaded pre-draft via CSV/Excel/ESPN-PDF/FantasyPros adapters into a frozen DraftDataset; (3) reconnect replay — snapshot + missed-event catch-up via `session/routes.ts` on WS reconnect.

## Bid Atomicity Pipeline (primary runtime flow)

```mermaid
flowchart TD
    CLIENT["Client sends WS command<br/>(BID_COMMAND / NOMINATE_COMMAND /<br/>PASS_NOMINATION / NOMINATOR_MATCH_COMMAND)"] --> TS["Stamp server_receipt_time = new Date()<br/>first line of ws/auction-handler.ts,<br/>before any await"]
    TS --> AUTH{"auth-hook: token valid,<br/>auth_epoch current<br/>(read from leagues/teams table,<br/>not token payload),<br/>league_id matches?"}
    AUTH -->|"rejected"| NACK["Send NACK to client"]
    AUTH -->|"accepted"| ONBEHALF{"on_behalf_of_team_id set?<br/>(COMMISSIONER only)"}
    ONBEHALF -->|"yes, non-commissioner"| REJECTOB["Reject"]
    ONBEHALF -->|"resolved"| ENQUEUE["Enqueue on auction/queue.ts<br/>AsyncQueue - one in-flight<br/>command per draft_id"]
    ENQUEUE --> DEADLINE{"server_receipt_time<br/>within second_bid_deadline /<br/>rebid_deadline?"}
    DEADLINE -->|"expired"| REJECT["Reject (deadline expired)"]
    DEADLINE -->|"valid"| VALIDATE{"Bid type validation:<br/>PLUS_ONE / MATCH / CUSTOM /<br/>AUTO_AGENT / COMMISSIONER"}
    VALIDATE -->|"invalid"| REJECT2["Reject with reason string"]
    VALIDATE -->|"valid"| ROSTERBUDGET{"computeMaxLegalBid:<br/>remaining_budget_minor -<br/>($1 * other_required_remaining_spots);<br/>ROSTER_FULL hard gate if<br/>required_remaining_spots <= 0"}
    ROSTERBUDGET -->|"illegal"| REJECT3["Reject"]
    ROSTERBUDGET -->|"legal"| TX["sql.begin(...) transaction"]
    TX --> WRITEBID["INSERT bid_attempts (result=accepted)"]
    WRITEBID --> WRITEEVENT["INSERT draft_events<br/>(sequence allocated inside transaction)"]
    WRITEEVENT --> COMMIT{"COMMIT"}
    COMMIT -->|"failure"| ROLLBACKTX["Reject command;<br/>in-memory state untouched"]
    COMMIT -->|"success"| INMEM["Update in-memory DraftRuntime:<br/>DraftTeamState + PlayerAuction"]
    INMEM --> AWARDCHECK{"Auction resolved?<br/>(deadline expiry or all-pass)"}
    AWARDCHECK -->|"yes"| AWARD["awardAuction: assignRosterSlot<br/>(starter-first, lowest priority slot),<br/>debit BudgetLedgerEntry,<br/>create Acquisition + RosterEntry"]
    AWARD --> ADVANCE["advanceNominationTurn:<br/>selectAutoNominationPlayer via<br/>Nomination Queue or highest-AAV<br/>open-need pick"]
    AWARDCHECK -->|"no"| BROADCAST
    ADVANCE --> BROADCAST["Broadcast DraftEvent to all<br/>connected draft sessions over ws/auction-handler.ts"]
    INMEM -->|"leader changed"| AATRIGGER["triggerAutoAgentBidsOnLeaderChange:<br/>re-check every other AUTO_AGENT<br/>team's willingness ceiling"]
    AATRIGGER -.->|"re-enters pipeline<br/>as a new bid command"| ENQUEUE
```

## Data Ingestion Pipeline (pre-draft)

```mermaid
flowchart LR
    subgraph "Sources (server/src/player/adapters/)"
        CSV["Commissioner CSV<br/>csv.ts / csv-worker.ts"]
        XLS["Excel<br/>excel.ts / excel-worker.ts"]
        PDF["ESPN AAV PDF<br/>espn-pdf.ts / espn-pdf-worker.ts"]
        FP["FantasyPros<br/>fantasypros.ts"]
    end

    CSV --> PARSE["Parse + normalize"]
    XLS --> PARSE
    PDF --> PARSE
    FP --> PARSE
    PARSE --> MATCH{"Player match /<br/>ambiguity resolution"}
    MATCH -->|"unmatched"| REVIEW["Commissioner review<br/>(web/screens/commissioner/AmbiguityResolution.tsx)"]
    REVIEW --> MATCH
    MATCH -->|"matched"| SOURCEROWS["INSERT player_aav_sources<br/>(one row per dataset/player/source -<br/>multi-source AAV, F-MOD-016)"]
    SOURCEROWS --> RESOLVE["aav-resolution.ts:<br/>resolveEffectivePrimarySource /<br/>resolvePlayerPrimaryAav<br/>per commissioner-chosen primary/secondary"]
    RESOLVE --> IMPORT["draft_datasets row (status=DRAFT)"]
    IMPORT --> FREEZE{"Commissioner freezes dataset"}
    FREEZE --> FROZEN[("draft_datasets<br/>status=FROZEN<br/>Immutable player snapshot")]
    FROZEN -->|"referenced by"| DRAFT["Draft (live auction)"]
```

## WS Reconnect Replay

```mermaid
flowchart TD
    CONN["Client reconnects"] --> HANDSHAKE["AUTHENTICATE message<br/>(token, draft_id)"]
    HANDSHAKE --> AUTHCHECK{"Token valid +<br/>auth_epoch current?"}
    AUTHCHECK -->|"no"| CLOSE["Close socket"]
    AUTHCHECK -->|"yes"| SNAPSHOT["session/routes.ts:<br/>buildDraftStateSnapshot<br/>from current DraftRuntime"]
    SNAPSHOT --> SENDSNAPSHOT["Send snapshot<br/>tagged with state_version"]
    SENDSNAPSHOT --> REPLAY["Replay draft_events<br/>with sequence > snapshot sequence"]
    REPLAY --> LIVE["Resume live event stream<br/>over ws/auction-handler.ts"]
```

## Data Pipelines

| Pipeline | Source | Processing | Destination |
|----------|--------|-----------|-------------|
| Bid atomicity | WS command | Auth (auth_epoch) → on-behalf-of resolve → per-draft queue → deadline/type/roster-budget validate → tx | PostgreSQL + in-memory DraftRuntime + WS broadcast |
| Player ingestion | CSV / Excel / ESPN PDF / FantasyPros | Parse → match → review → multi-source AAV resolve → freeze | `draft_datasets` + `player_aav_sources` (PostgreSQL) |
| WS reconnect | Reconnecting client | Snapshot (`buildDraftStateSnapshot`) + event replay | Client WS stream |
| Nomination turn | Draft timer / owner action / Auto-Agent | FSM transition → create PlayerAuction (via Nomination Queue or highest-AAV open-need pick) | PostgreSQL + WS broadcast |
| Auction resolution | Deadline expiry | `awardAuction` → debit ledger → starter-first roster assignment | `acquisitions`, `roster_entries`, `budget_ledger_entries` |
| Auto-Agent bid | Leadership change / auction open, below willingness ceiling | Willingness calc (`computeAutoAgentWillingnessCeiling`) → re-enters bid pipeline | Same as bid atomicity |
| Whammy event | Commissioner trigger (or auto, if configured) | Approval gate (if `commissioner_approval_required`) → apply | `whammy_events` + `budget_ledger_entries` |
| Rollback | Commissioner action | Draft paused → reverse `resolution_sequence` order undo → compensating rows | Superseded `acquisitions` / `roster_entries` / ledger entries |
| Draft summary | Draft COMPLETE | Regenerated on each request from Acquisition + DraftTeamState rows (no separate report table) | `GET /drafts/:draftId/report`, `/espn-worksheet` (CSV), optional SendGrid email |

## Integration Points

- **Inbound:** Commissioner CSV/Excel upload (player master + AAVs)
- **Inbound:** ESPN AAV PDF (`espn-pdf.ts`)
- **Inbound:** FantasyPros adapter (`fantasypros.ts`) — multi-source AAV, resolved via `aav-resolution.ts`
- **Outbound:** WS broadcast to all connected draft sessions per accepted event
- **Outbound:** ESPN roster-transfer worksheet (`GET /drafts/:draftId/espn-worksheet`, CSV)
- **Outbound:** SendGrid email for draft summary reports (`POST /drafts/:draftId/report/email`, stub — fire-and-forget, failure never blocks report availability)
