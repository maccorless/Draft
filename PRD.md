# Fantasy Football Auction Draft Platform — Product Requirements Document

**Status:** Working PRD  
**Last updated:** 2026-08-30  
**Primary use case:** Private fantasy-football auction draft with post-draft transfer to ESPN Fantasy Football  
**Initial league profile:** 12 teams, Standard/non-PPR, approximately 9 starters, salary-cap auction  
**Primary downstream platform:** ESPN Fantasy Football

---

## 1. Product Objective

Build a dedicated fantasy-football auction drafting application that provides a more reliable, flexible, and useful live-auction experience than a league-hosting site's built-in draft room.

The application conducts the draft and becomes the authoritative record of:

- nominations;
- every bid attempt, including rejected bids;
- accepted bids and winning prices;
- auction timing;
- team budgets;
- roster construction during the draft;
- commissioner interventions and corrections;
- Whammy events;
- draft history and rollback timelines.

The application does **not** manage the fantasy season.

At draft completion, it produces validated rosters and an ESPN-oriented transfer workflow so the commissioner can accurately populate the league in ESPN.

### North-star promise

> Conduct a highly reliable and enjoyable real-time auction in which every bid outcome is deterministic, every owner can employ their own auction strategy, the commissioner can recover cleanly from mistakes, and the resulting rosters can be transferred to ESPN with minimal reconciliation effort.

---

## 2. Product Philosophy

### 2.1 Facilitate strategy; do not commoditize it

The system should provide useful facts and market context without telling owners what players are strategically worth.

Auction expertise and pre-draft preparation should remain meaningful advantages.

The platform therefore distinguishes three types of information.

#### Shared facts

Examples:

- prior-season statistics;
- current-season projected statistics;
- projected fantasy points;
- injury status and freshness;
- bye week;
- player tier;
- comparable remaining players;
- roster and budget information;
- historical bidding activity.

#### Generic market references

Examples:

- ESPN AAV;
- FantasyPros AAV;
- other commissioner-loaded AAV sources.

AAVs are intentionally static reference points rather than system-generated recommendations.

The application will **not** create a sophisticated dynamic "fair price," inflation-adjusted target, or recommended bid.

#### Private owner intelligence

Owners may optionally maintain:

- personal Target Values;
- Watch List;
- Nomination Queue;
- Do Not Draft list;
- Auto-Agent configuration.

These remain private to the team.

### 2.2 Draft Room is for acting; War Room is for thinking

The active bidding surface must stay focused on decisions and actions. Deeper statistics, comparisons, multi-source AAVs, roster tables, and historical information should progressively disclose or appear in the synchronized War Room/second-screen experience.

### 2.3 External data populates the draft; it does not operate the draft

All critical player, projection, tier, AAV, and roster-rule data must be imported into the application before the live draft. The live auction must remain operational even if an external data source is unavailable.

---

## 3. Scope

### 3.1 In scope

- Live salary-cap/auction drafting.
- Commissioner league and draft configuration.
- Per-team starting budgets.
- Configurable roster slots and starter counts.
- Starter-first roster assignment during the draft.
- Flexible position eligibility, including Offensive Flex and Total Flex.
- Nomination management.
- Arbitrary opening nomination prices.
- +$1 relative bids.
- Arbitrary/custom ("Flash") bids.
- One-use Nominator Match.
- Separate nomination, second-bid, and rebid timers.
- Configurable anti-sniping.
- Server-authoritative timing and bid ordering.
- Owner Watch List.
- Owner Nomination Queue.
- Optional owner Target Values.
- Auto-Agent mode.
- Automatic transition to Auto-Agent after disconnect grace period.
- Player historical stats, projections, AAVs, tiers, and injuries.
- Multiple commissioner-selectable AAV sources.
- ESPN AAV PDF import.
- Player detail/popover and synchronized second-screen intelligence.
- Desktop, mobile, and synchronized multi-window desktop.
- Team icons.
- Optional team nomination MP3.
- Commissioner pause, correction, and rollback.
- Positive and negative Whammy events.
- Full immutable bid telemetry.
- Post-draft analytics and rankings.
- ESPN roster-transfer assistance.
- Canonical CSV/JSON draft exports.
- Site/league/team password authentication (MVP); email magic-link authentication (future).
- Commissioner-configured scheduled draft start date/time, visible to all participants.
- Simultaneous multi-league drafting within the same deployment.
- Post-draft summary report (per-team and league-wide), with optional email delivery.

### 3.2 Explicitly out of scope

- Season-long fantasy league management.
- Waivers.
- Post-draft trades.
- Weekly lineup management.
- Live fantasy scoring.
- Tracking the owner's eventual weekly starting lineup.
- Anonymous auction bidding.
- Banded bid increments.
- System-generated optimized owner target values.
- Unsupported ESPN credential/session-cookie automation.
- Multiple simultaneous player auctions in the initial release.

---

## 4. Roles

### 4.1 Commissioner

Can:

- create/configure the league;
- create teams and assign owners;
- configure roster rules;
- configure team budgets;
- configure auction rules;
- configure Auto-Agent defaults;
- configure Whammys;
- configure player/AAV data;
- choose visible AAV sources;
- lock owner team-name editing;
- upload/replace team icons and nomination audio on behalf of owners;
- pause/resume the draft;
- control timers;
- enter nominations/bids on behalf of owners;
- place a team into or out of Auto-Agent mode;
- execute corrections;
- rollback draft state;
- finalize the draft;
- execute the ESPN transfer workflow.

### 4.2 Owner / Drafter

Can:

- nominate;
- bid;
- maintain private Watch List;
- maintain private Nomination Queue;
- maintain private Target Values;
- maintain private Do Not Draft entries;
- configure Auto-Agent settings;
- manually enter Auto-Agent mode;
- resume manual control after Auto-Agent mode;
- upload team icon;
- upload optional nomination MP3;
- view player intelligence and permitted league/team information.

### 4.3 Host

Optional presentation/event role.

Can operate presentation surfaces without automatically receiving commissioner roster/budget mutation privileges.

### 4.4 Access and Authentication

MVP authentication is intentionally simple and self-hosted, not account-based:

- A single site-wide password gates entry to the application.
- After the site password, a user selects a League, then selects a Team from that league's team list, then enters that team's password to act as that team's Owner.
- A separate league-level password grants Commissioner access to that league.
- The Commissioner sets the league password, league name, league logo, and each team's password during League setup.
- There is no self-service account creation or password reset in MVP; all credentials are configured by the commissioner.
- Passwords are stored hashed (e.g. bcrypt), never in plaintext, even for MVP.
- A future version adds email-based magic-link authentication (e.g. via SendGrid) as an alternative to password entry.

---

## 5. League and Team Configuration

Commissioner configures:

- league name;
- season;
- scoring rules;
- team count;
- owner assignments;
- team names;
- whether owners may change team names;
- default starting budget;
- starting-budget override per team;
- minimum acquisition price;
- roster size;
- starting roster slots;
- bench count;
- flex definitions;
- nomination order;
- timers;
- anti-sniping;
- Nominator Match;
- Auto-Agent defaults;
- Whammys;
- player dataset;
- displayed AAV sources.

### 5.1 Team presentation media

Each team may have:

- an uploaded team icon;
- an optional uploaded MP3 nomination sound.

Owner or commissioner may upload, replace, or remove the media.

#### Nomination audio playback

The optional team MP3:

- plays only on that team's first nomination of the draft;
- therefore normally occurs during the team's first trip through the nomination order ("round 1");
- plays for a maximum of 5 seconds;
- plays only once per draft;
- is presentation-only and must never block nomination or bidding;
- should be broadcast to presentation/draft clients that permit audio.

If the uploaded file is longer than five seconds, playback stops at five seconds. The source file does not need to be physically trimmed.

### 5.2 Draft Scheduling

The commissioner may configure a scheduled draft start date and time for a League's Draft.

- The scheduled start time is visible to all owners and the commissioner from the moment it is set, wherever draft status is shown (pre-draft lobby, Draft Room header, War Room).
- Setting or changing the scheduled start time does not automatically start the draft. The commissioner must still explicitly start the draft (UPCOMING → RUNNING); the scheduled time is informational only.
- If no scheduled start time is set, the interface displays "Not yet scheduled."

---

## 6. Roster Configuration

The draft must know:

- total roster size per team;
- number of starter slots;
- starter count by roster slot/position;
- bench count;
- legal eligibility for each slot;
- slot-assignment priority.

Example:

| Slot | Count | Starter | Eligibility | Priority |
|---|---:|---|---|---:|
| QB | 1 | Yes | QB | 10 |
| RB | 2 | Yes | RB | 10 |
| WR | 2 | Yes | WR | 10 |
| TE | 1 | Yes | TE | 10 |
| Offensive Flex | 1 | Yes | configured offensive positions | 20 |
| Total Flex | 1 | Yes | configured player types | 30 |
| K/DST/etc. | configurable | Yes | configured | 10 |
| Bench | configurable | No | legal roster players | 100 |

The configured total roster size determines the number of successful acquisitions required to complete the draft:

`team_count × total_roster_size`

The application need not use fantasy "rounds" as a core auction mechanic, but it may derive a round-like display from completed nomination cycles.

---

## 7. Starter-First Roster Assignment

The draft software tracks whether starter slots have been filled so owners can see whether a newly acquired player fills an open starter position or is a bench acquisition.

It does **not** attempt to determine who an owner should actually start during the fantasy season.

### 7.1 Assignment algorithm

When a player is acquired:

1. Find unfilled **starter** slots for which the player is eligible.
2. If one or more match, select the lowest-priority-number / most-specific matching slot.
3. If multiple equal-priority specific slots exist, use the first unfilled ordinal.
4. If no starter slot matches, assign the player to Bench.
5. Do not automatically reshuffle previously assigned players merely to optimize projected points.

Example:

- Empty WR and FLEX exist.
- Owner drafts a WR.
- Fill WR first.
- If all WR starter slots are filled but FLEX remains, fill FLEX.
- If no eligible starter slot remains, place the WR on Bench.

The purpose is draft context, not weekly lineup optimization.

---

## 8. Scoring Configuration

Scoring must be represented as structured rules, not merely `STANDARD` or `NON_PPR`.

Examples:

- passing TD = 4;
- passing yards = 0.04 per yard;
- rushing yards = 0.1 per yard;
- receiving yards = 0.1 per yard;
- reception = 0;
- applicable kicking/DST rules.

Historical and projected fantasy points may be calculated from imported raw stats using the configured scoring rules.

---

## 9. Player Data and Draft Dataset

### 9.1 Principle

External sources populate the application before the draft.

The live auction operates from the application's own stored and versioned dataset.

### 9.2 Player information

The pre-draft dataset should support:

- canonical player identity;
- external/provider IDs;
- name;
- NFL team;
- position eligibility;
- bye week;
- prior-season statistics;
- prior-season fantasy points under league scoring;
- current-season projected statistics;
- projected fantasy points under league scoring;
- injury/status;
- injury detail;
- practice/depth-chart status when available;
- update timestamp/freshness;
- player tier;
- one or more AAV sources.

### 9.3 Candidate source strategy

The architecture supports multiple ingestion adapters.

Potential sources include:

- ESPN;
- FantasyPros;
- Sleeper;
- nflverse;
- commissioner CSV;
- commissioner-uploaded source documents such as ESPN AAV PDF.

### 9.4 Frozen draft dataset

Commissioner loads and validates data during setup.

Before launch, the system creates a versioned **Draft Dataset**.

Example:

`2026.08.30.1`

The commissioner can see:

- source;
- source date;
- records loaded;
- missing projections;
- missing AAVs;
- unmatched players;
- ambiguous player matches;
- last refresh.

Once the draft begins, freeze:

- core player identities;
- projections;
- AAVs;
- tiers.

Optional live refresh may be allowed only for:

- injury status;
- team/status news.

Every refreshed status must display freshness.

---

## 10. Multi-Source AAV

A player may have multiple static AAV values.

Example:

| Source | Value |
|---|---:|
| ESPN | $42 |
| FantasyPros | $47 |
| Custom | $51 |

Commissioner chooses:

- one **Primary AAV**;
- zero or one **Secondary AAV** for the main Draft View;
- any additional loaded AAVs available in detailed player/War Room views.

### 10.1 ESPN AAV PDF

Support ESPN's downloadable AAV PDF as a first-class commissioner setup source.

Importer must:

1. extract player/value rows;
2. normalize names;
3. match rows to canonical players;
4. identify exact/probable/ambiguous/unmatched results;
5. require commissioner confirmation for ambiguity;
6. store source metadata and import date.

### 10.2 No system strategic valuation

The system will not:

- dynamically change AAV based on draft spending;
- calculate "fair value";
- average multiple AAVs into a recommended value;
- tell the owner what they should bid.

---

## 11. Owner Target Values

Target Value is optional and private.

Owners may:

- enter manually;
- bulk upload/paste;
- edit before the draft;
- edit during the draft.

If no custom target is set, the interface should avoid showing a redundant "My Target."

Preferred display:

**No custom target**

`ESPN AAV $42`

**Custom target exists**

`ESPN AAV $42 · My Target $51`

Internally, an Auto-Agent may fall back to Primary AAV where a target has not been customized.

---

## 12. Watch List, Nomination Queue, and Do Not Draft

### 12.1 Watch List

Private research list.

A Watch List:

- never automatically nominates;
- may be unordered or optionally sorted;
- may contain notes/targets;
- allows `Nominate` when it is the owner's turn.

### 12.2 Nomination Queue

Ordered automation list.

Each entry may include an opening nomination amount.

If the owner does not act during nomination time, the system may nominate the first legal available queued player according to league policy.

### 12.3 Do Not Draft

Private owner list used primarily to prevent Auto-Agent acquisition.

---

## 13. Auction Lifecycle

For one player:

1. nomination turn begins;
2. nomination timer begins;
3. owner selects player;
4. owner enters any legal opening price;
5. server validates nomination;
6. Player Auction opens;
7. second-bid timer begins;
8. first accepted competing bid transitions to rebid behavior;
9. accepted subsequent bids establish/re-establish rebid deadline;
10. anti-sniping policy may modify late-deadline behavior;
11. authoritative deadline expires;
12. winner is determined;
13. acquisition, budget, and roster assignment commit atomically;
14. ephemeral close card displays;
15. next eligible nominator begins.

If nobody else bids, the nominator wins at the opening amount when the Second-Bid Timer expires.

---

## 14. Nomination

Opening nomination may be **any legal dollar amount**.

It is not required to begin at $1.

Example:

`Nominate Justin Jefferson for $38`

Nomination requires:

- available player;
- correct nomination turn;
- legal roster capacity;
- legal opening price;
- opening price ≤ maximum legal bid;
- nomination command received before nomination deadline.

---

## 15. Bid Methods

### 15.1 +$1

Relative bid.

Requires stale-state protection.

### 15.2 Custom / Flash Bid

Owner enters an exact absolute amount.

Example:

Current price: `$34`

Owner enters: `$47`

The system attempts exactly `$47`.

If authoritative current bid is still below `$47` and all other rules pass, accept `$47`.

If authoritative current bid has reached or exceeded `$47`, reject it.

The server must never silently turn an entered `$47` into another amount.

No banded bid increments.

---

## 16. Stale-State Protection

Each Player Auction has a monotonic version.

Relative operations such as +$1 and Match include:

- Player Auction ID;
- expected current bid;
- expected auction version.

If either no longer matches authoritative state, reject rather than changing the user's economic intent.

Example:

Owner sees `$35` and clicks +$1.

Before processing, another owner bids `$42`.

Result:

> Bid not placed — price changed to $42.

Custom absolute bids do not require an exact-price match, because the user explicitly entered the maximum immediate price they intend to offer.

---

## 17. Nominator Match

Configurable ON/OFF.

Nominating team receives **one Match privilege per Player Auction**.

Rules:

- available only while the normal bidding timer is active;
- nominator cannot already be high bidder;
- another team must currently lead;
- UI displays exact action, e.g. `Match $37`;
- accepted Match makes nominator the high bidder at exactly `$37`;
- Match is consumed permanently for that Player Auction;
- auction continues normally;
- nominator may later submit ordinary bids;
- nominator may not Match again;
- Match received after deadline is rejected;
- there is no post-expiration Match state/window;
- Match uses stale-state protection.

Match is the single permitted same-price high-bidder change. Event sequence, not amount alone, defines the latest accepted bid.

---

## 18. Timer Model

Three independently configurable timers:

### Nomination Timer
Time available to select and submit a nomination.

### Second-Bid Timer
Begins after the opening nomination. Controls the time available for another owner to make the first competing bid.

### Rebid Timer
After the first competing bid, each subsequent accepted bid establishes the configured rebid deadline.

### Anti-sniping interaction
The configured anti-sniping policy may alter the effective deadline for accepted bids inside the protected late window.

All deadlines are authoritative server timestamps.

---

## 19. Anti-Sniping / Intentional Sniping

Configurable league rule.

Possible configuration:

- enabled/disabled;
- informational-only/warning/enforcement;
- late-bid threshold;
- number of qualifying late bids before penalty;
- minimum remaining time required while penalized;
- penalty duration in subsequent Player Auctions.

Classification uses **server receipt time**, not browser time.

Penalty must be visible to the affected owner and commissioner.

---

## 20. Financial Rules

For each team:

`maximum legal bid = remaining budget - mandatory reserve for other required remaining roster spots`

Example:

Budget = `$10`  
Roster slots remaining including current purchase = `5`  
Minimum salary = `$1`

Maximum legal bid = `$6`

All calculations are server-side and use exact integer money units.

---

## 21. Auto-Agent

Auto-Agent is a first-class live control mode for a team.

### 21.1 Control modes

A team is in one of:

- `MANUAL`;
- `AUTO_AGENT`.

A temporary connection status may additionally be:

- `CONNECTED`;
- `RECONNECTING`;
- `DISCONNECTED`.

### 21.2 Manual transition

Owner may enable Auto-Agent at any time.

Commissioner may also enable Auto-Agent for a team.

When a team enters Auto-Agent:

- team UI must show a prominent Auto-Agent badge/state;
- all active auction participants receive a broadcast toast, for example:

> Team Alpha has entered Auto-Agent mode.

When manual control resumes, broadcast a corresponding toast.

### 21.3 Disconnect transition

A brief network interruption should not immediately surrender control.

Use configurable `disconnect_auto_agent_delay_sec` (recommended initial default: 5 seconds).

Flow:

1. All authenticated sessions for the team's owner lose draft connectivity.
2. Team enters `RECONNECTING`.
3. Grace timer begins.
4. If any valid team session reconnects before the deadline, remain `MANUAL`.
5. If no valid session reconnects, transition team to `AUTO_AGENT` with reason `DISCONNECTED`.
6. Broadcast the Auto-Agent transition to all participants.

Because owners may use both Draft View and War Room, loss of one window does not trigger Auto-Agent while another valid team session remains connected.

### 21.4 Reconnection after Auto-Agent takeover

Reconnection does **not** automatically switch back to manual.

The returning owner sees:

> Auto-Agent is controlling your team. Resume Manual Control.

Manual control resumes only after explicit owner or commissioner action.

### 21.5 Auto-Agent valuation configuration

Per-team configuration should support:

- use custom owner Target Value where set;
- otherwise use Primary AAV;
- maximum percentage above base value the agent may tolerate;
- optional maximum percentage below/base participation threshold if needed;
- randomized valuation/personality variance;
- bench discount;
- prioritize unfilled starter slots;
- Do Not Draft list.

Recommended conceptual fields:

- `max_over_base_pct`;
- `random_variance_pct`;
- `bench_value_pct`;
- `prioritize_starters`.

The Auto-Agent is intentionally simple and explainable. It must not become an opaque strategic optimizer.

It remains subject to all human rules:

- budget;
- roster capacity;
- timer/deadline;
- anti-sniping;
- stale-state validation where applicable.

---

## 22. Player Intelligence

Detailed player panel/popover may include:

- prior-season stats;
- projected stats;
- projected fantasy points;
- Primary and other AAV sources;
- custom owner target if set;
- tier;
- injury/status;
- freshness;
- bye week;
- comparable remaining players;
- same-tier remaining players;
- simple scarcity context.

No recommendation such as "you should bid" or "best alternative."

---

## 23. Tier Awareness and Comparable Players

Tier data may be supplied by an imported provider.

Display examples:

- `WR · Tier 2`;
- `Tier 2 WR remaining: 3`.

Comparable remaining players should be selected mechanically using factors such as:

- same position/eligibility;
- same or adjacent tier;
- similar projection band.

Do not label a player as the "best alternative."

---

## 24. Scarcity Context

Informational only.

Possible metrics for the active player's position:

- league-wide unfilled starter slots accepting that position;
- players remaining in the same tier;
- projected players remaining within a configured tier/projection band;
- teams with at least one unfilled compatible starter slot.

Example:

> 8 compatible starting WR slots remain  
> 5 Tier 1/2 WRs remain

Do not convert scarcity into a system price.

---

## 25. Draft View

Primary active-auction screen.

Prominent content:

- player;
- team/position;
- injury indicator;
- current bid;
- high bidder;
- authoritative timer;
- Primary AAV;
- optional Secondary AAV;
- custom Target Value only when set;
- owner's remaining budget;
- maximum legal bid;
- roster/starter-slot context;
- +$1;
- custom bid;
- Match when applicable;
- Auto-Agent status;
- connection/latency health;
- compact tier/scarcity cue.

---

## 26. War Room / Second Screen

Same owner may open a synchronized second browser window.

War Room may show:

- full player detail;
- projections;
- injury freshness;
- all configured AAVs;
- owner target;
- tiers;
- comparable players;
- scarcity;
- all rosters and budgets;
- Watch List;
- Nomination Queue;
- bid history;
- recent acquisitions;
- chat if included.

Every authenticated window shares the same owner/team identity.

Multiple windows do not create multiple drafters.

---

## 27. Mobile UX

Mobile preserves full bidding capability while reducing information density.

Priority:

1. player;
2. current bid;
3. timer;
4. AAV;
5. Target if customized;
6. bid controls;
7. remaining budget/max bid;
8. roster-slot context;
9. Auto-Agent state;
10. connection status.

---

## 28. Connection / Latency Indicator

Display a basic realtime connection-health state such as:

`● Excellent — 42 ms`

Possible states:

- Excellent;
- Good;
- Degraded;
- Poor;
- Reconnecting.

This is advisory. Server receipt time remains authoritative.

---

## 29. Auction Close Card

After acquisition, show an ephemeral, non-blocking card for approximately 2–4 seconds.

Possible fields:

- player;
- winning team;
- winning price;
- Primary AAV difference;
- accepted-bid count;
- unique bidder count;
- winning-bid time remaining;
- remaining team budget.

It must not delay the next nomination.

---

## 30. Commissioner Live Controls

Commissioner can:

- pause/resume;
- extend/reset timers;
- nominate for an owner;
- bid for an owner;
- switch team Manual/Auto-Agent control;
- adjust budget;
- return player (currently open auction only);
- correct winner, correct purchase price, or manually assign player — unrestricted for the currently open auction, or for an already-awarded pick only when no conflict exists (§31);
- rollback the most recent N resolved picks, in order (§31).

Material corrections require a reason and immutable audit entry.

---

## 31. Commissioner Correction and Rollback

Correction never erases history. Every correction and rollback appends new events, ledger entries, and roster changes; nothing is deleted or overwritten. A draft has a single, continuously growing timeline — there is no branching or arbitrary point-in-time reconstruction.

### 31.1 Two correction paths

**Single-pick correction (no conflict).** An already-awarded pick may be corrected directly (winner, price, or player) only if the winning team has made no further acquisitions since that pick. The correction reverses that one pick's ledger and roster effects and applies the corrected ones in place. No other team or pick is touched.

**Rollback (conflict, or multiple picks).** If the winning team has drafted again since the pick in question, or the commissioner wants to undo more than one pick, the only path is rollback: undo the most recently resolved picks in reverse order, one at a time, back through and including the target pick. The commissioner cannot reach into the middle of the draft and touch only one pick while leaving later picks untouched — correcting an old pick with downstream picks means undoing everything back to it, then re-drafting those slots.

A rollback restores, for each undone pick:

- the player (returned to available);
- the winning team's budget (via a reversing ledger entry);
- the roster entry (removed);
- the nomination order (cursor returns to that team's turn once the earliest undone pick is reached);
- Match state for that PlayerAuction;
- team-completion state;
- Whammy financial effects tied to that pick's sequence, if any;
- relevant Auto-Agent state where defined.

### 31.2 Conflict definition

A pick has a conflict, for correction purposes, if the winning team has completed any acquisition after it. Player-identity conflicts (the corrected player is no longer available, or the released player was independently reacquired) are validated at correction/rollback time regardless of the above.

The original events remain visible as superseded history.

---

## 32. Budget Ledger

All money changes use an immutable ledger.

Entry types may include:

- starting budget;
- acquisition;
- acquisition reversal;
- commissioner adjustment;
- positive Whammy;
- negative Whammy;
- rollback compensation.

Displayed remaining budget must reconcile with ledger state.

---

## 33. Whammy Framework

Optional commissioner-configurable entertainment mechanic.

### Positive examples

- add `$5`;
- add `$10`;
- league-wide message requiring a positive offline action.

### Negative examples

- subtract `$5`;
- subtract `$10`;
- league-wide message requiring an offline action.

Configuration:

- enabled;
- positive/negative/both;
- probability/weight;
- trigger rule;
- max per draft;
- max per team;
- allowed monetary range;
- commissioner approval requirement;
- message/offline action.

Whammy budget effects flow through Budget Ledger.

A Whammy should not normally make legal roster completion mathematically impossible unless commissioner explicitly overrides.

---

## 34. Full Bid Telemetry

Every bid attempt is retained.

Minimum fields:

- draft;
- Player Auction;
- player;
- team;
- bid sequence;
- bid type;
- requested amount;
- previous authoritative bid;
- client-displayed bid;
- client version;
- server version;
- client click time if available;
- server receipt time;
- server processing/acceptance time;
- authoritative time remaining at receipt;
- measured latency;
- accepted/rejected;
- rejection reason;
- became high bidder;
- timer reset;
- sniping classification;
- session/device;
- idempotency key.

Telemetry is immutable.

---

## 35. Bid Analytics

Potential analytics:

- bids by owner;
- bids by player;
- unique bidders;
- bid battles;
- average bid timing;
- final-5/3/2/1-second bid percentages;
- custom bid usage;
- Match usage/success;
- stale-state rejections;
- budget rejections;
- sniping events;
- positional aggression;
- players pursued but not won;
- latency patterns;
- longest auctions;
- largest jumps.

Capture telemetry in MVP even if some analytics UI ships later.

---

## 36. Final Draft Rankings

Avoid a single opaque draft grade.

### 36.1 Projected drafted-starter points

Use the players assigned to starter slots by the draft's starter-first assignment logic.

This is **not** an optimized weekly lineup recommendation.

### 36.2 Roster projection/depth measure

Provide a separately labeled depth-oriented metric whose exact formula is versioned and transparent.

### 36.3 AAV acquisition efficiency

Compare purchase prices with a selected static AAV source.

Label clearly as AAV efficiency, not owner skill.

### 36.4 Draft Summary Report

On draft completion, the system generates a Draft Summary Report with two views:

- **Owner view**: for the requesting team, full pick list (player, price, slot assigned), total spend, remaining budget, and the team's metrics from §36.1–36.3.
- **League summary view**: all teams' spend, roster completion, and evaluation metrics side by side; overall league spending vs. the selected AAV source.

Delivery:

- The report is always viewable and downloadable in-app (per team, and league-wide for the commissioner) once the draft is COMPLETE.
- If external email delivery is enabled (commissioner-configured, dependent on a future email-provider integration), the system emails each owner their own Owner view and emails the commissioner the League summary view. Email delivery failure never removes in-app report availability.

---

## 37. ESPN Transfer

The application should not require or assume a supported ESPN roster-write API.

At completion:

1. validate internal roster integrity;
2. map source teams to ESPN teams;
3. validate player identity and roster capacity;
4. produce team-by-team ESPN entry order;
5. guide commissioner through ESPN Offline Draft entry;
6. track confirmed players;
7. flag ambiguous/unresolved mappings;
8. mark transfer reconciled.

Exports include:

- canonical JSON;
- generic CSV;
- ESPN-oriented roster-entry worksheet/report.

Winning prices and full bid history remain authoritative in this application.

---

## 38. Reliability and Concurrency

Server owns authoritative auction state.

Clients submit commands.

Server determines:

- legal current state;
- price;
- accepted bid;
- leader;
- deadline;
- winner;
- budget;
- roster assignment;
- Match eligibility;
- anti-sniping classification;
- control mode.

Client countdowns never determine the outcome.

---

## 39. Bid Atomicity

Conceptual transaction:

1. authenticate;
2. authorize user/team;
3. validate idempotency;
4. load/lock Player Auction;
5. validate deadline;
6. validate expected version where required;
7. validate player availability;
8. validate bid type/amount;
9. validate roster capacity;
10. validate budget;
11. validate Match privilege if applicable;
12. apply anti-sniping classification/rule;
13. calculate new deadline;
14. persist BidAttempt;
15. update auction state;
16. commit;
17. broadcast authoritative result.

No accepted event is broadcast before commit.

---

## 40. Reconnection

A reconnecting owner must recover:

- current Player Auction;
- current price;
- leader;
- deadline;
- budget;
- roster;
- Match state;
- control mode;
- current event sequence;
- missed events.

Owner should never need to guess whether a bid was accepted.

---

## 41. Pre-Draft Readiness

Commissioner preflight validates:

- team count;
- team owners;
- roster configuration;
- total roster size;
- starter-slot definitions;
- budget feasibility;
- minimum-bid rules;
- player dataset;
- projection source;
- AAV sources;
- Primary AAV selection;
- unmatched/ambiguous players;
- timer configuration;
- Match policy;
- anti-sniping;
- Auto-Agent defaults;
- team media validity;
- Whammy configuration;
- ESPN mapping prerequisites where relevant.

---

## 42. Nonfunctional Requirements

### Correctness

- zero duplicate player awards;
- zero unexplained budget mismatches;
- deterministic bid ordering;
- immutable BidAttempt telemetry;
- deterministic starter-slot assignment.

### Performance targets

- bid acknowledgement p50 < 100 ms in-region;
- p95 < 250 ms;
- p99 < 750 ms;
- committed bid → other-client broadcast p95 < 500 ms.

### Multi-tenancy and concurrency

The system supports multiple simultaneous live drafts across different leagues within the same deployment (MVP target: at least two concurrent RUNNING drafts). Each draft's state, timers, nomination order, and client connections are fully isolated from every other draft; no shared mutable state crosses draft boundaries.

### Recovery

- reconnect to usable state < 5 seconds under normal infrastructure;
- no committed acquisition lost;
- snapshot + event replay.

### Accessibility

Core nomination, bid, Auto-Agent, and commissioner controls are keyboard-operable and semantically accessible.

---

## 43. MVP

MVP should contain the capabilities required to run the intended real league.

### Core MVP

- league/team setup;
- team icon and optional nomination audio;
- team-name locking;
- configurable/per-team budget;
- structured scoring rules;
- roster/starter/flex configuration;
- deterministic starter-first roster assignment;
- pre-draft player-data ingestion;
- multiple AAV sources;
- ESPN AAV PDF import;
- stats/projections/injuries/freshness;
- owner Target Values;
- Watch List;
- Nomination Queue;
- Do Not Draft;
- arbitrary opening nomination;
- +$1;
- custom/Flash bid;
- stale-state protection;
- three timers;
- configurable anti-sniping;
- one-use Nominator Match;
- max-bid guardrails;
- tier awareness;
- comparable remaining players;
- compact scarcity;
- Draft View;
- War Room/double desktop;
- mobile;
- latency indicator;
- Manual/Auto-Agent state;
- owner and commissioner Auto-Agent activation;
- disconnect → Auto-Agent grace flow;
- broadcast Auto-Agent transition;
- basic Auto-Agent valuation configuration;
- commissioner pause/correction;
- single-pick correction and rollback of recent picks;
- immutable budget/event history;
- full bid telemetry;
- ephemeral close card;
- ESPN transfer package;
- final rankings.

### Likely V1

- richer Auto-Agent simulation/tuning;
- expanded analytics visualization;
- richer Whammy authoring;
- big-screen/spectator presentation;
- auction personality analytics;
- richer mock-draft tooling;
- public/shareable final board.

---

## 44. Key Acceptance Scenarios

### Starter-first assignment

Given WR1 is open and FLEX is open  
When team acquires a WR  
Then WR1 is filled before FLEX.

Given all specific WR starters are filled and FLEX accepts WR  
When team acquires another WR  
Then FLEX is filled.

Given all matching starter slots are filled  
When team acquires another legal WR  
Then player is assigned to Bench.

### Nomination audio

Given a team has uploaded nomination audio  
When that team makes its first nomination of the draft  
Then audio is requested for playback to eligible clients  
And playback is capped at 5 seconds  
And the audio does not play again for that team in the same draft.

### Disconnect → Auto-Agent

Given team is MANUAL  
And all of its valid draft sessions disconnect  
When disconnect grace period expires without reconnection  
Then team transitions to AUTO_AGENT with reason DISCONNECTED  
And every auction participant receives a broadcast toast.

Given Draft View disconnects but War Room remains connected  
Then team does not enter Auto-Agent.

Given team entered Auto-Agent due to disconnect  
When owner reconnects  
Then team remains AUTO_AGENT until explicit Resume Manual Control.

### +$1 stale state

Given displayed bid `$40`  
And server bid changes to `$45`  
When owner submits stale +$1  
Then no bid is created  
And owner receives current authoritative price.

### Custom bid

Given current authoritative bid `$40`  
When owner explicitly submits `$55`  
And `$55` is legal at receipt  
Then accepted bid is exactly `$55`.

### Match

Given nominator is not leader  
And another team leads at `$44`  
And Match is unused  
When nominator submits Match against exact current state before deadline  
Then nominator becomes leader at `$44`  
And Match is consumed.

### Rollback

Given multiple completed Player Auctions  
When commissioner rolls back the most recent N picks  
Then each undone pick's budget, roster, and nomination-order effects are compensated in reverse order  
And original history remains queryable.

### Multi-window

Given same owner opens Draft View and War Room  
When state changes  
Then both converge to same authoritative sequence  
And they count as one team identity for disconnect behavior.

### Single-pick correction without conflict

Given Team A's most recent acquisition is pick #12  
And no acquisition since #12 belongs to Team A  
When commissioner corrects the price of pick #12  
Then only pick #12's ledger and roster entries change  
And no other team or pick is affected.

### Single-pick correction with conflict

Given Team A acquired a player at pick #12  
And Team A has since acquired another player at pick #30  
When commissioner attempts to directly correct pick #12  
Then the system rejects direct correction  
And offers rollback of the most recent picks back through #12.

### Concurrent multi-league drafts

Given League Alpha and League Beta each have a RUNNING draft  
When bids are placed simultaneously in both drafts  
Then each draft's state, timers, and broadcasts remain independent  
And no event from one draft is visible in the other.

### Scheduled draft start visibility

Given commissioner sets a scheduled start date/time for the draft  
Then all connected owners see the scheduled start time  
And the draft does not automatically transition to RUNNING at that time  
And commissioner must still explicitly start the draft.

### Draft summary report

Given a draft reaches COMPLETE  
Then an Owner-view report is available for each team  
And a League-summary report is available to the commissioner  
And if external email delivery is enabled, each owner and the commissioner receive their respective report by email  
And email failure does not remove in-app report availability.

---

## 45. Product Principles Summary

1. Server authority beats browser state.
2. Draft history is immutable.
3. Commissioner mistakes are recoverable.
4. AAV is reference information, not strategy.
5. Owner preparation remains an advantage.
6. Draft Room is for acting; War Room is for thinking.
7. External data populates the draft; it does not operate it.
8. Every bid attempt is worth recording.
9. ESPN is the downstream destination, not the auction engine.
10. Roster state tracks draft slot fulfillment, not weekly lineup advice.
11. Auto-Agent state is explicit, visible, and auditable.
12. Disconnect recovery must respect multi-window ownership.
13. Entertainment features must never compromise auction correctness.
14. Corrections are surgical when they can be, sequential when they can't.
15. Multiple leagues can draft at once without interfering with each other.
