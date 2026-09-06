## Id
F-MOD-002

## Title
Live Auction Engine with Bid Pipeline

## Module Ref
MOD-002

## Description
MOD-002 implements the real-time auction engine that is the core of the Draft platform. It is the highest-complexity and highest-risk module: every bid, nomination, award, and roster assignment flows through it. The full system context is in `.aah/architecture/architecture-overview.md` §§2–5; the entity schemas for `PlayerAuction`, `BidAttempt`, `DraftEvent`, `DraftTeamState`, `Acquisition`, `RosterEntry`, and `BudgetLedgerEntry` are in `knowledge/data-model.md`; the state machines, bid-atomicity rules, and nomination/resolution sequences are in `knowledge/state-machine-flows.md` §§4, 8, 10, 24–26; and the end-to-end auction command flow is in `.aah/architecture/application-flow.md` §§3–5.

**Stack:** Node.js 20 LTS + TypeScript + Fastify 4.x backend; native `ws` 8.x WebSockets using the sequence-numbered envelope defined in `shared-types/`; PostgreSQL 15 + Drizzle ORM (hybrid raw-SQL for the bid/resolution transaction, query builder for CRUD); React 18 + Vite 5 + TypeScript frontend; Zod 3.x via `shared-types` for all WS command/event validators.

**DB layer** — introduces and owns the following Drizzle schema tables (all append-only; never hard-deleted): `DraftTeamState` (one row per team per draft; `remaining_budget_minor`, roster counts, `control_mode`), `PlayerAuction` (FSM: PENDING → OPEN → CLOSED → AWARDED; `current_bid_minor`, `current_leader_id`, `auction_version`, `rebid_deadline_ts`), `BidAttempt` (every accepted and rejected attempt; `server_receipt_time`, `accepted` bool), `DraftEvent` (append-only audit log; per-draft sequence counter incremented in the same transaction as its row effect), `Acquisition` (winner + `resolution_sequence` + `active` bool), `RosterEntry` (`acquisition_id`, `roster_slot_id`, `active` bool), and `BudgetLedgerEntry` (`amount_minor`, `entry_type=AWARD`, `active` bool). Indexes must cover `(draft_id, status)` on `PlayerAuction`, `(draft_id, sequence)` on `DraftEvent`, and `(draft_id, team_id)` on `DraftTeamState`.

**API layer** — exposes three REST endpoints (`POST /drafts/:id/start`, `POST /drafts/:id/pause`, `POST /drafts/:id/resume`) and the full WS command/event protocol at `wss://{host}/ws/drafts/{draftId}`. All WS commands are routed through a `Map<draft_id, AsyncQueue>` — one command in-flight per draft at a time. The serialized queue is the primary concurrency guard. `server_receipt_time` is stamped as the very first line of the WS message handler, before any `await` or queue enqueue. Each command handler re-reads `auth_epoch` from the DB unconditionally (never from token payload) before executing. The OTel histogram `bid_pipeline_duration_ms` is recorded for every accepted bid command from WS receipt to broadcast, with a p99 target of < 200 ms. Anti-sniping logic: if `server_receipt_time` falls within the configured final-N-seconds window of `rebid_deadline_ts`, the deadline is extended by the configured number of seconds and `anti_snipe_extended: true` is set in the `BID_ACCEPTED` event. Nomination-turn advance (`advanceNominationTurn`) selects the next eligible team (skipping any team with a complete roster) and branches on that team's `DraftTeamState.control_mode`: if `AUTO_AGENT`, the system auto-nominates immediately, with no timer wait; if `MANUAL`, a nomination-turn deadline is started from `AuctionConfiguration.nomination_timer_ms`, and if the owner does not submit a legal `NOMINATE_COMMAND` before it elapses, the system auto-nominates on their behalf. Both auto-nomination paths select a player the same way: (1) the first legal entry in that team's `NominationQueue` at its configured opening amount, if one exists; otherwise (2) `argmax(aav_minor)` among available `PlayerDatasetEntry` rows in the frozen dataset restricted to a position where the team still has an open roster slot (starter or bench) and excluding any player on that team's Do Not Draft list, opened at `AuctionConfiguration.min_bid_minor`. Either path creates the `PlayerAuction` through the same code path as a manual nomination (`processNominateCommand` with `systemNominated: true`), enqueued on the draft's existing `AsyncQueue`, and emits `NOMINATION_STARTED` with `system_nominated: true` — so second-bid timer start, the `DraftEvent` append, and the Auto-Agent reactive-bidding trigger on other `AUTO_AGENT` teams all fire identically to a manual nomination.

**UI layer** — implements two screens in `web/src/screens/`:

- **Draft Room** (`web/src/screens/draft-room/`): nomination timer display (driven by `deadline_ts` from the server; 100 ms `setInterval`; never determines outcome), current bid display, bid controls (absolute dollar input, +$1 relative bid button, Pass Nomination button), player card for the active auction, and a roster sidebar showing the team's current assignments and remaining budget. The bid controls must display the calculated `max_legal_bid` (server-computed: `remaining_budget_minor - ($1 reserve × other required remaining roster spots)`) and reject locally any absolute bid that exceeds it before sending. The +$1 relative-bid button disables itself immediately on click and re-enables only once the pending `BID_ACCEPTED`/`BID_REJECTED` response or a newer auction-state broadcast has been applied to local state — it never fires a second increment computed from stale local state. All server-sent `BID_REJECTED` reason text is dollar-formatted (via the same `formatMoney` helper the UI already uses for displayed amounts) before it reaches the user; no raw `*_minor` integer ever appears in a user-facing message. The Draft Room also always renders: (a) a "Pause Draft" action, visible when the viewing owner is also the commissioner, that calls the existing `POST /drafts/:id/pause` and surfaces Commissioner Console controls; (b) a link to open that owner's War Room (`web/src/screens/war-room/`) as a separate window, and the War Room correspondingly links back to the Draft Room — realizing "Same owner may open both as synchronized windows sharing one team identity"; (c) the viewing owner's own roster-so-far, with starter vs. bench slot status clearly distinguished (which starter slots are filled vs. still open, and bench count), sourced from that team's `RosterEntry` rows and the league's `roster_slot_definitions`, **and, for each filled slot, the acquired player's name and the price paid for him** (`purchase_price_minor` from that player's active `Acquisition`, dollar-formatted) — the same `acquisitions` JOIN `players` data `server/src/draft/reports.ts` already computes for the post-draft summary, exposed live via `GET /drafts/:draftId/roster-grid` (`server/src/draft/war-room.ts`) so each team's `slots` carry player identity and price alongside the existing fill counts. The screen's layout is revisited to use previously-unused space for (a)-(c) rather than adding them as an afterthought.

  The Draft Room additionally renders: **(d) a persistent, position-filterable, sortable player list for nomination**, replacing the current search-only flow. It lists every undrafted `PlayerDatasetEntry` from the frozen dataset (fields already available client-side: `position`, `aav_minor`, `projected_points`), with position-filter tabs derived from the league's `roster_slot_definitions` (All plus one tab per distinct configured position/FLEX group), default-sorted by `aav_minor` descending and `projected_points` descending as a tiebreak. A free-text search remains available to narrow the list further; it does not replace the persistent listing. Selecting a player row while it is the viewing owner's nomination turn nominates that player through the same `NOMINATE_COMMAND` path and `min_bid_minor` default already used for search-result selection — no new nomination code path. **(e) A compact team-by-team strip** across the top of the Draft Room, listing every team in nomination order with team icon/name and remaining budget (from the same `GET /drafts/:draftId/roster-grid` data already powering the roster sidebar), and — whenever a `PlayerAuction` is `OPEN`, the current leading team's entry highlighted with the current bid amount, driven by the same `current_leader_id` and `current_bid_minor` fields the active-auction player card already renders. This strip surfaces every other team's budget in the Draft Room itself (normally a War Room concern) by deliberate product decision — it does not replace or duplicate the War Room's fuller roster/budget tables.
- **Draft Board** (`web/src/screens/draft-board/`): read-only table of all players in the dataset with their `PlayerAuction` status and award price once resolved. Updates in real time from the WS event stream.

**Live-effect configuration** — `AuctionConfiguration.nomination_timer_ms`, `second_bid_timer_ms`, and `rebid_timer_ms` are re-read from the database at the moment each is used (nomination-turn dispatch, second-bid window open, and rebid-deadline extension respectively), never cached at draft-start or server-boot — so a commissioner's mid-draft edit to any of these values takes effect starting with the next auction/turn that reads it, with no restart required.

The countdown timer component derives its display value solely from `server_receipt_time`-anchored `deadline_ts` values in WS events. Client-side time never influences award decisions.

**Behavioral expectations:**

- Given a draft with status `CREATED` and a FROZEN dataset attached, when the commissioner sends `POST /drafts/:id/start`, then the draft status transitions to `RUNNING`, a `DraftEvent` row is inserted with type `DRAFT_STARTED` in the same transaction, and all connected WS clients receive the state update.
- Given a `RUNNING` draft, when the commissioner sends `POST /drafts/:id/pause`, then the draft transitions to `PAUSED` and a `DRAFT_PAUSED` event is appended; when `POST /drafts/:id/resume` is sent, then the draft transitions back to `RUNNING` and a `DRAFT_RESUMED` event is appended.
- Given a `POST /drafts/:id/start` from a non-commissioner JWT, then the server returns HTTP 403 without modifying draft state.
- Given a `RUNNING` draft in the nomination window, when a team sends a `NOMINATE_COMMAND` with a valid `player_dataset_entry_id` and `opening_bid_minor >= 100`, then a `PlayerAuction` row is created with status `OPEN`, `nomination_deadline_ts` and `second_bid_deadline_ts` are set from `AuctionConfiguration`, a `DraftEvent` with type `NOMINATION_STARTED` is committed in the same transaction, and a `NOMINATION_STARTED` event is broadcast to all connected clients.
- Given a `RUNNING` draft, when nomination-turn advance selects a next eligible team whose `control_mode` is `AUTO_AGENT`, then the server auto-nominates on that team's behalf immediately, with no nomination-timer wait: it uses the first legal entry in that team's `NominationQueue` at its configured opening amount if one exists, otherwise the highest-`aav_minor` available player at a position where the team has an open roster slot (starter or bench) and not on that team's Do Not Draft list, opened at `min_bid_minor`; either way a `PlayerAuction` is created via the same path as a manual nomination and `NOMINATION_STARTED` is broadcast with `system_nominated: true`.
- Given a `RUNNING` draft, when the next eligible nominating team's `control_mode` is `MANUAL` and their nomination-turn deadline (`AuctionConfiguration.nomination_timer_ms`) elapses with no `NOMINATE_COMMAND` received, then the server auto-nominates on their behalf using the same selection rule (`NominationQueue` first, then highest-`aav_minor` at a position of open roster need excluding Do Not Draft, at `min_bid_minor`) and broadcasts `NOMINATION_STARTED` with `system_nominated: true`.
- Given a team with a completed roster, when nomination-turn advance runs (whether triggered by an explicit pass, an award, or an auto-nomination), then that team is skipped and never selected as the next nominator.
- Given a `RUNNING` draft with an `OPEN` `PlayerAuction`, when a client sends `BID_COMMAND` with `bid_type: ABSOLUTE` and a `bid_amount_minor` that is greater than `current_bid_minor` and within `max_legal_bid`, then: (1) `server_receipt_time` is stamped before any `await`, (2) the command is enqueued in the draft's `AsyncQueue`, (3) after dequeue, `auth_epoch` is re-read from the DB, (4) the DB transaction commits an update to `PlayerAuction.current_bid_minor`, an `INSERT` into `BidAttempt` with `accepted=true`, and an `INSERT` into `DraftEvent` with type `BID_ACCEPTED` and an incremented per-draft sequence, (5) in-memory state is updated only after commit, (6) `BID_ACCEPTED` is broadcast to all connected clients.
- Given a `BID_COMMAND` with `bid_type: RELATIVE` where `expected_current_bid_minor` or `expected_auction_version` does not match server state, then the server rejects the command with a `BID_REJECTED` event carrying a stale-state error code, and no DB rows are modified.
- Given a bid whose `server_receipt_time` falls within the anti-snipe window at the end of `rebid_deadline_ts`, then the `PlayerAuction.rebid_deadline_ts` is extended by the configured seconds within the same transaction, and `BID_ACCEPTED.anti_snipe_extended` is `true`.
- Given an `OPEN` `PlayerAuction` whose `rebid_deadline_ts` has elapsed with at least one accepted bid, when the server's timer fires (polled every ~500 ms), then: (1) `PlayerAuction.status` transitions to `AWARDED`, (2) `resolution_sequence` is assigned, (3) an `Acquisition` row is inserted with `active=true`, (4) a `BudgetLedgerEntry` is inserted with `entry_type=AWARD` and `amount_minor = -price_minor`, (5) `DraftTeamState.remaining_budget_minor` is decremented, (6) the lowest-priority unfilled starter slot is identified and a `RosterEntry` row is inserted — or bench if no starter slot is available — all within a single DB transaction, (7) `DraftTeamState.roster_filled_count` is incremented, (8) a `DraftEvent` of type `PLAYER_AWARDED` is committed in the same transaction, (9) in-memory state is updated after commit, (10) `PLAYER_AWARDED` is broadcast to all connected clients.
- Given a team whose remaining roster spots require a `$1` reserve for each, when computing `max_legal_bid`, then `max_legal_bid = remaining_budget_minor - (required_remaining_spots - 1) * 100`, computed server-side in integer arithmetic with no floating point.
- Given a bid whose `bid_amount_minor` exceeds `max_legal_bid` for that team, then the server rejects the command with `BID_REJECTED` and an appropriate error code; no DB rows are modified and the `BidAttempt` row records `accepted=false`.
- **Roster-full hard gate (independent of `max_legal_bid`).** `max_legal_bid`'s `$1`-per-remaining-spot reserve formula only protects budget for a team's *other* future picks — it does not by itself mean the team has any roster room left, since `Math.max(0, required_remaining_spots - 1) * 100` is `0` once `required_remaining_spots` reaches `0` or `1`, making `max_legal_bid` equal to the team's full remaining budget even with a completely full roster. Bid validation (`server/src/auction/engine.ts`) MUST therefore check `required_remaining_spots` as a separate, independent gate from the dollar-amount check: given a team whose `DraftTeamState.required_remaining_spots <= 0` (every starter and bench slot already filled), when that team submits any `BID_COMMAND` for any amount, then the server rejects it with a `ROSTER_FULL` code before any DB row is modified, regardless of `bid_amount_minor` or `max_legal_bid` — a team with a full roster can never legally place another bid. The `BidAttempt` row records `accepted=false` with this reason.
- **Award never proceeds without a roster slot.** `assignRosterSlot()` returning no eligible slot for the winning bidder must never happen once the roster-full hard gate above is enforced (a team can only win an auction it was legally allowed to bid on, and it was only allowed to bid because it had `required_remaining_spots > 0`, i.e. an eligible slot exists). As defense-in-depth, `awardAuction()` treats a `null` result from `assignRosterSlot()` as a hard failure (throws, so `processAwardCycle`'s existing per-auction try/catch logs it) rather than silently proceeding to charge the team's budget, increment `roster_filled_count`, and decrement `required_remaining_spots` for a player who is never actually assigned any `RosterEntry`. An acquired player is never "lost" — every active `Acquisition` for a resolved auction has a corresponding active `RosterEntry`.
- Given a `BID_COMMAND` whose JWT carries a `league_id` that does not match the target draft's `league_id`, then the command is rejected with `AUTH_ERROR` before it enters the command queue.
- Given a revoked token (auth_epoch bumped), when any WS command arrives, then the re-read `auth_epoch` from the DB does not match the token payload's `auth_epoch`, and the command is rejected with an `AUTH_EPOCH_INVALID` error.
- Given an accepted bid command, when the `bid_pipeline_duration_ms` OTel histogram is recorded, then the measured duration from WS receipt to broadcast is recorded and the p99 must remain below 200 ms under normal draft load.
- Given the Draft Room screen renders with an active `PlayerAuction`, when a `BID_ACCEPTED` or `PLAYER_AWARDED` event arrives over the WS connection, then the current bid display, countdown timer, and roster sidebar update within one render cycle without a full-page reload.
- Given the viewing owner's team has acquired one or more players during the live draft, when the roster sidebar renders a filled slot, then it shows that player's name and the exact price paid (dollar-formatted from `purchase_price_minor`), not just the slot's fill count; an open (unfilled) slot shows no player/price. When a `PLAYER_AWARDED` event resolves a new pick for this team, the newly filled slot's player name and price appear without a full-page reload.
- Given the Draft Board screen renders, when any `NOMINATION_STARTED`, `BID_ACCEPTED`, or `PLAYER_AWARDED` event arrives, then the affected player's row updates its status and price in place without requiring a manual refresh.
- Given the countdown timer component receives a `deadline_ts` from a server event, then it drives display via `Date.now()` relative to `deadline_ts` on a 100 ms `setInterval`; reaching zero triggers no server action and awards no player.
- Given a client connects with a JWT to `wss://{host}/ws/drafts/{draftId}` and sends `AUTHENTICATE` as the first message, then the server re-reads `auth_epoch` from the DB and either sends `AUTHENTICATED` or closes the connection with code 4401.
- Given `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV` are all set in the environment, when the server boots, then it passes the env checker and starts normally; given any one of these is absent, then the server exits with `ERR_CDR_78_EX_CONFIG` naming every missing variable before any module reads configuration.
- Given a `BID_COMMAND` is rejected for any reason (`BID_TOO_LOW`, `STALE_STATE`, `AUCTION_NOT_OPEN`, or exceeding `max_legal_bid`), when the `BID_REJECTED` reason reaches the Draft Room, then any dollar amount in it is displayed formatted (e.g. `$26`), never as a raw `*_minor` integer (e.g. `2600`).
- Given the Draft Room's +$1 button is clicked, when the resulting `BID_COMMAND` is in flight, then the button is disabled until a `BID_ACCEPTED`, `BID_REJECTED`, or a newer auction-state broadcast is applied to local state, so two rapid clicks (or a click racing an incoming leader change) cannot submit two bids computed from the same stale current-bid value.
- Given a `RUNNING` draft, when the commissioner updates `AuctionConfiguration.nomination_timer_ms`, `second_bid_timer_ms`, or `rebid_timer_ms`, then the next nomination-turn dispatch, second-bid window, or rebid-deadline extension (respectively) uses the new value without any server restart.
- Given the viewing owner is also the commissioner, when the Draft Room renders, then a "Pause Draft" action is visible that calls `POST /drafts/:id/pause` and surfaces Commissioner Console controls; given the viewing owner is not the commissioner, then no such action is rendered.
- Given the Draft Room renders, when the owner activates the War Room link, then their War Room (`web/src/screens/war-room/`) opens as a separate window for the same team identity, and that War Room offers a link back to the Draft Room.
- Given the Draft Room renders for an owner with at least one drafted player, when the roster section renders, then it shows every filled starter slot, every still-open starter slot, and the bench count, sourced from that team's `RosterEntry` rows and the league's `roster_slot_definitions` — updating in real time as `PLAYER_AWARDED` events arrive for that team.
- Given the Draft Room renders, when the player list panel loads with no filter or search text entered, then it shows every undrafted player sorted by `aav_minor` descending, breaking ties by `projected_points` descending, with position-filter tabs matching the league's configured `roster_slot_definitions`; selecting a position tab narrows the list to players eligible for that position (or FLEX group) without affecting the sort order.
- Given it is the viewing owner's nomination turn, when the owner selects a player from the persistent player list panel (filtered, searched, or unfiltered), then the same `NOMINATE_COMMAND` is submitted at `min_bid_minor` as when selecting a player from the free-text search results, and a player already drafted never appears in the list.
- Given the Draft Room renders, when it displays the top team-by-team strip, then every team in nomination order shows its icon/name and current `remaining_budget_minor`; given a `PlayerAuction` is `OPEN`, then the current leading team's entry in the strip is visually highlighted and shows the current bid amount, updating within one render cycle of each `BID_ACCEPTED` or leader-change event without a full-page reload; given no `PlayerAuction` is open, then no entry shows a current-bid highlight.

**Post-launch gap-review additions (2026-09):** the items below extend the module after live use surfaced a real 403 bug and ten UX/completeness gaps against `knowledge/PRD.md` and `knowledge/screen-information-architecture.md` §§2.1–2.6. Everything above this point remains in force unchanged.

- **Draft Room as a pre-draft waiting room.** Today `web/src/screens/draft-room/index.tsx` and the Lobby only route into Draft Room once `ws.draftStatus` is `RUNNING`/`PAUSED`; there is no way to open it beforehand. Draft Room must render the same shell for `ws.draftStatus === 'CREATED'` (and `SCHEDULED`, if the draft entity uses that status): the team strip, "My Roster" panel, and Zone C budget figures render from the real `GET /drafts/:draftId/roster-grid` data exactly as they do mid-draft (every team shows full/untouched budget and zero picks, since nothing has been drafted), while nomination and bid controls (Zone D) render disabled/idle and the "waiting for nomination"/countdown copy is replaced with a "Waiting for the draft to start" message. No new "empty" component: the same components that already degrade to zero-state must simply not assume `auction` or a live countdown deadline exists. Lobby's existing auto-redirect logic is unchanged — this only makes the destination screen safe to open early — but Lobby (or a direct link) must be able to navigate to Draft Room pre-`RUNNING` without the screen throwing or blanking.
- **All-picks history feed.** In addition to the existing "Recent Bids" ladder (which is scoped to the current `OPEN` `PlayerAuction` only, per Zone B), Draft Room renders a separate, persistent panel listing every resolved pick in the draft so far — player name, winning team, and price paid, newest first — sourced from the same `Acquisition`/roster-grid data already powering the roster sidebar (no new read query: it is every team's filled slots merged into one chronological list, ordered by `resolution_sequence` descending). It updates on each `PLAYER_AWARDED` event without a full-page reload and is visually distinct from the current-auction bid ladder.
- **Round-by-round Board view.** `web/src/screens/draft-board/` does not exist despite being described in this file and every prior rework (F-MOD-002-rework-01 through -05) — it has never actually been built. This gap review closes it: implement `web/src/screens/draft-board/` as a grid view, reachable from Draft Room via a tab/toggle, showing every resolved pick organized by **team (column) × pick-for-that-team number (row)** — i.e., "round" here means the Nth pick chronologically resolved for a given team, not a snake-draft round tied to nomination order (auction drafts have no such fixed round structure). Each populated cell shows player name, position, and price paid; unfilled cells (a team's Nth pick hasn't happened yet) render empty. The grid updates in real time from `PLAYER_AWARDED` events, same as the existing per-player Draft Board table description above (that table and this grid may share the same screen, e.g. as a toggle, or ship as two views under `draft-board/` — implementer's choice, but both must exist).
- **Roster panel bye week + points columns.** The My Roster panel (behavioral expectation "the roster sidebar renders a filled slot") adds `bye_week` and `projected_points` as two more display columns per filled slot, alongside the existing player name and price paid. Both fields are already returned to the client today — `bye_week` and `projected_points` are present per player in the `/leagues/:leagueId/players` response (`server/src/player/routes.ts`) and already typed on the client (`web/src/screens/draft-room/index.tsx`'s player row type, `web/src/lib/useAuctionSocket.ts`'s player type). This is display-only: join each roster slot's player to its already-fetched player-list entry by name/id and render the two new fields; render `—` when either is `null`. No new server query, no new field added to the roster-grid endpoint.
- **Anti-snipe extension indicator.** `server/src/auction/engine.ts` already sets `anti_snipe_extended: true` on `BID_ACCEPTED` when a bid lands inside the anti-snipe window (existing behavioral expectation above), but `web/src/lib/useAuctionSocket.ts`'s `BID_ACCEPTED` case does not read that flag and Draft Room shows nothing when it fires. Add `anti_snipe_extended` to the client-side `BID_ACCEPTED` handling and surface a brief badge/toast (e.g. "Deadline extended — anti-snipe") in Zone A/E when it is `true`, dismissing after a few seconds like the existing auction-close card pattern.
- **Anti-snipe penalty system (new scope, not just the extension above).** Per `knowledge/PRD.md` §19, add the full configurable anti-sniping penalty policy, which today only exists as the threshold/extension pair (`auctionConfigurations.anti_snipe_threshold_ms` / `anti_snipe_extension_ms` in `server/db/schema/index.ts`, edited via `server/src/league/routes.ts`). Extend the `auctionConfigurations` table and its PUT/GET routes with: `anti_snipe_penalty_mode` (`OFF` | `INFORMATIONAL` | `WARNING` | `ENFORCEMENT`, default `OFF`), `anti_snipe_penalty_late_bid_threshold` (integer count of qualifying late bids — i.e. bids classified inside the anti-snipe window — before a penalty is triggered), `anti_snipe_penalty_min_remaining_ms` (the minimum remaining time, per PRD §19, that a penalized team must respect — i.e. while penalized, that team's bids are rejected with a `PENALTY_ACTIVE`-style code if placed inside this many ms of the current `rebid_deadline_ts`, rather than being accepted normally), and `anti_snipe_penalty_duration_auctions` (how many of that team's subsequent `PlayerAuction`s the penalty applies to, counted from the auction after the one that triggered it). New DB state (append-only, per existing invariant 2): a `qualifying_late_bid_count` counter per `DraftTeamState` (or a new small per-team-per-draft counter row) incremented every time that team's accepted bid falls inside the anti-snipe window, and a `SnipingPenalty` record (draft_id, team_id, triggered_at, auctions_remaining, active bool) created once the counter crosses the configured threshold — this is genuinely new schema, since neither `engine.ts` nor the DB schema has any penalty/sniping-event concept today. Engine logic in `server/src/auction/engine.ts`: (1) every accepted bid that lands in the anti-snipe window increments the team's counter regardless of penalty mode; (2) when the counter reaches `anti_snipe_penalty_late_bid_threshold` and mode is `WARNING` or `ENFORCEMENT`, create the `SnipingPenalty` row and emit a new `DraftEvent`/WS event (e.g. `SNIPING_PENALTY_APPLIED`, carrying `team_id`, `mode`, `auctions_remaining`) so both Draft Room and War Room (a separate module, out of scope here beyond this event) can consume it from the existing WS stream; (3) in `ENFORCEMENT` mode only, while a team has an active penalty, its `BID_COMMAND`s are rejected with a distinct code when `server_receipt_time` falls within `anti_snipe_penalty_min_remaining_ms` of the current `rebid_deadline_ts`, mirroring the existing stale-state/roster-full rejection pattern (validated before any DB row is modified); (4) in `INFORMATIONAL`/`WARNING` modes, no bid is ever rejected for this reason — the penalty is visible-only; (5) `auctions_remaining` decrements by one each time a `PlayerAuction` the penalized team could have bid on resolves, and the penalty is marked inactive (never deleted) once it reaches zero. Draft Room shows a visible penalty indicator (e.g. in Zone E, per `screen-information-architecture.md` §2.5's existing "anti-sniping penalty if active" line) whenever the viewing team has an active penalty, including in `INFORMATIONAL` mode.
- **Whammy display.** `server/src/draft/whammy.ts` fully implements and broadcasts a `WHAMMY_APPLIED` `DraftEvent`, but `web/src/lib/useAuctionSocket.ts`'s event switch has no `case 'WHAMMY_APPLIED'`, so a Whammy firing mid-draft is invisible in Draft Room. Add that case (updating the affected team's budget/state from the event payload, matching how `BudgetLedgerEntry` rows are already reflected elsewhere) and a toast/notification in Draft Room naming the team and effect when it fires. A concurrent rework of MOD-009 is adding probability-weighted auto-triggering alongside the existing manual trigger; this feature only needs to consume whatever `WHAMMY_APPLIED` event shape that rework emits (matching field names, not duplicating trigger logic) — do not implement or alter Whammy trigger logic here. War Room needs the same display and will pick it up from the same broadcast event in its own rework.
- **Zone F league-wide scarcity.** The existing per-viewer `scarcity` calculation in `web/src/screens/draft-room/index.tsx` counts only same-position/same-tier undrafted players (a same-tier count, not open roster slots), and nothing today counts open roster slots at all. Per `screen-information-architecture.md` §2.6's example ("8 compatible starter slots open league-wide"), add a second Zone F line: the count of starter slots, across all 12 teams' `roster_slot_definitions` assignments, that are still open and eligible for the nominated player's position (or its FLEX group) — computed from the same roster-grid data already driving the team strip and roster sidebar (each team's filled vs. open starter slots), summed league-wide. This is additive to the existing same-tier-remaining line, not a replacement.
- **Recent Bids ladder: bid type + time-remaining.** Per `screen-information-architecture.md` §2.2 ("time remaining when bid arrived" and "bid-type indicator only when notable: Match; custom jump"), extend `BidLadderEntry` in `web/src/lib/useAuctionSocket.ts` with `bid_type` (`MATCH` | `ABSOLUTE` | `RELATIVE`, sourced from the same `bid_type` already present on the server's `BID_ACCEPTED` event/`BidAttempt` row) and `ms_remaining_at_receipt` (computed server-side as `rebid_deadline_ts − server_receipt_time` at the moment the bid was accepted, threaded through the `BID_ACCEPTED` event payload alongside the existing fields — no new DB column required, since both `server_receipt_time` and the deadline already exist on `BidAttempt`/`PlayerAuction`). Render both in the Recent Bids list; per the IA spec, only show the bid-type indicator when it is `MATCH` or a custom absolute jump (not for a plain `+$1` relative bid), and always show time-remaining.
- **Zone A: custom Owner Target Value, always visible.** `myTargetValueMinor` is already computed in `web/src/screens/draft-room/index.tsx` but only reaches the expandable player-detail popover. Per `screen-information-architecture.md` §2.1 ("custom Target if actually customized" is listed under Zone A's own "optional compact secondary facts", not the popover), render it compactly in the always-visible Zone A area whenever the viewing team has set a custom Owner Target Value for the currently nominated player (no change when unset — Zone A must not show a placeholder/default value, only an actually-customized one). The expandable popover keeps its own Target display unchanged.
- **Bug fix: 403 on `GET /leagues/:leagueId/players` for Owners.** Reproduced live: an Owner (non-commissioner) viewing Draft Room during a `RUNNING` draft gets repeated 403s in the browser console from this endpoint, because `server/src/player/routes.ts`'s handler for `/leagues/:leagueId/players` is gated with `preHandler: requireCommissioner(server, db)` (confirmed at the route registration) even though Draft Room's persistent player list (behavioral expectation "(d)" above) and the new fields in this gap review all depend on every Owner being able to read it during a live draft. Fix: change that route's `preHandler` to `requireLeagueMember(server, db)` (already imported and used elsewhere in `server/src/league/routes.ts`, and already the correct auth hook per this project's convention for routes an Owner must also read) — the handler itself performs no commissioner-only mutation or data exposure, so no other change to the handler body is needed. Verify no other caller of this route relied on commissioner-only access (none does: it is a read-only player list needed by every team during nomination).

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-001

## API Contracts

```yaml
produces:
  - operation_id: startDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: pauseDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: resumeDraft
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: DraftStatusResponse

  - operation_id: ws_BID_ACCEPTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: BID_COMMAND
    response_schema: BID_ACCEPTED

  - operation_id: ws_BID_REJECTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: BID_COMMAND
    response_schema: BID_REJECTED

  - operation_id: ws_NOMINATION_STARTED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: NOMINATE_COMMAND
    response_schema: NOMINATION_STARTED

  - operation_id: ws_PLAYER_AWARDED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: PLAYER_AWARDED

  - operation_id: ws_AUTHENTICATED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: AUTHENTICATE
    response_schema: AUTHENTICATED

  - operation_id: ws_PASS_NOMINATION
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: PASS_NOMINATION
    response_schema: NOMINATION_TURN_CHANGED

  - operation_id: ws_NOMINATION_TURN_CHANGED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: NOMINATION_TURN_CHANGED

  - operation_id: ws_WHAMMY_APPLIED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: WHAMMY_APPLIED

  - operation_id: ws_SNIPING_PENALTY_APPLIED
    schema_file: schema/MOD-002-api-schema.yaml
    request_schema: {}
    response_schema: SNIPING_PENALTY_APPLIED
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

- command: DATABASE_URL=postgres://draft:draft_local_dev@localhost:5432/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-002_auction.test.ts web/src/__tests__/F-MOD-002-rework-02_draft_room.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-002_auction.test.ts
  - web/src/__tests__/F-MOD-002-rework-02_draft_room.test.tsx

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
