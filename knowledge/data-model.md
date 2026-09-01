# Fantasy Football Auction Draft Platform — Domain / Data Model

**Purpose:** Agent-consumable domain specification.  
**Companion:** `prd.md`  
**Notation:** PK = primary key, FK = foreign key. Derived/materialized fields are explicitly identified.

---

## 1. Modeling Principles

1. **Draft** means the complete live drafting event.
2. **PlayerAuction** means one nominated player's auction.
3. All accepted state changes are server-authoritative.
4. `BidAttempt` includes accepted and rejected attempts.
5. Budget money is ledger-backed.
6. Rollback never deletes history.
7. Player data is versioned through `DraftDataset`.
8. Private owner strategy data is separated from shared player/reference data.
9. Roster assignments represent starter-slot fulfillment during the draft, not weekly lineup optimization.
10. Team control state (Manual/Auto-Agent) is part of live draft state.
11. Multi-window sessions belong to one team identity.
12. Only a price change may be corrected in place, and only when the winning team's later picks stay legal under it (§17.5). A winner or player change always requires rollback, which undoes the most recently resolved PlayerAuctions in strict reverse order — there is no arbitrary-point timeline branching.
13. MVP authentication is password-based (site/league/team/host), not account-based; `User`/`Membership` model a future email-based identity layer, but MVP identity is created deterministically at league/team setup, not per login (§3.2, §3.6).
14. Server state is isolated per `draft_id`; a deployment may host multiple concurrently RUNNING drafts across different leagues, and every session token is scoped to one `league_id`.

---

## 2. Bounded Contexts

```text
LEAGUE & RULES
  League
  Team
  Membership
  TeamMedia
  RosterConfiguration
  RosterSlotDefinition
  ScoringConfiguration
  ScoringRule
  AuctionConfiguration
  AutoAgentLeagueDefaults
  WhammyConfiguration
  WhammyDefinition

PLAYER INTELLIGENCE
  Player
  PlayerPositionEligibility
  ProviderPlayerMapping
  DraftDataset
  DataSource
  DatasetImport
  PlayerSeasonStats
  PlayerProjection
  PlayerStatus
  PlayerTier
  AAVSource
  PlayerAAV

OWNER PRIVATE STRATEGY
  OwnerPlayerTarget
  WatchListEntry
  NominationQueueEntry
  DoNotDraftEntry
  AutoAgentConfiguration

LIVE DRAFT
  Draft
  DraftTeamState
  DraftClientSession
  PlayerAuction
  BidAttempt
  NominatorMatchRight
  Acquisition
  RosterEntry
  BudgetLedgerEntry
  DraftEvent
  TeamDraftMediaState

RECOVERY / CONTROL
  CommissionerAction

WHAMMY EXECUTION
  WhammyEvent

POST-DRAFT / TRANSFER
  DraftTeamEvaluation
  ProviderTeamMapping
  ExportJob
  ReconciliationItem
  DraftSummaryReport
  DraftTeamReport
  ReportDeliveryAttempt
```

---

## 3. Core Entities

### 3.1 League

```yaml
League:
  id: uuid PK
  name: string
  season: int
  commissioner_user_id: uuid FK(User)
  commissioner_password_hash: string
  host_password_hash: string nullable
  commissioner_team_id: uuid FK(Team) nullable
  logo_asset_uri: string nullable
  auth_epoch: int
  status: enum[DRAFT, ACTIVE, ARCHIVED]
  created_at: timestamp
```

`commissioner_team_id`, if set, is the team the commissioner also drafts as; see §3.6. `auth_epoch` is bumped to revoke every previously issued commissioner/host session token for this league (commissioner password change, or an explicit revoke action). `RosterConfiguration`, `ScoringConfiguration`, and `AuctionConfiguration` are *not* referenced from League — each of those three carries `league_id` and a `UNIQUE(league_id)` constraint instead (§4.1, §5.1, §6.1), so a League row can be inserted before its configs exist without a circular non-nullable FK.

### 3.2 User

```yaml
User:
  id: uuid PK
  email: string nullable unique
  display_name: string
  created_at: timestamp
```

**MVP note:** identity is team/role-granularity, not person-granularity, and rows are created deterministically at setup, not lazily per login. League setup creates exactly one `User` (and one `Membership`, role `COMMISSIONER`) for the commissioner, one `User`+`Membership` per `Team` (role `OWNER`), and one more (role `HOST`) if `League.host_password_hash` is set. A shared password authenticates *into* one of these identities; it does not create a new one per session. `email` is unused for MVP login and becomes required once magic-link authentication (future) is enabled — see also `Team.owner_email` (§3.3) for the narrower, already-needed case of where to email a Draft Summary Report.

### 3.3 Team

```yaml
Team:
  id: uuid PK
  league_id: uuid FK(League)
  name: string
  team_password_hash: string
  owner_email: string nullable
  auth_epoch: int
  starting_budget_override_minor: int nullable
  draft_order: int
  status: enum[ACTIVE, INACTIVE]
  created_at: timestamp
```

**Invariant:** Effective starting budget = team override if present, otherwise AuctionConfiguration default. `auth_epoch` is bumped to revoke every previously issued session token for this team (team password change, or commissioner "invalidate this team's sessions" action — see §3.6). `owner_email` is optional and only used if the commissioner enables external email delivery of the Draft Summary Report (§19.7); it is never required for login.

### 3.4 Membership

```yaml
Membership:
  id: uuid PK
  league_id: uuid FK(League)
  team_id: uuid FK(Team) nullable
  user_id: uuid FK(User)
  role: enum[COMMISSIONER, HOST, OWNER]
  active: bool
```

Created deterministically alongside `User` at setup (§3.2), not per login.

### 3.5 TeamMedia

```yaml
TeamMedia:
  team_id: uuid PK/FK(Team)
  icon_asset_uri: string nullable
  nomination_audio_asset_uri: string nullable
  nomination_audio_duration_ms: int nullable
  updated_by_user_id: uuid FK(User)
  updated_at: timestamp
```

**Constraints:**
- audio must be MP3 or explicitly supported audio MIME;
- playback is capped at 5000 ms;
- media is presentation-only;
- uploaded files are validated server-side for MIME type and size before storage.

### 3.6 Authentication (MVP)

Not a domain entity: the site-wide password is deployment/server configuration (a single hashed secret), not a database row.

**Login sequence:** site password → select League → then one of:
- **Commissioner:** enter `League.commissioner_password_hash` match. If `League.commissioner_team_id` is set, the issued token also carries that `team_id`, granting the same session both commissioner console access and normal owner bidding rights for that team — see decision below on combined sessions.
- **Owner:** select Team → enter `Team.team_password_hash` match.
- **Host** (if `League.host_password_hash` is set): enter it directly at the League step. Host is presentation-only (§4.3 of the PRD); it never receives mutation privileges regardless of what the token otherwise carries.

**Session token:** HMAC-signed (e.g. JWT with `HS256` pinned and algorithm verification enforced server-side — never accept `alg: none`), signed with a server-generated random secret independent of any user-facing password. Claims: `{role, league_id, team_id?, league_auth_epoch, team_auth_epoch?, iat, exp}`. Expiry (`exp`) is approximately 48 hours, enough to cover a draft night with margin. No separate session table is required; `DraftClientSession` (§11.3) tracks live draft *connections* specifically, not general auth state.

**Revocation:** every command and every WS connection re-checks `league_auth_epoch == League.auth_epoch` (and `team_auth_epoch == Team.auth_epoch` when `team_id` is present) and rejects on mismatch. Changing a league/team/host password, or an explicit commissioner "invalidate this team's session" action, bumps the corresponding `auth_epoch`, which immediately invalidates every previously issued token for that scope — this is the revocation mechanism; there is no per-token blocklist.

**Cross-league authorization:** every WS connection and every subsequent command resolves its target `draft_id` to a `league_id` and rejects unless it equals the token's `league_id`. Team-scoped commands additionally require the command's `team_id` to equal the token's `team_id`, or the token's `role` to be `COMMISSIONER` for that same league (covers `COMMISSIONER_FOR_OWNER` bids/nominations). This check runs on every command, not only at login or at WS connect.

**WebSocket handshake:** the token is presented as the first message on the socket (an `AUTH` message inside the Phase 0 envelope), not as a query parameter (query strings leak into proxy/access logs). The server closes the socket if no valid `AUTH` arrives within ~5 seconds, and closes it immediately if a presented token is expired or fails the epoch check.

**Transport:** all HTTP and WebSocket traffic uses TLS (`https`/`wss`) in any non-localhost deployment; tokens and passwords are never sent over plaintext transport.

**Rate limiting:** an in-memory limiter applies to all three password checks (site, league/commissioner, team) — e.g. 5 failures per IP+target per minute with backoff — to blunt online guessing against what will often be low-entropy, human-chosen passwords.

**Password generation:** the commissioner setup UI generates site/league/host/team passwords by default (random words or characters), shown once for the commissioner to distribute; manual override is allowed. This converts weak-shared-password risk into random-secret risk at zero UX cost, since these passwords were always going to be distributed out-of-band (text, group chat) rather than memorized.

**Storage:** all passwords are stored hashed (bcrypt or argon2id), never in plaintext.

---

## 4. Roster Rules

### 4.1 RosterConfiguration

```yaml
RosterConfiguration:
  id: uuid PK
  league_id: uuid FK(League) UNIQUE
  total_roster_size: int
  total_starter_slots: int
  bench_slots: int
  require_full_roster: bool
```

**Invariant:**
`total_roster_size == total_starter_slots + bench_slots` unless future reserve/IR slot types are added explicitly.

### 4.2 RosterSlotDefinition

One row per slot type, not per physical ordinal.

```yaml
RosterSlotDefinition:
  id: uuid PK
  roster_configuration_id: uuid FK(RosterConfiguration)
  slot_code: string
  display_name: string
  count: int
  is_starter: bool
  assignment_priority: int
  eligibility_rule_json: json
  required: bool
  sort_order: int
```

Example:

```yaml
- slot_code: WR
  count: 2
  is_starter: true
  assignment_priority: 10
  eligibility: [WR]

- slot_code: OFF_FLEX
  count: 1
  is_starter: true
  assignment_priority: 20
  eligibility: [QB, RB, WR, TE]

- slot_code: BENCH
  count: 8
  is_starter: false
  assignment_priority: 100
  eligibility: [ANY_ROSTER_ELIGIBLE]
```

### 4.3 Starter-first assignment rule

For a newly acquired player:

```text
eligible_unfilled_starter_slots =
  all unfilled starter slots accepting player's eligibility

if any:
  choose lowest assignment_priority
  then lowest ordinal
else:
  assign first available bench ordinal
```

**Important:** Do not reshuffle prior assignments to maximize projected points.

---

## 5. Scoring Rules

### 5.1 ScoringConfiguration

```yaml
ScoringConfiguration:
  id: uuid PK
  league_id: uuid FK(League) UNIQUE
  name: string
  scoring_family: string  # e.g. STANDARD_NON_PPR
```

### 5.2 ScoringRule

```yaml
ScoringRule:
  id: uuid PK
  scoring_configuration_id: uuid FK(ScoringConfiguration)
  stat_code: string
  points_per_unit: decimal
  threshold_json: json nullable
```

---

## 6. Auction Configuration

### 6.1 AuctionConfiguration

```yaml
AuctionConfiguration:
  id: uuid PK
  league_id: uuid FK(League) UNIQUE

  default_starting_budget_minor: int
  minimum_acquisition_price_minor: int

  nomination_timer_ms: int
  second_bid_timer_ms: int
  rebid_timer_ms: int

  anti_snipe_enabled: bool
  anti_snipe_mode: enum[INFO, WARN, ENFORCE] nullable
  anti_snipe_threshold_ms: int nullable
  anti_snipe_count_threshold: int nullable
  anti_snipe_penalty_min_remaining_ms: int nullable
  anti_snipe_penalty_auctions: int nullable

  nominator_match_enabled: bool

  owners_can_rename_team: bool
  disconnect_auto_agent_delay_ms: int

  primary_aav_source_id: uuid FK(AAVSource) nullable
  secondary_aav_source_id: uuid FK(AAVSource) nullable
```

### 6.2 AutoAgentLeagueDefaults

```yaml
AutoAgentLeagueDefaults:
  auction_configuration_id: uuid PK/FK(AuctionConfiguration)
  random_variance_pct: decimal
  max_over_base_pct_default: decimal
  bench_value_pct_default: decimal
  prioritize_starters_default: bool
```

---

## 7. Player Master and Data Sources

### 7.1 Player

```yaml
Player:
  id: uuid PK
  canonical_key: string unique
  first_name: string
  last_name: string
  display_name: string
  nfl_team: string nullable
  bye_week: int nullable
  active_status: string
```

### 7.2 PlayerPositionEligibility

```yaml
PlayerPositionEligibility:
  player_id: uuid FK(Player)
  season: int
  position_code: string
  PK: [player_id, season, position_code]
```

### 7.3 ProviderPlayerMapping

```yaml
ProviderPlayerMapping:
  player_id: uuid FK(Player)
  provider_code: string
  season: int
  external_player_id: string nullable
  external_name: string
  confidence: decimal
  verified: bool
  PK: [player_id, provider_code, season]
```

### 7.4 DataSource

```yaml
DataSource:
  id: uuid PK
  code: string unique
  name: string
  source_type: enum[API, CSV, PDF, MANUAL]
```

### 7.5 DraftDataset

```yaml
DraftDataset:
  id: uuid PK
  league_id: uuid FK(League)
  season: int
  version: string
  status: enum[DRAFT, VALIDATED, FROZEN]
  frozen_at: timestamp nullable
  created_at: timestamp
```

### 7.6 DatasetImport

```yaml
DatasetImport:
  id: uuid PK
  draft_dataset_id: uuid FK(DraftDataset)
  data_source_id: uuid FK(DataSource)
  import_type: enum[PLAYER_MASTER, HISTORICAL_STATS, PROJECTIONS, STATUS, TIER, AAV]
  source_date: date nullable
  imported_at: timestamp
  source_artifact_uri: string nullable
  exact_matches: int
  probable_matches: int
  ambiguous_matches: int
  unmatched_rows: int
  status: enum[LOADED, NEEDS_REVIEW, VALIDATED, FAILED]
```

---

## 8. Player Facts / Intelligence

### 8.1 PlayerSeasonStats

```yaml
PlayerSeasonStats:
  draft_dataset_id: uuid FK(DraftDataset)
  player_id: uuid FK(Player)
  data_source_id: uuid FK(DataSource)
  stats_json: json
  calculated_fantasy_points: decimal nullable
  PK: [draft_dataset_id, player_id, data_source_id]
```

### 8.2 PlayerProjection

```yaml
PlayerProjection:
  draft_dataset_id: uuid FK(DraftDataset)
  player_id: uuid FK(Player)
  data_source_id: uuid FK(DataSource)
  projected_stats_json: json
  projected_fantasy_points: decimal
  source_updated_at: timestamp nullable
  imported_at: timestamp
  PK: [draft_dataset_id, player_id, data_source_id]
```

### 8.3 PlayerStatus

```yaml
PlayerStatus:
  id: uuid PK
  draft_dataset_id: uuid FK(DraftDataset)
  player_id: uuid FK(Player)
  data_source_id: uuid FK(DataSource)
  nfl_status: string nullable
  injury_status: string nullable
  injury_description: string nullable
  practice_status: string nullable
  depth_chart_status: string nullable
  source_updated_at: timestamp nullable
  imported_at: timestamp
```

### 8.4 PlayerTier

```yaml
PlayerTier:
  draft_dataset_id: uuid FK(DraftDataset)
  player_id: uuid FK(Player)
  data_source_id: uuid FK(DataSource)
  position_context: string
  tier_number: int
  PK: [draft_dataset_id, player_id, data_source_id, position_context]
```

---

## 9. AAV

### 9.1 AAVSource

```yaml
AAVSource:
  id: uuid PK
  draft_dataset_id: uuid FK(DraftDataset)
  data_source_id: uuid FK(DataSource)
  display_name: string
  scoring_format: string nullable
  team_count: int nullable
  roster_description: string nullable
  budget_basis_minor: int nullable
  source_date: date nullable
  source_artifact_uri: string nullable
```

### 9.2 PlayerAAV

```yaml
PlayerAAV:
  aav_source_id: uuid FK(AAVSource)
  player_id: uuid FK(Player)
  value_minor: int
  PK: [aav_source_id, player_id]
```

**Invariant:** AAV values are static within a frozen DraftDataset.

---

## 10. Owner Private Strategy

### 10.1 OwnerPlayerTarget

```yaml
OwnerPlayerTarget:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  target_value_minor: int
  is_customized: bool
  updated_at: timestamp
  PK: [draft_id, team_id, player_id]
```

### 10.2 WatchListEntry

```yaml
WatchListEntry:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  sort_order: int nullable
  note: string nullable
```

**Invariant:** Watch List never auto-nominates.

### 10.3 NominationQueueEntry

```yaml
NominationQueueEntry:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  sort_order: int
  opening_bid_minor: int nullable
```

### 10.4 DoNotDraftEntry

```yaml
DoNotDraftEntry:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  PK: [draft_id, team_id, player_id]
```

### 10.5 AutoAgentConfiguration

```yaml
AutoAgentConfiguration:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)

  use_owner_target_when_customized: bool
  fallback_to_primary_aav: bool

  max_over_base_pct: decimal
  random_variance_pct: decimal
  bench_value_pct: decimal
  prioritize_starters: bool

  updated_at: timestamp

  PK: [draft_id, team_id]
```

**Design intent:** simple, explainable automation. Not an optimizer.

---

## 11. Live Draft

### 11.1 Draft

```yaml
Draft:
  id: uuid PK
  league_id: uuid FK(League)
  draft_dataset_id: uuid FK(DraftDataset)
  scheduled_start_at: timestamp nullable
  status: enum[UPCOMING, RUNNING, PAUSED, COMPLETE]
  current_nomination_team_id: uuid FK(Team) nullable
  current_player_auction_id: uuid FK(PlayerAuction) nullable
  state_version: bigint
  started_at: timestamp nullable
  completed_at: timestamp nullable
```

**Invariant:** at most one non-`COMPLETE` Draft exists per League at a time (`UNIQUE(league_id) WHERE status != 'COMPLETE'`).

### 11.2 DraftTeamState

Materialized/live state. Ledger/events remain durable authorities.

```yaml
DraftTeamState:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)

  control_mode: enum[MANUAL, AUTO_AGENT]
  control_mode_reason: enum[USER_ENABLED, COMMISSIONER_ENABLED, DISCONNECTED] nullable
  control_mode_changed_at: timestamp

  connection_state: enum[CONNECTED, RECONNECTING, DISCONNECTED]
  connected_session_count: int
  reconnect_deadline_at: timestamp nullable

  starting_budget_minor: int
  remaining_budget_minor: int

  roster_count: int
  remaining_roster_slots: int
  starter_slots_filled: int
  starter_slots_remaining: int
  max_legal_bid_minor: int

  anti_snipe_penalty_remaining_auctions: int
  anti_snipe_strike_count: int

  nomination_eligible: bool
  roster_complete: bool

  state_version: bigint

  PK: [draft_id, team_id]
```

### 11.3 DraftClientSession

```yaml
DraftClientSession:
  id: uuid PK
  draft_id: uuid FK(Draft)
  user_id: uuid FK(User)
  team_id: uuid FK(Team) nullable
  view_role: enum[DRAFT_VIEW, WAR_ROOM, COMMISSIONER, HOST]
  connected: bool
  connected_at: timestamp
  last_seen_at: timestamp
  disconnected_at: timestamp nullable
  measured_latency_ms: int nullable
```

`user_id` now references a stable, deterministically-created identity (§3.2) — the team's User for owner sessions, the commissioner's User for commissioner sessions (which may simultaneously carry `team_id` if `League.commissioner_team_id` is set, §3.6) — not a per-session throwaway row.

**Disconnect invariant:** team is considered disconnected only when no valid owner/team session remains connected. A commissioner session carrying `team_id` counts toward that team's connected-session total exactly like an ordinary owner session.

### 11.4 TeamDraftMediaState

```yaml
TeamDraftMediaState:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  first_nomination_audio_played_at: timestamp nullable
  PK: [draft_id, team_id]
```

---

## 12. PlayerAuction

```yaml
PlayerAuction:
  id: uuid PK
  draft_id: uuid FK(Draft)
  player_id: uuid FK(Player)
  nominating_team_id: uuid FK(Team)
  opening_bid_minor: int

  state: enum[
    SECOND_BID_OPEN,
    REBID_OPEN,
    PAUSED,
    RESOLVING,
    AWARDED,
    REVERSED
  ]

  high_bid_team_id: uuid FK(Team) nullable
  high_bid_minor: int
  accepted_bid_sequence: bigint

  opened_at: timestamp
  deadline_at: timestamp
  paused_remaining_ms: int nullable
  resolved_at: timestamp nullable

  auction_version: bigint
```

**Important invariant:** normally an accepted bid increases amount. A legal `MATCH` may change `high_bid_team_id` while keeping `high_bid_minor` unchanged. A price-only correction (§17.5) updates `high_bid_minor` in place while the auction stays `AWARDED`; `REVERSED` is reserved for a pick undone by rollback.

**Invariant:** at most one `PlayerAuction` per Draft is in a non-terminal state (`SECOND_BID_OPEN`, `REBID_OPEN`, `PAUSED`, `RESOLVING`) at a time — enforceable as a partial unique index on `draft_id` scoped to those states.

---

## 13. Nominator Match

```yaml
NominatorMatchRight:
  player_auction_id: uuid PK/FK(PlayerAuction)
  nominating_team_id: uuid FK(Team)
  available: bool
  consumed_at: timestamp nullable
  consumed_by_bid_attempt_id: uuid FK(BidAttempt) nullable
```

Match is available only while bidding is open and is consumed at most once. It is scoped to one `PlayerAuction`: if that auction is later reversed by rollback and the slot is re-nominated, the new `PlayerAuction` gets its own fresh `NominatorMatchRight` — nothing carries forward.

---

## 14. BidAttempt

```yaml
BidAttempt:
  id: uuid PK
  player_auction_id: uuid FK(PlayerAuction)
  team_id: uuid FK(Team)

  bid_type: enum[
    PLUS_ONE,
    CUSTOM,
    MATCH,
    AUTO_AGENT,
    COMMISSIONER_FOR_OWNER
  ]

  requested_amount_minor: int
  previous_bid_minor: int

  client_displayed_bid_minor: int nullable
  client_auction_version: bigint nullable
  server_auction_version_before: bigint
  server_auction_version_after: bigint nullable

  client_clicked_at: timestamp nullable
  server_received_at: timestamp
  server_processed_at: timestamp

  time_remaining_at_receipt_ms: int
  measured_latency_ms: int nullable

  accepted: bool
  rejection_reason: string nullable

  became_high_bidder: bool
  triggered_timer_reset: bool
  sniping_event: bool

  session_id: uuid FK(DraftClientSession) nullable
  idempotency_key: string
  accepted_sequence: bigint nullable
```

**Unique:** `(player_auction_id, team_id, idempotency_key)` or equivalent command identity.

**Invariant:** `session_id` is required (non-null) for every human-originated `bid_type` (`PLUS_ONE`, `CUSTOM`, `MATCH`, `COMMISSIONER_FOR_OWNER`); it is nullable only for `AUTO_AGENT`, which originates server-side. This is what makes a `COMMISSIONER_FOR_OWNER` bid attributable to the specific commissioner session that placed it, not just to the `bid_type` enum.

---

## 15. Acquisition and Roster

### 15.1 Acquisition

```yaml
Acquisition:
  id: uuid PK
  draft_id: uuid FK(Draft)
  player_auction_id: uuid FK(PlayerAuction)
  player_id: uuid FK(Player)
  team_id: uuid FK(Team)
  purchase_price_minor: int
  resolution_sequence: bigint
  acquired_at: timestamp
  active: bool
```

**Invariants:**
- one active acquisition per `(draft_id, player_id)` (partial unique index: `UNIQUE(draft_id, player_id) WHERE active`);
- `resolution_sequence` is monotonic per `draft_id`, assigned once when the pick is originally resolved, and is the ordering basis for both LIFO rollback and the price-correction legality replay (§17.5);
- a price-only correction supersedes this row (deactivates it, inserts a new active row for the same `player_auction_id`/`player_id`/`team_id` carrying the *same* `resolution_sequence`); a winner or player change is never represented by mutating or superseding this row directly — it only happens via rollback plus re-award, which is a normal new resolution with a new `resolution_sequence`.

### 15.2 RosterEntry

One row per acquired player.

```yaml
RosterEntry:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  acquisition_id: uuid FK(Acquisition)

  roster_slot_definition_id: uuid FK(RosterSlotDefinition)
  slot_ordinal: int
  is_starter_assignment: bool

  active: bool
  assigned_at: timestamp
```

**Assignment invariant:** use starter-first deterministic algorithm; do not optimize prior roster assignments. A superseding `Acquisition` (price correction) carries a superseding `RosterEntry` with the identical slot assignment — price does not change eligibility, so the slot never needs to be recomputed.

---

## 16. Budget Ledger

```yaml
BudgetLedgerEntry:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  delta_minor: int
  reason_type: enum[
    STARTING_BUDGET,
    ACQUISITION,
    COMMISSIONER_ADJUSTMENT,
    CORRECTION,
    CORRECTION_REVERSAL,
    WHAMMY,
    ROLLBACK_COMPENSATION
  ]
  reference_id: uuid nullable
  event_sequence: bigint
  created_at: timestamp
```

`reference_id` points at the row that produced the entry: the `Acquisition.id` for `ACQUISITION`/`CORRECTION`/`CORRECTION_REVERSAL`/`ROLLBACK_COMPENSATION`, the `CommissionerAction.id` for `COMMISSIONER_ADJUSTMENT`, and the `WhammyEvent.id` for `WHAMMY`.

Remaining budget must reconcile to the sum of a team's ledger entries for the draft — there is no timeline to scope by, since the model is append-only (§17.2).

---

## 17. Event / Recovery Model

### 17.1 DraftEvent

```yaml
DraftEvent:
  draft_id: uuid FK(Draft)
  sequence: bigint
  event_type: string
  actor_user_id: uuid FK(User) nullable
  actor_team_id: uuid FK(Team) nullable
  payload_json: json
  created_at: timestamp
  PK: [draft_id, sequence]
```

**Transactionality (load-bearing, not optional):** every committed state mutation — bid acceptance, resolution, pause/resume, control-mode change, correction, each rollback undo step, Whammy application — appends its `DraftEvent` row(s) in the *same* Postgres transaction as its other row-level effects. There is never a separate write for the event log; if the transaction commits, the event exists, and if it doesn't, neither do the rows it would describe. `sequence` is allocated from a per-draft monotonic counter inside that same transaction (e.g. `UPDATE draft SET state_version = state_version + 1 RETURNING state_version`); the returned value is both the new `Draft.state_version` and the `DraftEvent.sequence` for that mutation's event(s). This is what makes WS reconnect replay (by sequence) trustworthy: the event log and the materialized rows can never diverge.

### 17.2 Append-Only Model (no timeline entity)

An earlier revision of this document modeled rollback as branching into a new `DraftTimeline`. That's gone: there is exactly one continuously growing history per `Draft`, and "never mutate history" is achieved by superseding rows (mark old ones `active = false`, insert new ones) rather than by branching into parallel timelines. No `DraftTimeline` or `DraftCheckpoint` entity exists, and nothing in the schema carries a `timeline_id`. See §17.5 for the mechanics.

### 17.3 CommissionerAction

```yaml
CommissionerAction:
  id: uuid PK
  draft_id: uuid FK(Draft)
  actor_user_id: uuid FK(User)
  action_type: string
  reason: string
  before_state_json: json nullable
  after_state_json: json nullable
  event_sequence: bigint
  idempotency_key: string
  created_at: timestamp
```

**Unique:** `(draft_id, idempotency_key)` — a double-submitted correction or rollback command must not double-apply.

### 17.5 Rollback and Correction Model

MVP is append-only (§17.2): no branching, no arbitrary-point state reconstruction. There are exactly two ways to fix an already-awarded pick.

**Price-only correction (in-place).** The *only* correction that happens in place. It applies to any already-awarded pick regardless of how many picks the team has made since — the gate is legality, not chronology. Mechanics: deactivate the existing `Acquisition` and its `RosterEntry`; append a reversing `BudgetLedgerEntry` (`CORRECTION_REVERSAL`, +old price) and a new one (`CORRECTION`, −new price); insert a new active `Acquisition` (same `player_id`/`team_id`/`player_auction_id`/`resolution_sequence`) and a new `RosterEntry` (same slot — a price change never changes eligibility); update `PlayerAuction.high_bid_minor` to the corrected price, leaving its state `AWARDED`. Before committing: replay the team's ledger forward from this pick's `resolution_sequence` under the corrected price — if any later pick by this team would violate the max-legal-bid/reserve invariant, **reject the correction and require rollback instead.**

**Winner or player changes.** Never done in place. Any change to which team won a pick, or which player was awarded, requires rollback: undo the target pick and everything resolved after it (below), then re-award each undone slot in order — the corrected one first — via the ordinary nomination/resolution path or the commissioner's manual-award live control.

**Rollback.** Applies whenever more than a price needs fixing, or more than one pick needs undoing. **Requires `Draft.status == PAUSED`** — the commissioner pauses first (or the UI auto-pauses on entering the rollback flow) so no auction is open while history is being rewritten. The preview is pinned to the `state_version` it was computed from; if `state_version` has advanced by the time the commissioner confirms, the preview is stale and must be retaken. Undo then proceeds strictly in reverse `resolution_sequence` order, as **one Postgres transaction** (all-or-nothing — "one at a time" describes ordering inside that transaction, not N separate commits): for each `Acquisition` being undone, mark it `active = false`, append a `ROLLBACK_COMPENSATION` `BudgetLedgerEntry`, deactivate its `RosterEntry`, mark its `PlayerAuction` `REVERSED` — once the earliest undone pick is reached, restore the `Draft`'s nomination cursor to that team's turn. The player(s) return to available. After commit, the commissioner UI offers a **re-apply assist**: the just-undone picks, in their original order, each one click away from being re-awarded via manual award (with the erroneous one editable before re-awarding) — this reuses the existing manual-award control, no new engine machinery.

Undo points are implicit and ordered by `Acquisition.resolution_sequence` — no separate checkpoint entity is required.

---

## 18. Whammy

### 18.1 WhammyConfiguration

```yaml
WhammyConfiguration:
  id: uuid PK
  league_id: uuid FK(League)
  enabled: bool
  allow_positive: bool
  allow_negative: bool
  max_per_team: int nullable
  max_per_draft: int nullable
  commissioner_approval_required: bool
```

### 18.2 WhammyDefinition

```yaml
WhammyDefinition:
  id: uuid PK
  whammy_configuration_id: uuid FK(WhammyConfiguration)
  name: string
  type: enum[POSITIVE, NEGATIVE]
  budget_delta_minor: int nullable
  trigger_rule_json: json nullable
  display_message: string
  offline_action_text: string nullable
  weight: decimal
  active: bool
```

### 18.3 WhammyEvent

```yaml
WhammyEvent:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team) nullable
  definition_id: uuid FK(WhammyDefinition)
  trigger_event_sequence: bigint
  budget_ledger_entry_id: uuid FK(BudgetLedgerEntry) nullable
  status: enum[PENDING_APPROVAL, APPLIED, REJECTED, REVERSED]
  created_at: timestamp
```

A Whammy's budget effect is reversed generically by rollback (§17.5) if the rollback undoes past its `trigger_event_sequence` — the ledger entry it produced is just another `BudgetLedgerEntry` on the team's account, undone the same way any other entry after the rollback point is undone. Nothing Whammy-specific is needed in the rollback logic.

---

## 19. Post-Draft / ESPN

### 19.1 DraftTeamEvaluation

```yaml
DraftTeamEvaluation:
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  projected_drafted_starter_points: decimal
  roster_depth_metric: decimal nullable
  aav_efficiency: decimal nullable
  calculation_version: string
  PK: [draft_id, team_id]
```

### 19.2 ProviderTeamMapping

```yaml
ProviderTeamMapping:
  league_id: uuid FK(League)
  provider_code: string
  team_id: uuid FK(Team)
  external_team_id: string nullable
  external_team_name: string
  verified: bool
  PK: [league_id, provider_code, team_id]
```

### 19.3 ExportJob

```yaml
ExportJob:
  id: uuid PK
  draft_id: uuid FK(Draft)
  provider_code: string
  schema_version: string
  status: enum[PENDING, VALIDATED, GENERATED, FAILED]
  artifact_uri: string nullable
  artifact_checksum: string nullable
  validation_json: json
  created_at: timestamp
```

### 19.4 ReconciliationItem

```yaml
ReconciliationItem:
  id: uuid PK
  export_job_id: uuid FK(ExportJob)
  team_id: uuid FK(Team)
  player_id: uuid FK(Player)
  recommended_target_slot: string nullable
  status: enum[PENDING, CONFIRMED, AMBIGUOUS, FAILED]
  confirmed_by_user_id: uuid FK(User) nullable
  confirmed_at: timestamp nullable
```

### 19.5 DraftSummaryReport (league-level)

```yaml
DraftSummaryReport:
  id: uuid PK
  draft_id: uuid FK(Draft)
  generated_at: timestamp
  league_summary_json: json
```

Visible to every owner in the league, not commissioner-only — the underlying data (purchase prices, rosters) was already broadcast live during the draft, so there's nothing newly exposed by the league summary.

### 19.6 DraftTeamReport (per-team)

```yaml
DraftTeamReport:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team)
  report_json: json
```

**Unique:** `(draft_id, team_id)`. Split out from the league-level report so per-team access control is a normal row-level check, not a slice of a shared JSON blob.

### 19.7 ReportDeliveryAttempt

```yaml
ReportDeliveryAttempt:
  id: uuid PK
  draft_id: uuid FK(Draft)
  team_id: uuid FK(Team) nullable
  recipient_email: string
  status: enum[PENDING, SENT, FAILED, SKIPPED_EMAIL_DISABLED]
  sent_at: timestamp nullable
  error_detail: string nullable
```

`team_id` null identifies the commissioner/league-wide copy (delivers `DraftSummaryReport`); `team_id` set delivers that team's `DraftTeamReport`. `recipient_email` is read from `Team.owner_email` (§3.3) for team copies and from the commissioner's `User.email` for the league-wide copy — both optional fields the commissioner fills in only if email delivery will be used.

---

## 20. Mermaid ERD

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : has
    LEAGUE ||--o{ MEMBERSHIP : contains
    LEAGUE ||--o{ TEAM : contains
    TEAM ||--o{ MEMBERSHIP : represented_by
    TEAM ||--o| TEAM_MEDIA : presents_as

    LEAGUE ||--|| ROSTER_CONFIGURATION : uses
    ROSTER_CONFIGURATION ||--o{ ROSTER_SLOT_DEFINITION : defines
    LEAGUE ||--|| SCORING_CONFIGURATION : uses
    SCORING_CONFIGURATION ||--o{ SCORING_RULE : contains
    LEAGUE ||--|| AUCTION_CONFIGURATION : uses
    AUCTION_CONFIGURATION ||--o| AUTO_AGENT_LEAGUE_DEFAULTS : defaults

    LEAGUE ||--o{ DRAFT_DATASET : has
    DRAFT_DATASET ||--o{ DATASET_IMPORT : records
    DATA_SOURCE ||--o{ DATASET_IMPORT : supplies

    PLAYER ||--o{ PLAYER_POSITION_ELIGIBILITY : eligible_as
    PLAYER ||--o{ PROVIDER_PLAYER_MAPPING : maps_to
    DRAFT_DATASET ||--o{ PLAYER_SEASON_STATS : contains
    DRAFT_DATASET ||--o{ PLAYER_PROJECTION : contains
    DRAFT_DATASET ||--o{ PLAYER_STATUS : contains
    DRAFT_DATASET ||--o{ PLAYER_TIER : contains
    PLAYER ||--o{ PLAYER_SEASON_STATS : has
    PLAYER ||--o{ PLAYER_PROJECTION : has
    PLAYER ||--o{ PLAYER_STATUS : has
    PLAYER ||--o{ PLAYER_TIER : has

    DRAFT_DATASET ||--o{ AAV_SOURCE : contains
    AAV_SOURCE ||--o{ PLAYER_AAV : values
    PLAYER ||--o{ PLAYER_AAV : receives

    LEAGUE ||--o{ DRAFT : runs
    DRAFT_DATASET ||--o{ DRAFT : powers
    DRAFT ||--o{ DRAFT_TEAM_STATE : has
    TEAM ||--o{ DRAFT_TEAM_STATE : participates
    DRAFT ||--o{ DRAFT_CLIENT_SESSION : connects
    USER ||--o{ DRAFT_CLIENT_SESSION : opens
    TEAM ||--o{ DRAFT_CLIENT_SESSION : controls
    DRAFT ||--o{ TEAM_DRAFT_MEDIA_STATE : tracks
    TEAM ||--o{ TEAM_DRAFT_MEDIA_STATE : owns

    DRAFT ||--o{ OWNER_PLAYER_TARGET : stores
    TEAM ||--o{ OWNER_PLAYER_TARGET : owns
    PLAYER ||--o{ OWNER_PLAYER_TARGET : targets

    DRAFT ||--o{ WATCH_LIST_ENTRY : stores
    TEAM ||--o{ WATCH_LIST_ENTRY : owns
    PLAYER ||--o{ WATCH_LIST_ENTRY : watches

    DRAFT ||--o{ NOMINATION_QUEUE_ENTRY : stores
    TEAM ||--o{ NOMINATION_QUEUE_ENTRY : owns
    PLAYER ||--o{ NOMINATION_QUEUE_ENTRY : queues

    DRAFT ||--o{ DO_NOT_DRAFT_ENTRY : stores
    TEAM ||--o{ DO_NOT_DRAFT_ENTRY : owns
    PLAYER ||--o{ DO_NOT_DRAFT_ENTRY : excludes

    DRAFT ||--o{ AUTO_AGENT_CONFIGURATION : configures
    TEAM ||--o{ AUTO_AGENT_CONFIGURATION : owns

    DRAFT ||--o{ PLAYER_AUCTION : contains
    PLAYER ||--o{ PLAYER_AUCTION : auctioned_as
    TEAM ||--o{ PLAYER_AUCTION : nominates

    PLAYER_AUCTION ||--|| NOMINATOR_MATCH_RIGHT : grants
    PLAYER_AUCTION ||--o{ BID_ATTEMPT : receives
    TEAM ||--o{ BID_ATTEMPT : submits
    DRAFT_CLIENT_SESSION ||--o{ BID_ATTEMPT : originates

    PLAYER_AUCTION ||--o{ ACQUISITION : resolves_to
    PLAYER ||--o{ ACQUISITION : acquired
    TEAM ||--o{ ACQUISITION : wins

    ACQUISITION ||--o{ ROSTER_ENTRY : creates
    ROSTER_SLOT_DEFINITION ||--o{ ROSTER_ENTRY : assigned_to
    TEAM ||--o{ ROSTER_ENTRY : rosters

    DRAFT ||--o{ BUDGET_LEDGER_ENTRY : records
    TEAM ||--o{ BUDGET_LEDGER_ENTRY : has

    DRAFT ||--o{ DRAFT_EVENT : emits
    DRAFT ||--o{ COMMISSIONER_ACTION : audits

    LEAGUE ||--o| WHAMMY_CONFIGURATION : configures
    WHAMMY_CONFIGURATION ||--o{ WHAMMY_DEFINITION : defines
    DRAFT ||--o{ WHAMMY_EVENT : triggers
    WHAMMY_DEFINITION ||--o{ WHAMMY_EVENT : instantiates

    DRAFT ||--o{ DRAFT_TEAM_EVALUATION : evaluates
    DRAFT ||--o{ EXPORT_JOB : exports
    EXPORT_JOB ||--o{ RECONCILIATION_ITEM : contains
    DRAFT ||--o| DRAFT_SUMMARY_REPORT : produces
    DRAFT ||--o{ DRAFT_TEAM_REPORT : produces
    TEAM ||--o{ DRAFT_TEAM_REPORT : receives
    DRAFT ||--o{ REPORT_DELIVERY_ATTEMPT : deliveries
    TEAM ||--o{ REPORT_DELIVERY_ATTEMPT : receives
```

---

## 21. Critical Invariants for Agents / Developers

```yaml
invariants:
  - "Only one PlayerAuction per Draft is in a non-terminal state at a time."
  - "Only one active Acquisition exists per Draft+Player."
  - "Bid acceptance is server-authoritative."
  - "Relative bids (+$1, Match) reject stale expected bid/version."
  - "Custom bids are exact absolute offers and never auto-increment beyond entered value."
  - "Match can be accepted at most once per PlayerAuction."
  - "Match is the only accepted event allowed to change high bidder without increasing high bid."
  - "PlayerAuction deadline is a server timestamp."
  - "Budget cannot fall below the amount required to fill required remaining roster spots unless commissioner override is explicitly supported."
  - "Roster assignment fills eligible starter slots before Bench."
  - "Roster assignment does not reshuffle prior players to optimize projections."
  - "Watch List never auto-nominates."
  - "Nomination Queue may auto-nominate."
  - "Owner strategy data is private to team and authorized commissioner operations."
  - "AAV is static inside a frozen DraftDataset."
  - "Disconnect Auto-Agent transition occurs only when zero valid team sessions remain connected through the grace deadline."
  - "Reconnection after Auto-Agent takeover does not automatically resume MANUAL."
  - "Auto-Agent mode changes are broadcast and auditable."
  - "Nomination audio plays at most once per Team+Draft and for no more than 5 seconds."
  - "Rollback and correction always append new rows; existing rows are superseded (active = false) but never deleted or mutated in place."
  - "Only a price change may be corrected in place, and only when replaying the winning team's ledger forward under the corrected price confirms every later pick by that team stays legal; a winner or player change always requires rollback."
  - "Rollback always undoes the most recently resolved PlayerAuctions first, in strict reverse resolution_sequence order, as one transaction; it cannot skip to an arbitrary earlier pick without undoing everything after it."
  - "Rollback requires Draft.status == PAUSED, and its preview is pinned to a state_version that must be re-taken if state advances before confirmation."
  - "Acquisition.resolution_sequence is monotonic per draft and is the ordering basis for both rollback and correction-legality replay."
  - "Every committed state mutation writes its DraftEvent row(s) in the same transaction as its other row effects; DraftEvent.sequence and Draft.state_version are the same counter."
  - "On server restart, any Draft found RUNNING is restored as PAUSED, never resumed with an already-expired deadline; explicit commissioner action is required to resume."
  - "At most one non-COMPLETE Draft exists per League at a time."
  - "Every WS connection and command resolves its target draft_id to a league_id and rejects unless it matches the session token's league_id; team-scoped commands additionally require the token's team_id to match or its role to be COMMISSIONER for that league."
  - "Session tokens carry an expiry and a league/team auth_epoch; bumping auth_epoch (password change or explicit revocation) invalidates every previously issued token for that scope."
  - "Each server process may host multiple concurrently RUNNING Drafts across different Leagues; all draft state, timers, and broadcasts are isolated per draft_id."
  - "Passwords (site, league, team, host) are stored hashed, never in plaintext."
  - "Displayed remaining budget reconciles to ledger state."
```
