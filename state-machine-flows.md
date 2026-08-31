# Fantasy Football Auction Draft Platform — State Machines and Flows

**Purpose:** Agent-consumable behavioral specification.  
**Companion:** `prd.md`, `data-model.md`

---

## 1. Draft-Level State Machine

```mermaid
stateDiagram-v2
    [*] --> UPCOMING
    UPCOMING --> RUNNING: commissioner starts draft
    RUNNING --> PAUSED: commissioner pauses
    PAUSED --> RUNNING: commissioner resumes
    RUNNING --> COMPLETE: all required roster spots filled / commissioner finalizes
    COMPLETE --> [*]

    RUNNING --> RUNNING: PlayerAuction lifecycle repeats
```

### Draft states

| State | Meaning | Permitted major actions |
|---|---|---|
| UPCOMING | Setup/readiness | imports, roster config, owner prep, media upload |
| RUNNING | Live draft | nomination, bidding, Auto-Agent, Whammy, corrections |
| PAUSED | Draft globally paused | commissioner/recovery actions; no live deadline progression |
| COMPLETE | Final authoritative draft | analytics/export/reconciliation |

---

## 2. Nomination Turn Flow

```mermaid
flowchart TD
    A[Select next eligible nominating team] --> B{Team control mode?}

    B -->|MANUAL| C[Start Nomination Timer]
    B -->|AUTO_AGENT| H[Auto-Agent chooses legal nomination]

    C --> D{Owner submits legal nomination before deadline?}
    D -->|Yes| I[Create PlayerAuction]
    D -->|No| E{Nomination Queue has legal entry?}

    E -->|Yes| F[Use first legal queued player + configured opening bid]
    E -->|No| G[Fallback Auto-Agent/default nomination policy]

    F --> I
    G --> I
    H --> I

    I --> J{First nomination by this team in draft AND MP3 exists?}
    J -->|Yes| K[Broadcast PLAY_TEAM_NOMINATION_AUDIO max 5 sec]
    J -->|No| L[Open Second-Bid Timer]
    K --> L
```

### Nomination rules

- Watch List never auto-nominates.
- Nomination Queue may auto-nominate.
- Opening price may be any legal amount.
- Team nomination audio is presentation-only and does not delay auction opening.
- A team with a complete roster is skipped in future nomination order.

---

## 3. PlayerAuction State Machine

```mermaid
stateDiagram-v2
    [*] --> SECOND_BID_OPEN: nomination accepted

    SECOND_BID_OPEN --> PAUSED: draft/auction pause
    PAUSED --> SECOND_BID_OPEN: resume to saved phase
    PAUSED --> REBID_OPEN: resume to saved phase

    SECOND_BID_OPEN --> REBID_OPEN: first accepted competing bid
    SECOND_BID_OPEN --> RESOLVING: second-bid deadline expires

    REBID_OPEN --> REBID_OPEN: accepted ordinary/custom/Match bid
    REBID_OPEN --> RESOLVING: authoritative deadline expires

    RESOLVING --> AWARDED: commit acquisition + budget + roster
    AWARDED --> [*]

    AWARDED --> REVERSED: commissioner correction/rollback supersedes
    REVERSED --> [*]
```

### Resolution when no competing bid exists

If Second-Bid Timer expires with no accepted competing bid:

- nominating team wins;
- price = opening nomination price.

---

## 4. Bid Command Decision Flow

```mermaid
flowchart TD
    A[Receive Bid Command] --> B[Authenticate + authorize team]
    B --> C[Deduplicate idempotency key]
    C --> D[Load/lock PlayerAuction]
    D --> E{Auction bidding state open?}

    E -->|No| R1[Reject: AUCTION_NOT_OPEN]
    E -->|Yes| F{Before authoritative deadline?}

    F -->|No| R2[Reject: DEADLINE_EXPIRED]
    F -->|Yes| G{Bid type}

    G -->|PLUS_ONE| H[Validate expected bid + expected version]
    G -->|MATCH| I[Validate expected bid/version + match right]
    G -->|CUSTOM| J[Validate exact requested amount > current bid]
    G -->|AUTO_AGENT| K[Calculate explicit attempted amount then apply relevant validation]
    G -->|COMMISSIONER_FOR_OWNER| L[Apply declared bid semantics + audit actor]

    H --> M{State current?}
    M -->|No| R3[Reject: STALE_STATE]
    M -->|Yes| N[Calculate requested current+1]

    I --> O{Match legal and unused?}
    O -->|No| R4[Reject: MATCH_NOT_AVAILABLE]
    O -->|Yes| P[Requested amount = exact current bid]

    J --> Q{Requested amount still > current authoritative bid?}
    Q -->|No| R5[Reject: PRICE_ALREADY_REACHED]
    Q -->|Yes| S[Use exact requested amount]

    K --> S
    L --> S
    N --> S
    P --> S

    S --> T[Validate roster capacity + max legal bid]
    T --> U{Legal?}
    U -->|No| R6[Reject: BUDGET_OR_ROSTER_RULE]
    U -->|Yes| V[Classify anti-sniping / penalty]

    V --> W{Owner currently prohibited at this remaining time?}
    W -->|Yes| R7[Reject: ANTI_SNIPE_RESTRICTION]
    W -->|No| X[Persist accepted BidAttempt + update leader/version/deadline]
    X --> Y[Commit transaction]
    Y --> Z[Broadcast BID_ACCEPTED authoritative state]

    R1 --> RR[Persist rejected BidAttempt]
    R2 --> RR
    R3 --> RR
    R4 --> RR
    R5 --> RR
    R6 --> RR
    R7 --> RR
    RR --> RB[Return rejection reason + current authoritative state]
```

---

## 5. Relative vs Absolute Bid Semantics

| Bid Type | Economic intent | Stale-state rule | Amount behavior |
|---|---|---|---|
| +$1 | "Bid one dollar above what I currently see" | exact current bid + version must match | server calculates displayed current + $1 |
| Match | "Use my one-time right to tie the exact bid I currently see" | exact current bid + version must match | same amount, leader changes |
| Custom | "I offer exactly $X" | exact prior price need not match | accept only if $X still exceeds current bid |
| Auto-Agent | explicit generated offer | must obey same server rules | never exceed calculated willingness |
| Commissioner-for-owner | declared semantics | audited | treated as owner bid with commissioner actor metadata |

---

## 6. Nominator Match State

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE: PlayerAuction created and feature enabled

    AVAILABLE --> UNAVAILABLE_WHILE_LEADING: nominator becomes high bidder normally
    UNAVAILABLE_WHILE_LEADING --> AVAILABLE: another team becomes high bidder

    AVAILABLE --> CONSUMED: legal Match accepted
    UNAVAILABLE_WHILE_LEADING --> CONSUMED: impossible directly

    AVAILABLE --> EXPIRED: bidding deadline expires
    UNAVAILABLE_WHILE_LEADING --> EXPIRED: bidding deadline expires

    CONSUMED --> CONSUMED: never restored during same PlayerAuction
    EXPIRED --> [*]
    CONSUMED --> [*]
```

Notes:

- "Unavailable while leading" is a UI/eligibility condition, not a reset of the right.
- Once `CONSUMED`, it stays consumed.
- No post-deadline Match window.

---

## 7. PlayerAuction Resolution Transaction

```mermaid
flowchart TD
    A[Authoritative deadline reached] --> B[Lock PlayerAuction]
    B --> C{Already resolved?}
    C -->|Yes| X[No-op / return committed result]
    C -->|No| D[Determine current high bidder]
    D --> E[Validate winner still legal]
    E --> F[Create Acquisition]
    F --> G[Debit BudgetLedger]
    G --> H[Assign RosterEntry using starter-first algorithm]
    H --> I[Update DraftTeamState]
    I --> K[Emit PLAYER_AWARDED event]
    K --> L[Commit]
    L --> M[Broadcast acquisition + ephemeral close card]
    M --> N[Advance nomination order]
```

This resolution is itself the undo boundary rollback walks backward through — no separate checkpoint entity is created (§17.5 of `data-model.md`).

---

## 8. Starter-First Roster Assignment Flow

```mermaid
flowchart TD
    A[Acquired Player] --> B[Find all unfilled starter slots accepting player]
    B --> C{Any eligible starter slot?}

    C -->|Yes| D[Sort by assignment_priority ascending]
    D --> E[Choose first slot type]
    E --> F[Choose first unfilled ordinal]
    F --> G[Create starter RosterEntry]

    C -->|No| H{Bench slot available?}
    H -->|Yes| I[Choose first available bench ordinal]
    I --> J[Create bench RosterEntry]
    H -->|No| K[Invariant violation: acquisition should have been rejected]
```

### Examples

```text
Open slots: WR2, OFF_FLEX, Bench
Acquire WR
=> WR2

Open slots: OFF_FLEX, Bench
Acquire WR
=> OFF_FLEX

Open slots: Bench only
Acquire WR
=> Bench
```

No lineup optimization or rearrangement after assignment.

---

## 9. Team Manual / Auto-Agent Control State

```mermaid
stateDiagram-v2
    [*] --> MANUAL_CONNECTED

    MANUAL_CONNECTED --> MANUAL_RECONNECTING: zero valid team sessions connected
    MANUAL_RECONNECTING --> MANUAL_CONNECTED: any valid team session reconnects before grace deadline
    MANUAL_RECONNECTING --> AUTO_AGENT_DISCONNECTED: grace deadline expires

    MANUAL_CONNECTED --> AUTO_AGENT_USER: owner enables Auto-Agent
    MANUAL_CONNECTED --> AUTO_AGENT_COMMISSIONER: commissioner enables Auto-Agent

    AUTO_AGENT_USER --> MANUAL_CONNECTED: owner/commissioner resumes manual control and connection exists
    AUTO_AGENT_COMMISSIONER --> MANUAL_CONNECTED: owner/commissioner resumes manual control and connection exists
    AUTO_AGENT_DISCONNECTED --> MANUAL_CONNECTED: explicit Resume Manual Control after reconnect

    AUTO_AGENT_USER --> AUTO_AGENT_USER: disconnect/reconnect does not change control mode
    AUTO_AGENT_COMMISSIONER --> AUTO_AGENT_COMMISSIONER: disconnect/reconnect does not change control mode
    AUTO_AGENT_DISCONNECTED --> AUTO_AGENT_DISCONNECTED: reconnect alone does not change control mode
```

### Transition side effects

Whenever transition enters any `AUTO_AGENT_*` state:

1. update DraftTeamState control mode;
2. record reason;
3. emit immutable DraftEvent;
4. broadcast team Auto-Agent badge/state;
5. broadcast toast to all auction participants.

Example:

> Team Alpha has entered Auto-Agent mode.

Whenever explicit transition returns to manual:

1. update control mode;
2. emit DraftEvent;
3. remove Auto-Agent badge;
4. broadcast toast.

---

## 10. Multi-Window Disconnect Detection

```mermaid
flowchart TD
    A[One DraftClientSession disconnects] --> B[Count valid connected owner/team sessions]
    B --> C{Count > 0?}

    C -->|Yes| D[Remain connected/manual; no Auto-Agent transition]
    C -->|No| E[Set connection_state = RECONNECTING]
    E --> F[Set reconnect_deadline_at]
    F --> G{A team session reconnects before deadline?}

    G -->|Yes| H[Clear reconnect deadline; restore CONNECTED]
    G -->|No| I{Current control mode already AUTO_AGENT?}

    I -->|Yes| J[Remain AUTO_AGENT; set connection state DISCONNECTED]
    I -->|No| K[Transition MANUAL -> AUTO_AGENT reason DISCONNECTED]
```

---

## 11. Auto-Agent Offer Calculation

This is intentionally a simple, explainable process.

```mermaid
flowchart TD
    A[Player under consideration] --> B{Customized owner Target exists?}
    B -->|Yes and configured to use| C[Base = Owner Target]
    B -->|No| D[Base = Primary AAV]

    C --> E[Apply stable/random agent variance within configured range]
    D --> E

    E --> F[Apply max_over_base_pct ceiling]
    F --> G{Would player fill an unfilled starter slot?}

    G -->|Yes| H[Use starter willingness]
    G -->|No| I[Apply bench_value_pct discount]

    H --> J[Clamp to max legal bid]
    I --> J

    J --> K[Respect Do Not Draft + roster rules]
    K --> L[Produce explicit max willingness for this player]
```

Recommended rule representation:

```yaml
base_value:
  target_if_customized: true
  else: primary_aav

max_over_base_pct: owner_config
random_variance_pct: owner_or_league_config
bench_value_pct: owner_config
prioritize_starters: true
```

The Auto-Agent should be able to explain its ceiling in logs/UI if desired.

---

## 12. Nomination Audio Flow

```mermaid
flowchart TD
    A[Nomination accepted] --> B{Team has MP3?}
    B -->|No| Z[No audio event]
    B -->|Yes| C{first_nomination_audio_played_at is null?}
    C -->|No| Z
    C -->|Yes| D[Atomically mark played_at]
    D --> E[Emit PLAY_TEAM_NOMINATION_AUDIO event]
    E --> F[Clients play from 0 to min(file duration, 5 sec)]
```

Audio failure must not affect auction state.

---

## 13. Pause / Resume

```mermaid
flowchart TD
    A[Commissioner pauses] --> B[Persist current phase + remaining ms]
    B --> C[Draft status PAUSED]
    C --> D[Broadcast paused state]

    D --> E[Commissioner resumes]
    E --> F[Restore phase-specific deadline from remaining ms]
    F --> G[Draft status RUNNING]
    G --> H[Broadcast new absolute deadline]
```

No deadline silently expires while paused.

---

## 14. Commissioner Correction Flow

```mermaid
flowchart TD
    A[Commissioner selects a pick to correct] --> B{Target PlayerAuction still OPEN?}
    B -->|Yes| G[Apply as live control: reassign winner/price/manual award]
    B -->|No, already AWARDED| C{Winning team has any Acquisition after this one?}

    C -->|No conflict| D[Enter required reason]
    D --> E[Preview financial/roster consequences for this one team]
    E --> F{Confirm?}
    F -->|No| X[Cancel]
    F -->|Yes| H[Append CommissionerAction]
    H --> I[Reverse this Acquisition's ledger + roster effects]
    I --> J[Apply corrected values]
    J --> K[Commit]
    K --> L[Broadcast corrected state]

    C -->|Conflict| M[Redirect to Rollback Flow, target = this pick]
```

Correction (no-conflict path) touches only the one team and one pick. Live-control edits to the currently open auction are unrestricted (nothing has resolved yet). Never mutate historical BidAttempts.

---

## 15. Rollback Flow

```mermaid
flowchart TD
    A[Commissioner opens rollback] --> B[Show most recent resolved PlayerAuctions, newest first]
    B --> C[Select how many picks back to undo, or a target pick]
    C --> D[Preview affected PlayerAuctions / acquisitions / budgets / rosters / Whammys for every pick that will be undone]
    D --> E[Enter reason + confirm]
    E --> F[Undo picks in reverse resolution order, one at a time]

    F --> G[Void Acquisition]
    G --> H[Append ROLLBACK_COMPENSATION ledger entry]
    H --> I[Deactivate RosterEntry]
    I --> J[Restore NominatorMatchRight state]
    J --> K{More picks left to undo?}
    K -->|Yes| F
    K -->|No| L[Restore nomination cursor to the earliest undone pick's team]

    L --> M[Commit]
    M --> N[Broadcast authoritative restored state]
```

There is one timeline per Draft; rollback never branches it. All undone picks' original events remain in the event log as superseded history. Undoing N picks always undoes the N most recently resolved picks — a commissioner cannot cherry-pick an earlier pick and leave later ones untouched; see §14 for when a single already-awarded pick can be corrected directly instead.

---

## 16. Whammy Flow

```mermaid
flowchart TD
    A[Configured trigger occurs] --> B{Whammy enabled and limits permit?}
    B -->|No| Z[No event]
    B -->|Yes| C[Select weighted eligible definition]
    C --> D{Commissioner approval required?}

    D -->|Yes| E[Create PENDING_APPROVAL event]
    E --> F{Commissioner approves?}
    F -->|No| G[Mark REJECTED]
    F -->|Yes| H[Apply Whammy]

    D -->|No| H

    H --> I{Budget delta?}
    I -->|Yes| J[Validate roster-completion financial invariant]
    J --> K[Append BudgetLedgerEntry]
    I -->|No| L[No financial mutation]

    K --> M[Emit/broadcast Whammy]
    L --> M
```

---

## 17. Draft Completion Flow

```mermaid
flowchart TD
    A[PlayerAuction resolves] --> B{All teams roster_complete?}
    B -->|No| C[Advance to next eligible nominator]
    B -->|Yes| D[Run final integrity validation]

    D --> E{Valid?}
    E -->|No| F[Commissioner resolution required]
    E -->|Yes| G[Finalize Draft]
    G --> H[Generate team evaluations]
    H --> I[Generate canonical CSV/JSON]
    I --> J[Prepare ESPN roster-entry workflow]
```

---

## 18. Final Validation Checklist

```yaml
draft_completion_invariants:
  - every required team roster slot is filled
  - every active acquired player belongs to exactly one team
  - no active player acquisition is duplicated
  - each RosterEntry refers to a legal slot for the player
  - each team's roster count equals configured total roster size
  - starter slots and bench counts match configuration
  - active budget ledger reconciles
  - no unresolved commissioner correction exists
  - no PlayerAuction remains open
  - one active DraftTimeline exists
```

---

## 19. Suggested Event Types

```text
DRAFT_SCHEDULED_START_SET
DRAFT_STARTED
DRAFT_PAUSED
DRAFT_RESUMED

NOMINATION_TURN_STARTED
PLAYER_NOMINATED
TEAM_NOMINATION_AUDIO_PLAYED

BID_ATTEMPT_REJECTED
BID_ACCEPTED
MATCH_CONSUMED
AUCTION_DEADLINE_EXTENDED
PLAYER_AWARDED

ROSTER_ENTRY_ASSIGNED
BUDGET_DEBITED
BUDGET_CREDITED

TEAM_RECONNECTING
TEAM_CONNECTION_RESTORED
TEAM_AUTO_AGENT_ENABLED
TEAM_MANUAL_CONTROL_RESUMED

WHAMMY_TRIGGERED
WHAMMY_APPLIED
WHAMMY_REJECTED

COMMISSIONER_CORRECTION
PICK_CORRECTED
ROLLBACK_REQUESTED
ROLLBACK_PICK_UNDONE
ROLLBACK_COMPLETED

DRAFT_COMPLETED
EXPORT_GENERATED
ESPN_RECONCILIATION_UPDATED
DRAFT_SUMMARY_REPORT_GENERATED
DRAFT_SUMMARY_REPORT_EMAILED
```

---

## 20. Recommended Implementation Order

See `BUILD_PLAN.md` for the authoritative phased build plan with acceptance criteria. Summary:

```text
0. Project scaffold + WS protocol envelope (sequence numbers, versioning) from day one
1. Authentication (site/league/team password) + league/roster/scoring configuration + draft scheduling
2. Player master + DraftDataset + CSV ingestion adapter (additional adapters later, parallelizable)
3. Auction Core, as one unit: Draft/DraftTeamState/nomination order (incl. Nomination Queue schema)
   + PlayerAuction state machine + BidAttempt atomicity/timers/stale-state protection
   + Acquisition/BudgetLedger/starter-first RosterEntry
4. Client session/reconnect model, including multi-draft isolation (§23)
5. Manual/Auto-Agent control transitions (incl. AutoAgentConfiguration schema)
6. Owner private strategy data: Watch List, Do Not Draft, Target Values CRUD/UI (parallelizable)
7. Commissioner corrections + rollback (§14, §15) — single-pick correction and LIFO undo-N
8. Whammy framework (parallelizable)
9. Analytics / Draft Summary Report / ESPN reconciliation / presentation polish (parallelizable)
```

---

## 21. Draft Start Scheduling

```mermaid
flowchart TD
    A[Commissioner sets/changes scheduled_start_at] --> B[Persist on Draft]
    B --> C[Broadcast DRAFT_SCHEDULED_START_SET to all connected clients]
    C --> D[Display scheduled time wherever draft status appears]
    D --> E{Commissioner clicks Start Draft?}
    E -->|No| D
    E -->|Yes| F[Normal DRAFT_STARTED transition, per §1]
```

The scheduled time is informational only; it never auto-starts the draft in MVP. If unset, clients display "Not yet scheduled."

---

## 22. Draft Summary Report Generation

```mermaid
flowchart TD
    A[Draft Completion Flow reaches Finalize Draft] --> B[Generate DraftTeamEvaluation per team]
    B --> C[Generate DraftSummaryReport: league_summary_json + team_report_json]
    C --> D{External email delivery enabled?}
    D -->|No| E[Report available in-app only]
    D -->|Yes| F[Create ReportDeliveryAttempt per team + commissioner]
    F --> G[Send email]
    G --> H{Sent OK?}
    H -->|Yes| I[Mark SENT]
    H -->|No| J[Mark FAILED; report remains available in-app]
```

Email delivery failure never removes or blocks in-app report access.

---

## 23. Multi-Draft Isolation

The server process may host more than one RUNNING Draft at a time, across different Leagues (MVP target: at least two concurrently). All in-memory state, timers, nomination cursors, and WebSocket broadcast groups are keyed by `draft_id`; no module-level singleton may hold draft state. A client connects to exactly one draft's event stream at a time (selected during the League/Team login flow, PRD.md §4.4).
