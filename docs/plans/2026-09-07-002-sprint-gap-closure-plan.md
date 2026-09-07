Created: 07-Sep-2026 14:00 EDT

---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
title: "Sprint: Gap Closure — PRD vs. Current Implementation"
created: 2026-09-07
---

# Sprint: Gap Closure — PRD vs. Current Implementation

**Companion documents (read before implementing anything):**
- `knowledge/PRD.md` (updated 2026-09-07 — authoritative spec, incorporates all interview decisions)
- `knowledge/data-model.md` — entity schemas, invariants (§21)
- `knowledge/state-machine-flows.md` — event types (§19), bid pipeline (§4), auto-agent cadence (§24)
- `knowledge/screen-information-architecture.md` — screen layouts, zone definitions
- `todo.md` — detailed bug descriptions with reproduction steps

**Branch:** `develop`

---

## Overview

This plan closes the gap between the current `develop` implementation and the PRD. All core phases (0–7 in `BUILD_PLAN.md`) are built. This is a fan-out sprint covering:

- 3 bugs that block reliable testing of everything else
- Server-side behavioral gaps (anti-sniping penalties, bid telemetry, Whammy auto-trigger)
- Client-side Draft Room and War Room enrichments
- Commissioner Console completions
- ESPN transfer + reports
- Mobile layout
- Design pass

**Parallelism model:** Waves 0 and 1 can overlap. Agents within each wave can run concurrently. Wave 2 starts after Wave 1 server-side work and Draft Room work are complete.

---

## Pre-flight: Shared-Types Interface Alignment

Before dispatching Wave 1 agents that touch both server event emission and client event handling, one fast pass is needed to define new event type shapes in `shared-types/protocol.ts`. This takes ~30 minutes and unblocks parallel agent work.

**New event types to define (add to `shared-types/`):**

| Event type | Payload shape |
|---|---|
| `ANTI_SNIPE_EXTENSION` | `{ player_auction_id, new_deadline_ms, seconds_added }` |
| `ANTI_SNIPE_PENALTY_APPLIED` | `{ team_id, auctions_remaining, min_seconds_required }` |
| `ANTI_SNIPE_PENALTY_EXPIRED` | `{ team_id }` |
| `WHAMMY_APPLIED` | already exists — verify payload includes `draft_id`, `team_id` or `null`, `amount_minor`, `description`, `pause_until_ms` |
| `PICKS_FEED_ENTRY` | `{ acquisition_id, player_id, player_name, team_id, team_name, price_minor, resolution_sequence, awarded_at }` (used for history feed on reconnect replay) |

**Also define the scarcity API contract** (endpoint is built by S-1; consumed by DR-2 and WR-2):

```
GET /leagues/:id/drafts/:draftId/scarcity?position=WR
Response: { league_wide_compatible_slots: number, own_team_compatible_slots: number, tier_players_remaining: { tier: number, count: number }[] }
```

Document this shape in `shared-types/` so DR-2 and WR-2 can type their fetch calls against it before S-1 lands.

**Outcome:** Updated `shared-types/protocol.ts` with event type additions and the scarcity response type. No logic changes — types only.

---

## Wave 0: Bug Fixes

All three bugs can run in parallel. They are independent. Fix these before QA-testing any Wave 1 work.

---

### BF-1: Budget units bug

**Files:** `web/src/screens/commissioner/LeagueSetup.tsx`, `server/src/league/routes.ts`, `server/db/schema/index.ts`, `server/db/seed-data.ts`

**Root-cause first.** Do not change any code until you know the answer to: where does `200250` come from? The money-is-exact-integer-minor-units constraint means all budget storage is in cents (minor units). The UI likely shows dollars and submits the dollar value without converting to minor units on the way in, OR displays the stored minor-unit value without dividing on the way out.

**Investigation steps:**
1. Read `LeagueSetup.tsx` — what value does the budget input submit?
2. Read the League create/update route in `server/src/league/routes.ts` — does it multiply by 100 before storing, or store raw?
3. Read the schema: `leagues.default_budget_minor` — check what's actually in the DB via `npm run db:seed` then a direct DB query.
4. Check display path in Draft Room / War Room — does it divide by 100 before showing?

**Fix:** one root-cause fix in the shared path (whichever side is wrong), not a guard at every callsite. If the bug is in the save path, fix the route. If it's in the display, fix the display utility. Likely both ends need correction if seed data is already corrupted.

**After fix:** reseed (`npm run db:seed`), verify every budget display across League Setup, Draft Room, and War Room shows the expected dollar amounts.

**Acceptance:** A league seeded with a `$200` starting budget displays `$200` in every screen. `npm run typecheck` clean.

---

### BF-2: Fixed header overlaps content

**Files:** shared header component (find with `rg "Commissioner.*Log out\|identity.*pill" web/src --files-with-matches`), `web/src/screens/war-room/war-room.css`, `web/src/screens/draft-complete/index.tsx`, and any screen that imports the shared header.

**This is a layout defect, not a style tweak.** The header is `position: fixed` without reserving equivalent padding at the top of page content, so the header clips over content instead of pushing it down.

**Fix:** Give `<body>` or the layout root a `padding-top` equal to the header height (use a CSS custom property so it's one value to update). Verify on every screen: League Setup, Commissioner Console, Draft Room, War Room, Draft Complete, Lobby. At `1280px` viewport the Commissioner Console's "Create Draft" button must be clickable; in Draft Room the "War Room ↗" link must be visible and clickable.

**Acceptance:** No screen has content clipped or click-blocked by the header at any viewport from `375px` to `1920px`. `npm run typecheck` clean.

---

### BF-3: 403 on /leagues/:id/players as Owner + Host Role Removal

**Files (explicit — touch all of these):**
- `server/src/player/routes.ts` — auth hook fix
- `server/src/league/auth-hook.ts` — verify no HOST-specific branches remain
- `server/src/league/routes.ts` — remove any host password generation/validation routes
- `web/src/App.tsx` — remove HOST from `AuthState.role` union (line ~36), remove from state type (~line 124), remove the "Host" dropdown option (~lines 200–204), remove HOST routing branch (~line 695)
- `shared-types/protocol.ts` — remove HOST from role union type if it lives there
- `web/src/__tests__/` — find and update any test asserting HOST behavior
- `server/src/__tests__/` — same

**Root-cause first (403 bug).** Read `server/src/player/routes.ts` — what auth hook does the players endpoint use? Per `CLAUDE.md`, `requireLeagueMember` is the correct hook for endpoints owners must read. If the endpoint uses `requireCommissioner`, that's the bug.

**Fix (403):** Change the auth hook on `GET /leagues/:id/players` from `requireCommissioner` to `requireLeagueMember`. Confirm no other player routes have the same problem.

**Fix (Host removal):** Delete all HOST-role code from all files listed above. The role no longer exists. Do not leave a "Host" option in the login UI that routes to a 403 backend. After removal, `npm run typecheck` must pass clean — no remaining references to the HOST role type.

**Acceptance:**
- A logged-in Owner can fetch `/leagues/:id/players` without a 403 during a running draft.
- The login UI shows only Commissioner and Owner (Team) options — no Host entry.
- `grep -r "HOST\|host_password" server/src web/src shared-types` returns zero results (except comments and this plan).
- `npm run typecheck` clean.

---

## Wave 1 — Server-Side Core Gaps

Three parallel work packages. Can start while Wave 0 runs.

---

### S-1: Anti-Sniping Penalty System + Scarcity Endpoint

**PRD ref:** §19, §24  
**Files to read first:** `server/src/auction/engine.ts`, `server/db/schema/index.ts`, `knowledge/state-machine-flows.md` §8

**Verified schema reality:** The current `auction_configurations` table has only `anti_snipe_threshold_ms` and `anti_snipe_extension_ms`. The current `draft_team_states` table has no anti-snipe penalty columns. All columns below must be added in a new migration.

**Schema migration needed (create file in `server/drizzle/`):**

```sql
-- auction_configurations: add mode, qualifying-bids threshold, penalty duration, penalty timing restriction
ALTER TABLE auction_configurations
  ADD COLUMN anti_snipe_mode varchar NOT NULL DEFAULT 'INFORMATIONAL'
    CHECK (anti_snipe_mode IN ('INFORMATIONAL', 'WARNING', 'ENFORCEMENT')),
  ADD COLUMN anti_snipe_qualifying_bids integer NOT NULL DEFAULT 3,
  ADD COLUMN anti_snipe_penalty_duration_auctions integer NOT NULL DEFAULT 3,
  ADD COLUMN anti_snipe_penalty_min_seconds_required integer NOT NULL DEFAULT 5;

-- draft_team_states: add per-team penalty tracking
ALTER TABLE draft_team_states
  ADD COLUMN anti_snipe_strike_count integer NOT NULL DEFAULT 0,
  ADD COLUMN anti_snipe_penalty_auctions_remaining integer NOT NULL DEFAULT 0,
  ADD COLUMN anti_snipe_penalty_min_seconds_required integer;
```

Update the Drizzle schema in `server/db/schema/index.ts` to match.

**Behavioral spec (from PRD §19 + interview):**

The anti-sniping config on `auction_configurations` has a mode: `INFORMATIONAL | WARNING | ENFORCEMENT` (now added above). `anti_snipe_threshold_ms` and `anti_snipe_extension_ms` already exist. The new columns add: qualifying-bid count before penalty, penalty duration in auctions, and the timing restriction (seconds remaining floor for penalized bids).

In `engine.ts`, after a bid is classified as a late snipe:
1. Increment `anti_snipe_strike_count` for the team in `DraftTeamState`.
2. If `strike_count >= qualifying_bids` and mode is `WARNING` or `ENFORCEMENT`: set `penalty_auctions_remaining = penalty_duration`, `penalty_min_seconds_required = config value`. Reset `strike_count`.
3. On every new `PlayerAuction` open: decrement `penalty_auctions_remaining` for all penalized teams (or handle this at auction-resolution-time).
4. In `ENFORCEMENT` mode, at bid validation time: if a team has `penalty_auctions_remaining > 0` AND the bid arrives with more than `penalty_min_seconds_required` seconds remaining → reject the bid with reason `ANTI_SNIPE_PENALTY_ACTIVE`. The team can still bid if `time_remaining <= penalty_min_seconds_required`.
5. In `WARNING` mode: classify but do not reject; broadcast `ANTI_SNIPE_PENALTY_APPLIED` for display only.
6. In `INFORMATIONAL` mode: log only, no broadcast, no rejection.

**Broadcasts (use shapes from shared-types pre-flight):**
- `ANTI_SNIPE_EXTENSION` on every deadline extension (already extended — just add the event if missing)
- `ANTI_SNIPE_PENALTY_APPLIED` when a team enters penalty
- `ANTI_SNIPE_PENALTY_EXPIRED` when `penalty_auctions_remaining` reaches 0

**Scarcity endpoint (owned by S-1 — consumed by DR-2 and WR-2):**

Build `GET /leagues/:id/drafts/:draftId/scarcity?position=WR` in `server/src/draft/` (or extend the war-room route). Auth: `requireLeagueMember`. Response shape is defined in the Pre-flight shared-types contract above. Computation: for each team, check whether they have any unfilled starter slot compatible with the queried position. Count how many teams do. Also return tier distribution of remaining (not yet awarded) players for that position. Cache or recompute on each `PLAYER_AWARDED` event — do not query on every WebSocket tick.

**Acceptance:** Write tests in `server/src/__tests__/` covering:
- Strike counter increments on classified snipe
- Penalty applied after qualifying count
- In ENFORCEMENT mode, bid rejected when team penalized + bid arrives early
- In ENFORCEMENT mode, same team's bid accepted if it arrives within the min-seconds window
- Penalty expires after configured auction count
- AUTO_AGENT bids never accrue strikes (per state-machine-flows §24)
- `GET /scarcity?position=WR` returns correct league-wide slot count after picks are made

`npm run typecheck` clean.

---

### S-2: Bid Telemetry Completion

**PRD ref:** §34  
**Files to read first:** `server/db/schema/index.ts` (find `bid_attempts` table), `server/src/auction/engine.ts` (find where BidAttempt is persisted)

**Column collision decision (resolve before writing any migration):**

`bid_attempts` already has a `server_receipt_time` column typed as `timestamp`. S-2 needs millisecond-precision epoch integers for latency math. **Decision: deprecate `server_receipt_time` (keep the column — do not drop it, existing data is there) and add `server_receipt_time_ms` as the canonical bigint going forward.** Update ALL engine insert paths that currently write `server_receipt_time` (lines ~383, 402, 451, 480, 500, 566 in `engine.ts`) to also write `server_receipt_time_ms = Date.now()` at the same point. Analytics must use `server_receipt_time_ms`; the old `timestamp` column is preserved but no longer updated by new code.

**Missing fields (from gap analysis):**

| Field | Type | Notes |
|---|---|---|
| `client_displayed_bid_minor` | `integer nullable` | Whatever price the client reported seeing; comes from the bid command payload |
| `client_auction_version` | `integer nullable` | The version the client sent with the command |
| `server_auction_version` | `integer` | The authoritative version at receipt time |
| `client_click_time_ms` | `bigint nullable` | Unix ms from client; client sends it in the command payload |
| `server_receipt_time_ms` | `bigint` | Timestamped in the WS handler before any await — see column decision above |
| `server_processing_time_ms` | `bigint` | Timestamped after persist/commit |
| `time_remaining_at_receipt_ms` | `integer` | Derived: `deadline_ms - server_receipt_time_ms` |
| `measured_latency_ms` | `integer nullable` | `server_receipt_time_ms - client_click_time_ms` when client_click_time_ms is present |
| `became_high_bidder` | `boolean` | True if this bid established new high bid |
| `timer_reset` | `boolean` | True if anti-snipe extension triggered |
| `sniping_classification` | `varchar nullable` | `CLEAN | LATE | PENALTY_ACTIVE` |
| `session_id` | `varchar nullable` | From the auth token's session identifier |
| `idempotency_key` | `varchar` | Already validated upstream — store it |

**Schema migration:** add all missing columns to `bid_attempts`. Do not drop `server_receipt_time`.

**Engine changes:**
1. In the WS handler, timestamp `server_receipt_time_ms = Date.now()` immediately on message receipt, before any await or queue entry. Pass it through the command envelope.
2. Require the client to send `client_click_time_ms` (optional, nullable — clients that don't support it send null), `client_displayed_bid_minor`, and `client_auction_version` in bid command payloads. Update `shared-types` bid command shape.
3. Populate all fields at persist time in `engine.ts`.

**Acceptance:** Insert a bid, query `bid_attempts` — all 20+ fields populated with non-null values where non-null is expected. Rejected bids also captured. `npm run typecheck` clean.

---

### S-3: Whammy Auto-Trigger + Event Pipeline

**PRD ref:** §33 (updated)  
**Files to read first:** `server/src/draft/whammy.ts`, `server/src/auction/engine.ts` (find where `PLAYER_AWARDED` is broadcast)

**Verified current state:**
- `evaluateWhammyAutoTrigger()` in `whammy.ts` (lines 638–709) is **fully implemented** — probability check, weighted selection, config guards, `WHAMMY_APPLIED` broadcast. It is already called from `awardAuction` in `engine.ts` (~line 1509).
- **Do not re-implement it.** Do not touch the probability/weight logic.
- What is actually missing: (a) the 20-second draft-pause side effect, (b) `drafts.whammy_resume_at_ms` column, (c) client-side `WHAMMY_APPLIED` handler (that's DR-1's job).

**Schema migration needed:**

```sql
ALTER TABLE drafts
  ADD COLUMN whammy_resume_at_ms bigint;
```

**Server-side work (scope is narrow — pause behavior only):**

1. After `evaluateWhammyAutoTrigger` fires (or after the manual commissioner Whammy trigger), add pause logic:
   - Set `Draft.status = PAUSED` via the same path as commissioner pause.
   - Set `drafts.whammy_resume_at_ms = Date.now() + 20000`.
   - Update the `WHAMMY_APPLIED` broadcast payload to include `pause_until_ms` (if not already there — check the existing payload shape).
2. Add an auto-resume timer in the draft's in-memory state manager: after 20 seconds from `whammy_resume_at_ms`, if the draft is still `PAUSED` and no commissioner resume happened, transition back to `RUNNING` and broadcast `DRAFT_RESUMED`. Commissioner may resume early via the existing pause/resume endpoint — that endpoint should clear `whammy_resume_at_ms` when used.
3. On server restart, if a draft has `whammy_resume_at_ms` in the future and status is `PAUSED`, re-arm the auto-resume timer.

**Acceptance:**
- A configured Whammy fires (use existing `trigger_probability: 1.0` in test config) — after it fires, `Draft.status` transitions to `PAUSED` and `WHAMMY_APPLIED` is broadcast with `pause_until_ms`.
- After 20 seconds, draft auto-resumes (transitions back to `RUNNING`, `DRAFT_RESUMED` broadcast).
- Commissioner resume before 20 seconds clears the auto-resume timer and `whammy_resume_at_ms`.
- Manual commissioner Whammy trigger also causes the 20-second pause.
- `npm run typecheck` clean.

---

## Wave 1 — Client-Side Draft Room

Two parallel packages. Can run concurrently with Wave 1 server work (they consume events; they don't need the server changes to be merged first, just the shared-types shapes from the pre-flight step).

---

### DR-1: Draft Room — Event Handlers and Indicators

**PRD refs:** §28 (latency indicator), §5.1 (nomination audio), §19 (anti-snipe indicator), §33 (Whammy display)  
**Files to read first:** `web/src/screens/war-room/index.tsx`, `web/src/screens/draft-complete/index.tsx`, the draft room's `useAuctionSocket.ts` (find it — it's the WS hook), `web/src/App.tsx`

**useAuctionSocket.ts ownership:** DR-1 owns all changes to `useAuctionSocket.ts`. DR-2 must merge after DR-1 or coordinate on a shared branch — they cannot modify this file concurrently without a guaranteed merge conflict. See dependency map.

**Tasks (all client-only, no server changes needed beyond shared-types):**

#### Connection / latency indicator (PRD §28)
- Add a `ConnectionBadge` component: color-coded pill in the header corner, always visible.
- States: `Excellent (<80ms) | Good (80-200ms) | Degraded (200-500ms) | Poor (>500ms) | Reconnecting`.
- Measure latency: send a `PING` from client on an interval (every 5s), server echoes a `PONG` with server timestamp, client computes RTT. Use existing WS connection.
- Badge: small colored dot + text + ms. Never hidden. Click to expand for detail if desired.

#### Anti-snipe extension indicator
- Handle `ANTI_SNIPE_EXTENSION` event in `useAuctionSocket.ts`.
- On receipt: show a toast "⏱ Timer extended — late bid detected" for 3 seconds.
- Handle `ANTI_SNIPE_PENALTY_APPLIED`: show a persistent badge on the affected team's name in the bid ladder ("⚠ Penalty active").

#### Whammy client display
- Handle `WHAMMY_APPLIED` in `useAuctionSocket.ts`.
- On receipt: show a prominent modal or full-overlay toast (not dismissable for 5 seconds, then auto-dismiss) with the Whammy description and amount. The draft is already paused server-side; the client should show a "Whammy! Draft paused — resuming in Xs" countdown using `pause_until_ms`.
- Handle the existing `DRAFT_RESUMED` event to clear the Whammy overlay.

#### Nomination audio playback
- Handle the `NOMINATION_AUDIO` event (verify the event type name in `shared-types`) in `useAuctionSocket.ts`.
- On receipt: if the payload contains a `nomination_audio_url`, play it via `new Audio(url).play()`, capped at 5 seconds via `setTimeout(() => audio.pause(), 5000)`.
- Only play once per team per draft — track which teams have played in component state; ignore subsequent events for the same team.

**Acceptance:**
- Connection badge is visible in the header corner on Draft Room and War Room at all times.
- Anti-snipe toast appears within 1 second of the server extending a deadline.
- Whammy overlay appears on `WHAMMY_APPLIED` and clears on `DRAFT_RESUMED`.
- Nomination audio plays for max 5 seconds on a team's first nomination; second nomination for the same team is silent.
- `npm run typecheck` clean.

---

### DR-2: Draft Room — Data Enrichments

**PRD refs:** §25, §25.1, §11, §24  
**Files to read first:** `web/src/screens/war-room/index.tsx` (War Room structure to mirror), `knowledge/screen-information-architecture.md` (zone definitions), the Draft Room component file

**Tasks:**

#### Pre-draft "Enter Draft Room" CTA (todo.md §1)
- In `web/src/screens/lobby/index.tsx` (or wherever the Lobby is): add an "Enter Draft Room" button that navigates to the Draft Room route regardless of draft status.
- The Draft Room shell already renders with zero picks made; this is a routing fix, not a new screen. Verify the shell degrades gracefully when no active auction exists (shows "Waiting for draft to start" in Zone A with controls idle).

#### All-picks history feed — Draft Room panel (PRD §25.1)
- Add a collapsible right-side panel to the Draft Room: "Picks" feed.
- Data source: the existing `PLAYER_AWARDED` event stream populates it live. On reconnect, replay `DraftEvent` log entries of type `PLAYER_AWARDED` to reconstruct the full list.
- Columns: player name, winning team, price. Sorted newest-first.
- Collapsible: collapsed by default on small viewports (< 1024px), expanded on large.

#### Zone A — Target Value color badge (PRD §11, interview)
- In Zone A (active auction panel), when the active player has a custom owner target: show a colored dot/badge next to the player name.
- **Green:** `current_bid <= owner_target`
- **Yellow:** `current_bid > owner_target` but within 5% of target OR within $2 of target (whichever threshold is greater)
- **Red:** `current_bid` exceeds the yellow threshold
- No badge when the owner has no custom target for the active player.
- Wire to the existing owner target data already in WS state.

#### Roster panel — bye week + projected points (todo.md §1)
- In the "My Roster" panel (Zone C), add two columns: `Bye` (integer week) and `Proj Pts` (formatted to one decimal).
- Data is already on the player object from the dataset; just expose it in the render.

#### Scarcity — league-wide count (todo.md §1, PRD §24)
- Zone F currently shows own-team compatible slots. Replace (or add alongside) with league-wide count.
- **The endpoint is built by S-1** (`GET /leagues/:id/drafts/:draftId/scarcity?position=WR`). DR-2 consumes it — do not build a new endpoint here. Use the type from `shared-types/` (defined in Pre-flight). Fetch on mount and refetch on each `PLAYER_AWARDED` event.

#### Recent Bids — bid type + time remaining (todo.md §1)
- The bid ladder already renders. Add two fields to the bid ladder entry type in `useAuctionSocket.ts` (DR-1 owns this file — add these changes on top of DR-1's merged output, not concurrently):
  - `bid_type`: actual enum values are `ABSOLUTE | RELATIVE | NOMINATOR_MATCH` (verified in `engine.ts:249`). Display labels: `ABSOLUTE` → "Flash", `RELATIVE` → "+$1", `NOMINATOR_MATCH` → "Match".
  - `time_remaining_at_receipt_ms`: from `BidAttempt.time_remaining_at_receipt_ms` (populated by S-2). **This field is null until S-2 lands.** Display gracefully when null: omit the "Xs left" label rather than showing "null" or crashing. The display becomes live automatically once S-2 is merged.
- Display: show a small type chip next to each bid and, when non-null, the time-remaining as "4.2s left" in small text.

**Acceptance:**
- Draft Room accessible pre-draft via Lobby CTA; shows "Waiting" state with no picks.
- Picks feed populates in real time and reconstructs on reconnect.
- Zone A badge shows correct color for current bid vs. owner target, updates on every bid event.
- Roster panel shows bye week and projected points for each acquired player.
- Scarcity shows league-wide count.
- Recent Bids shows bid type chip and time-remaining.
- `npm run typecheck` clean.

---

## Wave 1 — Client-Side War Room

Two parallel packages.

---

### WR-1: War Room — My Preparation Tab Completions

**PRD refs:** §12.1, §12.2, §12.3, §11  
**Files to read first:** `web/src/screens/war-room/index.tsx`, `web/src/screens/lobby/index.tsx`, relevant server routes in `server/src/draft/`

**Tasks:**

#### Do Not Draft tab (todo.md §2)
- Add a "Do Not Draft" tab to the War Room's My Preparation section (alongside Watch List and Nomination Queue).
- Backend: `server/src/draft/do-not-draft.ts` has working `GET /drafts/:id/do-not-draft`, `POST`, `DELETE`. These routes exist — this is a UI-wiring task.
- UI: list of DND players. Each row: player name, position, NFL team. A toggle or trash button to remove. A player search/add control at the top (reuse whatever search pattern Watch List uses).
- **Toggle only** — no notes field. See interview decisions.

#### Watch List — add missing columns (todo.md §2)
- Current: player name + Nominate + Remove.
- Add: Primary AAV (`$XX`), custom target flag (a small dot if the owner has set a custom target for this player), and status/injury indicator.
- Data is already on the player object in the API response; expose it in the table.

#### Nomination Queue — fix display (todo.md §2, PRD §12.2 updated)
- Current: order + player + reorder/remove.
- The `opening_price_minor` column is NOT needed (per interview: always $1). Remove any reference to it if it exists.
- Add: Primary AAV and availability status (available / already awarded indicator).

#### Target Values — Lobby edit (todo.md §3)
- In `web/src/screens/lobby/index.tsx`, the Targets tab is read-only. Add an edit control: click a target row → inline number input → save on blur/enter.
- POST to the existing owner target API (`/drafts/:id/targets` or similar — verify in `server/src/draft/` routes).
- Also allow add: if a player has no custom target, show an "Add Target" affordance.

#### Targets toggle (todo.md §2)
- The Targets tab currently shows customized-only. Add a toggle: "Mine" (customized targets only) vs "All" (all players with any tracked data). Wire to the existing data.

**Acceptance:**
- DND tab shows players, add/remove works, reflects in the Auto-Agent do-not-draft filter.
- Watch List shows AAV, target flag, injury status.
- Nomination Queue shows AAV and availability; no opening price column.
- Lobby Target Values tab allows adding/editing targets inline, persists on save.
- Targets toggle switches between customized-only and full list.
- `npm run typecheck` clean.

---

### WR-2: War Room — Intelligence Panels + Picks Views

**PRD refs:** §22, §23, §24, §26, §26.1  
**Files to read first:** `web/src/screens/war-room/index.tsx`, `web/src/screens/war-room/war-room.css`, `server/src/draft/war-room.ts`

**Tasks:**

#### All-picks history feed + board (PRD §26.1)
- Add two tabs or panels in the War Room for pick history:
  - **Feed tab:** identical to DR-2's Draft Room feed — chronological list of every completed pick (player, team, price, position). Newest first. Reconstructs from `PLAYER_AWARDED` replay on connect.
  - **Board tab:** grid organized by "round" (Nth pick by each team). Rows = teams, columns = pick numbers. Each cell: player name + price. Empty cells for future picks. Updates in real time.
- "Round" definition for the board: the Nth `Acquisition` by a given team, ordered by `resolution_sequence`. So column 1 = each team's first pick, column 2 = second pick, etc.

#### Player Intelligence — prior-season stats (todo.md §2)
- The War Room Player Intelligence panel (Zone A) is missing prior-season stats. The Draft Room popover has them (check that component for the data shape).
- Add a "Prior Season" stats section to the War Room panel: `{ games, rushing_yards, rushing_tds, receiving_yards, receiving_tds, passing_yards, passing_tds }` — position-appropriate subset.
- Data comes from the player endpoint or the war-room endpoint; it's already in the DB (`player_season_stats`).

#### Comparable Remaining — add columns (todo.md §2)
- Zone B currently shows: Player / Tier / AAV.
- Add: Projection (current-season projected points) and My Target (owner custom target if set, else dash).
- Wire from the existing player data already in the API response.

#### Market Context panel (todo.md §2)
- Currently missing AAV-baseline comparison and tier breakdown. Add to the Market Context section:
  - "vs. AAV baseline": current bid vs. Primary AAV as a percentage ("$34 bid · $42 AAV · −19%").
  - "Remaining by tier": for the active player's position, a compact list: `Tier 1: 2 players · Tier 2: 5 players · Tier 3+: 12 players`.
- Data: player AAV is already in auction state; tier distribution comes from the scarcity endpoint built by S-1 (`GET /leagues/:id/drafts/:draftId/scarcity?position=WR`) — use `tier_players_remaining` from its response. Do not build a separate endpoint.

**Acceptance:**
- Picks feed and board tabs in War Room show all completed picks, update in real time, reconstruct on reconnect.
- Player Intelligence shows prior-season stats for the nominated player.
- Comparable Remaining shows projection and My Target columns.
- Market Context shows bid-vs-AAV percentage and remaining-by-tier.
- `npm run typecheck` clean.

---

## Wave 1 — Commissioner Console Completions

Two packages (split to reduce per-agent scope). CC-1a and CC-1b can run in parallel — they touch different files.

---

### CC-1a: Commissioner Console — Teams CRUD

**PRD ref:** §4.1, §5.1  
**Files to read first:** `server/src/league/routes.ts`, `web/src/screens/commissioner/index.tsx`, `web/src/screens/commissioner/LeagueSetup.tsx`

**Tasks:**

#### Teams management UI (todo.md §3)
- `CommissionerConsole` has a "Teams" nav section that renders `<ComingSoon>`. Replace with a real Teams tab.
- Actions needed: list existing teams, add a team (name + password + icon + optional audio), remove a team (only before draft starts), edit team name/password.
- Backend: `POST /leagues/:id/teams`, `PATCH /leagues/:id/teams/:teamId`, `DELETE /leagues/:id/teams/:teamId`. Check if these routes exist in `server/src/league/routes.ts`. If not, implement them following the existing auth-hook convention (`requireCommissioner`). Enforce: cannot delete a team once the draft is RUNNING or later.

#### Nomination audio upload management (PRD §5.1)
- The PRD says commissioner may upload nomination audio on behalf of any team. Verify that an upload endpoint exists (`server/src/` — search for `nomination_audio` or `media`). If it doesn't exist as a commissioner-accessible endpoint (only owner-facing), add a commissioner path.
- In the Teams tab (built above), add a per-team "Upload walk-up audio" button. Accept MP3. Store the URL in `teams.nomination_audio_url` (check schema field name).
- The client-side playback is handled by DR-1.

**Acceptance:**
- Commissioner can add/remove/edit teams from the console UI before the draft starts.
- Remove is rejected (4xx) if the draft is RUNNING or later.
- Commissioner can upload nomination audio for any team from the Teams tab.
- `npm run typecheck` clean.

---

### CC-1b: Commissioner Console — Corrections + Wiring Fixes

**PRD refs:** §30, §31.1 (updated — no re-apply assist)  
**Files to read first:** `web/src/screens/commissioner/Corrections.tsx`, `web/src/screens/commissioner/DatasetImport.tsx`, `web/src/App.tsx`

**Tasks:**

#### Ambiguity Resolution screen wiring (todo.md §3)
- `AmbiguityResolution.tsx` exists and works. `App.tsx`'s `CommissionerRoute` never passes `ambiguousRows` / `onResolveAmbiguity` props.
- Read `DatasetImport.tsx` — it likely receives the import response which includes `ambiguous_rows`. Wire this to `AmbiguityResolution.tsx`. This is a props/callback wiring fix in `App.tsx` or `DatasetImport.tsx`, not new logic.

#### Rollback preview — per-pick breakdown (todo.md §3)
- Current: the Corrections screen shows a plain-language cost statement for rollback preview.
- PRD §31.1 requires a per-pick preview before confirming. Update the rollback preview to show a table: for each pick that would be reversed: player, original winner, price, and which team's budget is restored by how much.
- The data is derivable from the existing rollback preview API response — extend it if needed to include per-pick effects rather than just a summary.

#### Correction reason field (PRD §30 updated)
- Add an optional free-text "Reason for correction" input field to both the price-correct-in-place form and the rollback confirmation modal in `Corrections.tsx`.
- On submit, pass the reason in the request payload to the server correction/rollback endpoints.
- Server: add an optional `reason: string | null` field to the correction/rollback command handlers; store it in the `DraftEvent` payload. No separate audit table needed.

**Acceptance:**
- Dataset import with ambiguous players routes correctly to the Ambiguity Resolution screen.
- Rollback preview shows per-pick breakdown (player, winner, price, budget restored) before confirmation.
- Correction reason field is optional; when provided, appears in the DraftEvent payload.
- `npm run typecheck` clean.

---

## Wave 2 — ESPN Transfer + Reports

Starts after Wave 1 server-side (S-2 bid telemetry) is complete. Two parallel packages.

---

### E-1: ESPN CSV Export + Browser Automation Script

**PRD ref:** §37 (updated — CSV + automation script, no in-app guided workflow)

**Part A — Verify and complete the CSV export:**
- Read `server/src/draft/reports.ts` and the Draft Complete screen (`web/src/screens/draft-complete/index.tsx`).
- The ESPN-oriented worksheet CSV exists. Verify its columns are: team name, ESPN team ID slot (blank — commissioner fills manually), player name, position, price, roster slot assigned.
- If columns are missing or ordering is wrong, fix the export. Sort rows: by team, then by roster slot priority (starters first, then bench).

**Part B — Browser automation script:**
- Create `scripts/espn-import.ts` (or `.js`) — a standalone Playwright script, not part of the server.
- Script takes one argument: path to the CSV export file.
- Workflow:
  1. Open Chromium and navigate to ESPN's Offline Draft entry page (URL to be confirmed by commissioner running the script).
  2. Parse the CSV.
  3. For each team, for each player (in roster-slot order): find the ESPN entry field for that team/slot, enter the player name, confirm/select the match.
  4. On an ambiguous player match (ESPN shows multiple options), pause and prompt the commissioner in the terminal for which to select.
  5. Log each completed entry to stdout: `Team Alpha · Justin Jefferson · $47 · WR1 ✓`.
- Add to `package.json` as a script: `"espn:import": "npx tsx scripts/espn-import.ts"`.
- Document usage in a `scripts/README.md`.

**Acceptance:**
- CSV export produces a well-formed file with correct columns and sort order.
- Playwright script parses the CSV and logs a dry-run to stdout without a live ESPN session (add a `--dry-run` flag).
- `npm run typecheck` clean.

---

### R-1: Reports — Draft Summary Metrics + Bid Analytics + Email

**PRD refs:** §36, §35, §36.4  
**Dependencies:** S-2 (bid telemetry) must be merged first.

**Part A — Draft Summary Report §36.1–36.3 metrics:**
Read `server/src/draft/reports.ts` and the Draft Complete screen. Verify these three metrics are computed:
- **§36.1 Projected drafted-starter points:** sum of `projected_points` for each player assigned to a starter slot (not bench). Use `RosterEntry.slot_type = STARTER`.
- **§36.2 Depth metric:** sum of `projected_points` for ALL rostered players (starter + bench), labeled distinctly from §36.1. Versioned formula — add a `formula_version: "v1"` field to the report so it can change without confusion.
- **§36.3 AAV acquisition efficiency:** for each player, `(primary_aav_minor - purchase_price_minor) / primary_aav_minor * 100`, summed across all acquisitions. Label it "AAV efficiency" not "draft grade." Include a league-wide ranking.

Wire these metrics into the Draft Complete screen if not already shown.

**Part B — Bid analytics (light):**
Add a `GET /drafts/:id/analytics/bids` endpoint returning:
- Per-team bid count.
- Snipe event count (bids classified `LATE` in telemetry).
- Latency histogram: buckets `<50ms, 50-100ms, 100-200ms, 200-500ms, 500ms+` with counts.
- Match usage count per team.
- Custom/flash bid count per team.

Build a simple display in the Draft Complete screen under a "Bid Activity" tab. This is for post-draft curiosity, not real-time use — no WS subscription needed, just a REST fetch on mount.

**Part C — Email delivery:**
`POST /report/email` currently only logs. Wire it to SendGrid:
- Read `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` from env (already in `.env.example`).
- Use `@sendgrid/mail` (check if already in `package.json`; if not, add it).
- Send each owner their own-team report as HTML email. Send commissioner the league summary.
- On failure: log the error, record `ReportDeliveryAttempt.status = FAILED`, do not throw — in-app availability is unaffected.

**Acceptance:**
- Draft Complete screen shows all three metrics with correct labels.
- `GET /drafts/:id/analytics/bids` returns correct counts from telemetry data.
- With `SENDGRID_API_KEY` set: `POST /report/email` sends real emails (verify with a test address). Without it: logs a warning and skips cleanly.
- `npm run typecheck` clean.

---

## Wave 2 — Mobile Layout

Starts after DR-2 (Draft Room data enrichments) is stable. Single package.

---

### M-1: Mobile-Responsive Draft Room

**PRD ref:** §27  
**Files to read first:** `web/src/screens/war-room/war-room.css`, `web/src/screens/war-room/index.tsx`, all Draft Room CSS files

**Constraint (from interview):** Full bidding capability required on mobile. Some informational panels (War Room board, analytics, full stats) may be limited or hidden on small viewports. The core bidding experience must not be degraded.

**Priority order per PRD §27 (phone viewport, < 768px):**
1. Player name + injury indicator
2. Current bid + high bidder
3. Countdown timer
4. Primary AAV
5. Custom target badge (if set)
6. Bid controls: +$1, Flash bid, Match
7. Remaining budget + max bid
8. Roster-slot context (compact — 1 line)
9. Auto-Agent state badge
10. Connection status badge

**Implementation approach:**
- Use CSS media queries in existing CSS files — no new layout framework.
- At `< 768px`: hide or collapse: the picks history feed, full team context panel, comparable-remaining section. Keep everything in the priority list above visible and interactable.
- At `768px–1024px` (tablet): show picks feed collapsed, keep team context visible.
- Test on 375px (iPhone SE), 390px (iPhone 14), 768px (iPad).

**War Room on mobile:** show a simplified view — active auction info + My Preparation tabs only. The board and full intelligence panels are below the fold/hidden.

**Acceptance:**
- On 375px viewport: all 10 priority items visible and interactable. No horizontal scroll on the page body.
- +$1, Flash bid, Match controls are tappable with finger (44px+ touch targets).
- `npm run typecheck` clean.

---

## Wave 2 — Design Pass

Can run in parallel with Wave 2 other work. Single pass across all screens.

---

### UX-1: UI/UX Design Pass

**PRD refs:** §25, §26, §27, §28  
**Skill to invoke:** `frontend-design` or `ui-ux-pro-max`

**Scope:** Visual polish pass across the app. Not spot-fixes per feature — a coherent design language applied consistently. Focus areas from direct observation (todo.md §8):

- Typography: establish a consistent type scale (size, weight, line-height) for headers, body, labels, metadata. Replace generic system font in unstyled sections.
- Spacing: eliminate large unstyled whitespace blocks (Lobby, Commissioner Setup sections).
- Tables: replace plain HTML table styling in League Setup Teams table and League Roster/Budget Grid with a consistent table component (zebra rows, compact density, sortable headers where useful).
- Action hierarchy: visually distinguish primary actions (Bid, Nominate, Confirm) from secondary (Cancel, View Detail, Collapse) and destructive (Rollback, Remove).
- Header: after BF-2 fixes the overlap, ensure the header design is intentional — consistent height, clear identity, the connection badge is visually integrated (not floating).
- Color system: define 3–5 semantic color tokens (primary, success, warning, danger, neutral) and apply consistently. The target-value badge (green/yellow/red) should use the same tokens as other status indicators.

**Deliverable:** CSS changes and component updates. No new functionality — style only.

**Acceptance:**
- Visual audit of each screen at 1440px shows consistent typography, spacing, and color.
- No regressions in interaction behavior (all buttons still clickable, all form controls functional).
- `npm run typecheck` clean.

---

## Dependency Map

```
Pre-flight (shared-types + scarcity API contract)
  └─▶ S-1, S-2, S-3, DR-1, WR-1, WR-2, CC-1a, CC-1b (start in parallel)

BF-1, BF-2, BF-3 (parallel, no dependencies)

S-1 (anti-snipe + scarcity endpoint)
  └─▶ DR-2 Part: scarcity display (consumer of S-1's endpoint)
  └─▶ WR-2 Part: Market Context tier data (consumer of S-1's endpoint)

S-2 (telemetry)
  └─▶ DR-2 Part: time-remaining in bid ladder (ships as null-safe stub, goes live after S-2)
  └─▶ R-1 Part B (bid analytics)

DR-1 (useAuctionSocket.ts owner)
  └─▶ DR-2 (must start from DR-1's merged output for useAuctionSocket.ts changes)

DR-2 (Draft Room enrichments — starts after DR-1 merges)
  └─▶ M-1 (mobile — after Draft Room stable)

Wave 1 all complete
  └─▶ E-1, R-1, M-1, UX-1 (Wave 2 — parallel)
```

---

## Agent Assignment Summary

| Agent | Wave | Work Package | Notes |
|---|---|---|---|
| Bug-1 | 0 | BF-1: Budget units | Parallel with all |
| Bug-2 | 0 | BF-2: Header overlap | Parallel with all |
| Bug-3 | 0 | BF-3: 403 auth + Host removal | Parallel with all; must touch App.tsx |
| Server-1 | 1 | S-1: Anti-snipe penalty system + scarcity endpoint | Parallel with S-2, S-3, all client agents |
| Server-2 | 1 | S-2: Bid telemetry completion | Parallel with S-1, S-3, all client agents |
| Server-3 | 1 | S-3: Whammy pause behavior (auto-trigger already built) | Parallel with S-1, S-2, all client agents |
| DraftRoom-1 | 1 | DR-1: Event handlers + indicators (owns useAuctionSocket.ts) | Parallel with WR-1, WR-2, CC-1a, CC-1b |
| DraftRoom-2 | 1 | DR-2: Data enrichments | **Starts after DR-1 merges.** Parallel with WR-1, WR-2 |
| WarRoom-1 | 1 | WR-1: My Preparation completions | Parallel with DR-1, WR-2, CC-1a, CC-1b |
| WarRoom-2 | 1 | WR-2: Intelligence panels + picks | Parallel with DR-1, WR-1, CC-1a, CC-1b |
| Commish-1a | 1 | CC-1a: Teams CRUD + audio upload | Parallel with all Wave 1 |
| Commish-1b | 1 | CC-1b: Corrections + wiring fixes | Parallel with all Wave 1 |
| ESPN-1 | 2 | E-1: CSV + Playwright script | Parallel with R-1, M-1, UX-1 |
| Reports-1 | 2 | R-1: Summary metrics + analytics + email | After S-2; parallel with E-1, M-1, UX-1 |
| Mobile-1 | 2 | M-1: Mobile layout | After DR-2; parallel with E-1, R-1, UX-1 |
| Design-1 | 2 | UX-1: Design pass | Parallel with E-1, R-1, M-1 |

**Maximum parallel at any point:** 12 agents (Wave 0 + Wave 1 combined, after pre-flight, before DR-2 starts).

---

## What Is NOT in This Sprint

Per interview decisions — explicitly deferred or removed:

- Scoring rules in-app computation (§8): pre-computed values from import only.
- Post-freeze injury refresh (§9.4): dataset is frozen and final.
- Host role (§4.3): removed from product. Backend cleanup (routes/hooks) is part of BF-3.
- Session "kick" UI (§4.4): password change is the revocation mechanism.
- Re-apply assist after rollback (§31.1): manual re-run is sufficient.
- ESPN multi-step guided workflow: replaced by CSV + Playwright script.
- Canonical JSON export: deferred.
- Generic CSV export (non-ESPN): deferred.
- Nomination Queue per-entry opening price: always $1, no column needed.
- Commissioner separate audit table: optional reason in event payload only.
- Advanced Auto-Agent simulation/tuning: V1.
- Big-screen / spectator view: V1.
- Public shareable final board: V1.
