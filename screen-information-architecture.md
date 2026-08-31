# Fantasy Football Auction Draft Platform — Screen Information Architecture

**Status:** Working UX / information-architecture specification  
**Last updated:** 2026-08-30  
**Companion documents:** `prd.md`, `data-model.md`, `state-machine-flows.md`

---

# 0. Access / Login Flow

## Primary user question

> How do I get into my league's draft?

Steps:

1. **Site password.** Single shared password gates the whole application.
2. **League select.** Choose from leagues the site password grants visibility into.
3. **Role select.** Commissioner (enter league password) or Team/Owner (continue to team select).
4. **Team select** (Owner path only). Choose team from the league's team list.
5. **Team password.** Enter the selected team's password.

On success, the session carries role + league + team identity for the rest of the app (Draft Room, War Room, Commissioner Console).

Keep this flow minimal: no account creation, no password reset, no email step in MVP. A future version replaces password entry with an emailed magic link.

## 0.1 Pre-Draft Lobby (after login, before draft starts)

Shown to owners once authenticated but before the commissioner starts the draft.

Show:

- league name/logo;
- scheduled draft start date/time (or "Not yet scheduled");
- own team name/icon;
- readiness/status messaging from the commissioner if provided.

---

## 1. Screen Architecture Principles

The product should distinguish three jobs:

- **Draft Room:** act quickly and confidently.
- **War Room:** understand the market and prepare the next move.
- **Commissioner Console:** operate, recover, and correct the draft.

The same data may appear in multiple places, but the **visual priority must differ by job**.

---

# 2. Draft Room — Primary Auction View

## Primary user question

> What is happening right now, and what should I do in the next few seconds?

This screen should have the lowest cognitive load.

---

## 2.1 Persistent Zone A — Active Auction

Always visible and visually dominant.

Show:

- player name;
- NFL team;
- position;
- injury indicator if relevant;
- current high bid;
- current high bidder;
- authoritative timer;
- nomination owner;
- auction phase:
  - second-bid;
  - rebid;
  - paused.

Optional compact secondary facts:

- Primary AAV;
- custom Target if actually customized;
- tier;
- number of same-tier players remaining.

Do **not** show full stats here.

---

## 2.2 Persistent Zone B — Recent Accepted Bids

This is a core Draft Room feature.

### Desktop

Show the last **3–5 accepted bids** for the active player.

Example:

```text
RECENT BIDS

$43  Rush Hour          18s left
$42  Victorious Secret  21s left
$41  Rush Hour          24s left
$38  Big TD Energy      27s left
```

Useful fields:

- bid amount;
- team/icon;
- time remaining when bid arrived;
- bid-type indicator only when notable:
  - Match;
  - custom jump.

Do not show rejected bids here.

### Mobile

Compact to one line:

```text
Recent: Rush $43 ← You $42 ← Rush $41
```

Tap expands the ladder.

---

## 2.3 Persistent Zone C — My Team Context

Always visible near bid controls.

Show:

- remaining budget;
- maximum legal bid;
- roster count, e.g. `7 / 17`;
- open starter slots;
- what the active player would fill.

Example:

```text
MY TEAM

Budget       $116
Max bid      $108
Roster       7 / 17

Open starters
RB · WR · FLEX

If won:
WR2
```

Possible outcomes:

- `Would fill: RB2`
- `Would fill: FLEX`
- `Would be: BENCH`

That last line should be visually prominent.

---

## 2.4 Persistent Zone D — Bid Controls

Large and stable location.

Controls:

- `+$1`;
- custom amount input;
- `BID`;
- `MATCH $X` only when available;
- optional `MAX` helper if retained.

Rules:

- button text should show resulting amount where practical:
  - `+$1 → $44`;
  - `Match $43`;
- stale bid rejection appears directly here;
- disabled actions explain why.

Example:

> Price changed to $47 — bid not placed.

---

## 2.5 Persistent Zone E — State / Health

Compact, not dominant.

Show:

- connection health;
- Auto-Agent state;
- anti-sniping penalty if active.

Example:

```text
● 42 ms
AUTO
```

If owner enters Auto-Agent, badge becomes unmistakable.

---

## 2.6 Contextual Zone F — Compact Scarcity

Keep very small.

Example:

```text
WR Tier 1
3 remaining
8 compatible starter slots open league-wide
```

This should not grow into a dashboard.

---

# 3. Draft Room — Optional Expandable Player Detail

On single-desktop setups, clicking player opens a side panel/popover.

Include:

- prior-season stats;
- projections;
- injury detail + freshness;
- all visible AAVs;
- owner's Target;
- tier;
- comparable remaining players.

This panel should be dismissible without losing bidding controls.

---

# 4. War Room — Secondary Desktop

## Primary user question

> What is happening across the draft, and what should I prepare for next?

The War Room should **automatically follow the current nominated player**, but it should not duplicate the Draft Room layout.

Divide it into four persistent regions.

---

## 4.1 War Room Zone A — Player Intelligence

Upper-left / primary detail area.

Show:

- active player;
- prior-season stats;
- projected stats;
- projected fantasy points;
- injury detail/freshness;
- bye;
- tier;
- all configured AAV sources;
- My Target if customized.

Example:

```text
Justin Jefferson · WR

2025 pts       287.6
2026 projected 278.2
Tier           WR1 / Tier 1
Status         Healthy · updated 22m ago

AAV
ESPN           $46
FantasyPros    $51

My Target      $58
```

---

## 4.2 War Room Zone B — Alternatives / Tier Board

Directly beneath active player context.

### Same tier

```text
WR TIER 1 — 3 REMAIN

Jefferson    ACTIVE
Chase        $48 AAV
Nacua        $38 AAV
```

### Comparable remaining

Mechanically selected, not recommendations.

Columns:

- player;
- tier;
- projection;
- Primary AAV;
- My Target if customized;
- availability.

Avoid language such as:

- Best alternative;
- Better value;
- Recommended.

---

# 5. War Room — League Roster/Budget Grid

This should probably be the most important persistent War Room component.

## Primary user question

> Who can still compete with me for players at this position?

Rows = teams.

Columns:

- team icon/name;
- budget remaining;
- max legal bid;
- roster count;
- QB;
- RB;
- WR;
- TE;
- Flex;
- other starter slots;
- Bench;
- Auto-Agent status.

Example:

| Team | $ | Max | RB | WR | Flex | Bench |
|---|---:|---:|---:|---:|---:|---:|
| Rush Hour | 141 | 130 | 1/2 | 2/2 | Open | 2/8 |
| Dawgs | 168 | 157 | 2/2 | 1/2 | Open | 1/8 |
| Gridiron | 92 | 81 | 2/2 | 2/2 | Filled | 4/8 |

Use visual states:

- open starter;
- filled starter;
- bench;
- complete roster.

### Position focus

When a WR is active, optionally emphasize:

- teams with open WR-compatible starter slots;
- teams with highest remaining budgets.

Do not reorder rows unpredictably unless owner chooses sort/filter.

---

# 6. War Room — Recent Auction Activity

This is broader than active-player bid history.

Show recent completed/active auctions:

```text
ACTIVE
Jefferson
Rush $43 ← Victorious $42 ← Rush $41

SOLD
CeeDee Lamb — $52
Big TD Energy
7 bids · 4 bidders

SOLD
Amon-Ra St. Brown — $47
The Dawgs
12 bids · 3 bidders
```

Useful compact metrics:

- purchase price;
- winner;
- total accepted bids;
- unique bidders;
- Primary AAV difference.

No need to show every bid unless expanded.

---

# 7. War Room — My Preparation

Persistent right-side or tabbed panel.

Include:

## 7.1 Watch List

Show:

- player;
- AAV;
- Target if custom;
- status;
- quick `Nominate` button during owner's turn.

Watch List never auto-nominates.

## 7.2 Nomination Queue

Ordered list.

Show:

- position/order;
- player;
- opening price;
- availability.

Drag/reorder or accessible up/down controls.

## 7.3 Do Not Draft

Small separate list/filter.

## 7.4 Targets

Filter:

- customized targets only;
- all tracked players.

---

# 8. War Room — Market Context

This is where broader auction statistics belong.

Show factual measures such as:

```text
League spending

Actual spent      $742
ESPN AAV drafted  $711
Actual vs ESPN    +4.4%
```

Also:

- dollars remaining league-wide;
- average budget remaining;
- players drafted by position;
- remaining players by tier.

Do **not** convert this into a recommended player price.

---

# 9. Commissioner Console

## Primary user question

> Is the draft healthy, and can I fix problems immediately?

Persistent areas:

### 9.1 Draft Health

- status;
- current round/cycle;
- auctions completed;
- current Player Auction;
- current timer;
- connected owners;
- Auto-Agent teams;
- reconnecting teams;
- warning/error state.

### 9.2 Live Interventions

- pause/resume;
- timer adjustment;
- nominate for team;
- bid for team;
- put team in Auto-Agent;
- resume manual control;
- return player;
- change winner;
- change price;
- manual award.

### 9.3 Budget / Roster

All-team grid with editable controls behind explicit commissioner action.

### 9.4 Correction and Rollback

- **Correct this pick**: available on any already-awarded pick; if the winning team has drafted again since, the UI explains why direct correction is blocked and offers "Rollback last N picks" instead.
- **Rollback**: pick a target pick or a number of picks (N); preview every pick, team, and budget/roster effect that undoing back through it will touch; confirm undoes them in order, most recent first.

### 9.5 Whammy

- trigger/status;
- pending approval;
- apply/reject.

### 9.6 Audit

Recent commissioner actions and system exceptions.

---

# 10. Draft Board / Presentation View

This is different from the owner Draft Room.

Primary purpose:

> Give the room a shared visual representation of the draft.

Show:

- team columns/cards;
- team icons;
- acquired players;
- acquisition price;
- budget remaining;
- Auto-Agent badge;
- current nominator;
- current auction summary;
- recent sold-player card.

Optional:

- first-nomination audio;
- ephemeral winner animation.

Do not overload with personal Target values or private strategy.

---

# 11. Mobile Draft View

The mobile hierarchy should be aggressively simple.

### Above the fold

```text
Justin Jefferson
WR · MIN

0:18

$43
Rush Hour

ESPN $46
My Target $58

Would fill WR2

[ +$1 → $44 ]

$ [      ] [ BID ]

[ Match $43 ]
```

Then:

```text
Budget $180 · Max $169 · Roster 4/17
```

Then compact recent bids:

```text
Rush $43 ← You $42 ← Rush $41
```

Expandable below:

- player detail;
- roster;
- Watch List;
- league budgets;
- history.

---

# 12. Global Notification Model

Broadcast toasts should be reserved for **meaningful shared state changes**, not every action.

Broadcast:

- team entered Auto-Agent;
- team resumed manual;
- commissioner paused/resumed draft;
- major commissioner correction;
- rollback completed;
- Whammy event;
- connection-related Auto-Agent takeover.

Do not toast every bid; live bid UI already communicates that.

Example:

> Rush Hour entered Auto-Agent mode.

---

# 13. Information Placement Matrix

| Information | Draft Room | War Room | Mobile | Commissioner |
|---|---|---|---|---|
| Current bid | Primary | Yes | Primary | Yes |
| Timer | Primary | Yes | Primary | Yes |
| High bidder | Primary | Yes | Primary | Yes |
| Last 3–5 bids | Primary | Yes | Compact | Yes |
| My budget | Primary | Yes | Primary | Yes |
| Max bid | Primary | Yes | Primary | Yes |
| Would fill starter/bench | Primary | Yes | Primary | Yes |
| Primary AAV | Primary | Yes | Primary | Yes |
| Secondary AAV | Optional | Yes | Detail | Yes |
| My Target | If custom | Yes | If custom | No/private only if permitted |
| Tier | Compact | Primary context | Compact | Optional |
| Comparable players | Expand | Primary | Detail | No |
| Player stats | Expand | Primary | Detail | No |
| Injury freshness | Compact/expand | Primary | Detail | Optional |
| All-team budgets | Minimal sidebar | Primary | Detail | Primary |
| All-team starter needs | Compact | Primary | Detail | Primary |
| Watch List | Small/hidden | Primary | Tab | No |
| Nomination Queue | Small/hidden | Primary | Tab | No |
| Full bid telemetry | No | Expand/history | No | Audit/history |
| Rejected bids | No | History only | No | Audit |
| Auto-Agent badge | Primary | Primary | Primary | Primary |
| Market spend vs AAV | No | Yes | Detail | Optional |
| Rollback | No | No | No | Primary |

---

# 14. Desktop Layout Recommendation

For a standard widescreen desktop:

```text
┌──────────────────────────────────────────────────────────────┐
│ Header / Draft Status                                       │
├───────────────┬──────────────────────────────┬───────────────┤
│ Team Summary  │        ACTIVE AUCTION        │ Recent Bids   │
│               │                              │               │
│ budgets       │ player                       │ $43 Rush      │
│ rosters       │ price / bidder / timer       │ $42 You       │
│ auto badges   │ AAV / target / tier          │ $41 Rush      │
│               │ would-fill context           │               │
│               │                              │               │
│               │ BID CONTROLS                 │               │
├───────────────┴──────────────────────────────┴───────────────┤
│ Last purchase / next nominator / connection status          │
└──────────────────────────────────────────────────────────────┘
```

Recommendation: place **Recent Bids in a dedicated right rail** rather than underneath the player so the live price battle remains continuously visible while preserving a clean central bidding column.

---

# 15. War Room Layout Recommendation

```text
┌──────────────────────────────────────────────────────────────┐
│ Current Player / AAV / Target / Injury                       │
├──────────────────────────────┬───────────────────────────────┤
│ Tier + Comparable Players    │ My Watch / Queue / Targets    │
├──────────────────────────────┴───────────────────────────────┤
│                 LEAGUE ROSTER / BUDGET GRID                  │
├──────────────────────────────┬───────────────────────────────┤
│ Recent Auction Activity      │ Market / Position Context     │
└──────────────────────────────┴───────────────────────────────┘
```

The league roster/budget grid gets the largest horizontal area because it is the hardest information to hold mentally during an auction.

---

# 16. Team Summary Recommendation

The prior mockup treated the team list mainly as budget + roster count.

Prefer **budget + starter-needs context**.

Example:

```text
Rush Hour
$141
RB1 open · FLEX open

The Dawgs
$168
WR2 open · TE open · FLEX open
```

This is more useful during bidding than only showing `7/17`.

---

# 17. Priority Changes for the Next Mockup

The next visual mockup should emphasize these more strongly than the prior version:

1. **Recent bid ladder**
2. **"Would fill" starter/bench context**
3. **Competitor starter needs**
4. **Auto-Agent state**
5. **League roster/budget grid in War Room**
6. **Tier/comparable-player context**
7. **AAV as reference, not recommendation**

The design should avoid treating every feature as equal visual weight.

---

# 18. Draft Summary Report

## Primary user question

> How did my draft go, and how did the whole league do?

Shown once the draft reaches COMPLETE. Two views:

### Owner view

- full pick list: player, price, slot assigned;
- total spend, remaining budget;
- DraftTeamEvaluation metrics (projected drafted-starter points, roster depth, AAV efficiency).

### League summary view (commissioner, and optionally all owners)

- all teams' spend, roster completion, and evaluation metrics side by side;
- league-wide spend vs. selected AAV source.

Both views are viewable and downloadable in-app regardless of email configuration. If external email delivery is enabled, the Owner view is emailed to each owner and the League summary view is emailed to the commissioner; email failure never removes in-app access.
