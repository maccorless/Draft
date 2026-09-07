# Gap Review — TODO

- [ ] 2026-09-06: `.env` needs a real `SENDGRID_FROM_EMAIL` value (and confirmed `SENDGRID_API_KEY`) — F-MOD-006-rework-01's official (non-provisional) test evidence couldn't be produced without it; currently only accepted on provisional evidence (25/25 passing).

Full-solution review against `knowledge/PRD.md`, `knowledge/data-model.md` §21,
`knowledge/state-machine-flows.md`, and `knowledge/screen-information-architecture.md`,
plus hands-on testing of the running app (backend on :3050, frontend on :5173,
Commissioner + Owner sessions, a live draft with Auto-Agent bidding).

Not yet organized into sprints — that's the next pass. Nothing in this file has
been implemented.

---

## 0. Bugs found by direct testing (not spec gaps — actual defects)

- [ ] **Starting budget stored/displayed wrong.** League Setup's "Starting budget ($)"
  field held `200250` and every team in Draft Room / War Room / Draft Control shows
  budgets like `$200,249` / `$200,250` instead of an expected `$200`. League-wide
  remaining budget summed to ~$2.4M across 12 teams, so this isn't a display fluke —
  it's a real stored value. Given the project's money-is-exact-integer-minor-units
  constraint, this smells like a dollars/cents (minor-units) conversion bug in the
  League Setup save path or a display-path bug that fails to divide by 100. Needs a
  root-cause pass, not just a data fix — reseeding will just recreate it if the bug is
  in code.
- [ ] **Fixed header overlaps page content, and at some viewport widths blocks clicks
  entirely.** The "Commissioner/Owner · Team · Log out" pill in the top-right is
  positioned on top of page content instead of reserving space for itself. Reproduced
  twice: (1) at ~1280px viewport width, the Commissioner Console's "Create Draft"
  button was fully unclickable — Playwright's click retried for 5s and timed out
  because the logout pill intercepted pointer events; worked fine at 1440px. (2) In
  Draft Room, the nominated-player card's title ("Amon-Ra St. Brown") renders directly
  underneath the "Owner · Alpha Wolves / Log out" pill, clipped. This is a systemic
  layout defect (shared header component), not a one-off — check every screen. Notably,
  this bug is why Draft Room's existing "War Room ↗" button (`draft-room__war-room-link`,
  already implemented, opens War Room in a new tab) was invisible during review — it
  renders in the same topbar health cluster the identity pill covers. Fixing this bug
  surfaces an already-built feature, not just a visual fix.
- [ ] **403 Forbidden fetching `/leagues/:id/players` as an Owner in Draft Room.**
  Console showed two repeated 403s hitting this endpoint while logged in as a team
  owner during a running draft. The screen still rendered an Available Players list,
  so impact is unclear — but a failing authorized request during the core draft loop
  needs to be understood, not left silently failing in the console.

---

## 1. Draft Room

- [ ] **No pre-draft entry point.** Lobby only auto-redirects to Draft Room once the
  draft status is RUNNING/PAUSED — before that, an owner has no manual "Enter Draft
  Room" control at all (only "Open War Room ↗" is exposed pre-draft). Confirmed via
  user decision: Draft Room should use the **same shell** in this pre-draft state
  (team strip, My Roster, budgets all populated; nomination/bid controls idle with a
  "waiting for draft to start" message) rather than a separate lightweight view — so
  this is mainly a routing/entry-point fix (add a persistent Lobby CTA that doesn't
  wait for RUNNING) plus verifying the existing shell degrades gracefully with zero
  picks made and no active auction. This turns Draft Room + War Room into the
  pre-draft "walk around and prep" experience the user wants, matching how War Room
  is already reachable pre-draft.
- [ ] **All-picks history feed** (ESPN-style "Picks" sidebar). Confirmed via user
  decision, in scope. Draft Room currently only shows "Recent Bids" for the *current*
  active auction — there's no persistent feed of every pick made in the draft so far
  (player, team, price), the way ESPN's screenshot shows a running right-rail list.
- [ ] **Round-by-round Board view.** Confirmed via user decision, in scope. ESPN's
  reference screenshot has a "Board" tab showing every pick organized by round with
  player/team/points/price columns. This auction drafts differently from snake
  drafts (no fixed "rounds" tied to draft order), so "round" here likely needs to mean
  something like "Nth pick made by each team" or a simple chronological grid — needs a
  design decision during sprint planning, not now, but the feature itself is confirmed
  wanted.
- [ ] **Roster panel enhancement: bye week + points columns.** Confirmed via user
  decision, in scope. My Roster currently shows position/player/price only; ESPN's
  reference shows bye week and season/projected points per rostered player. The
  player data already carries bye_week (per the MOD-016 player-intelligence work) and
  projected_points — likely a display-only addition, not new data.
- [ ] Anti-snipe extension has no client-visible indicator. Server extends the rebid
  deadline (`engine.ts`) but never tells the client an extension happened — the UI
  just shows a longer countdown with no badge/toast explaining why.
- [ ] No Whammy event display anywhere. Server fully implements and broadcasts
  `WHAMMY_APPLIED`; `useAuctionSocket.ts` has no case for it, so a Whammy firing
  mid-draft is invisible to players in both Draft Room and War Room. (See §5 below —
  this pairs with building out Whammy auto-trigger.)
- [ ] Zone F scarcity indicator only shows own-team open compatible slots, not the
  league-wide count the IA spec calls for.
- [ ] Recent Bids ladder shows amount + team only — missing bid type (Match vs. custom
  jump) and time-remaining-when-bid-arrived that the IA spec lists as useful fields.
  `useAuctionSocket`'s bid-ladder entry type doesn't carry either field yet.
- [ ] Zone A doesn't compactly show "customized Target" when a team has set a custom
  Owner Target Value for the nominated player — only visible inside the detail popover.

**Already solid, no action needed:** player identity/injury/timer/phase/AAV/tier in
Zone A, My Team Context (Zone C), Bid Controls incl. stale-bid rejection (Zone D),
connection health + Auto-Agent badge (Zone E), full expandable player detail popover,
Nominator Match, persistent available-players list with search/position filter.

---

## 2. War Room

- [ ] **Do Not Draft has zero UI.** Backend is fully built (`server/src/draft/do-not-draft.ts`
  has working GET/POST/DELETE) but War Room never calls it — no tab, no fetch, no
  render. This is close to a free win: wire an existing API to a new small panel.
- [ ] Market Context is missing the AAV-baseline comparison entirely — no "actual vs.
  AAV %" and no "remaining players by tier," both named in the IA spec's example.
- [ ] Recent Activity metrics endpoint (`war-room.ts`) is missing unique-bidder count
  and Primary-AAV-difference, both named in the IA spec. `useAuctionSocket` already
  tracks a unique-bidder count elsewhere in the app — this may just need wiring
  through to this endpoint rather than new computation.
- [ ] Player Intelligence panel (Zone A) is missing prior-season stats — present in
  Draft Room's popover, absent here despite the IA spec listing it for War Room too.
- [ ] Comparable Remaining table (Zone B) is missing projection and My Target columns
  — only Player/Tier/AAV currently shown.
- [ ] Watch List shows player name + Nominate + remove only — missing AAV, custom
  Target flag, and status columns even though the underlying data already carries AAV.
- [ ] Nomination Queue shows order + player + reorder/remove only — missing opening
  price and availability, even though the underlying data already carries AAV.
- [ ] Targets tab always shows customized-only; the IA spec wants a toggle between
  "customized" and "all tracked" targets.
- [ ] (Optional, low priority) League Roster/Budget Grid doesn't highlight teams with
  open compatible slots or highest budget when a position is actively being bid on.

**Already solid, no action needed:** League Roster/Budget Grid core columns, Recent
Activity ACTIVE/SOLD sections, My Preparation tab structure (Watch/Queue/Targets with
working add/remove/reorder/nominate).

---

## 3. Commissioner Console / Lobby / Auth

- [ ] **"Teams" nav section is a literal placeholder** (`<ComingSoon>`), and there is
  no way to add or remove a team from a league through the app at all — teams only
  exist via the dev seed script. This blocks any real (non-seeded) league from ever
  being set up.
- [ ] **Ambiguity Resolution screen is fully built but dead code.** `AmbiguityResolution.tsx`
  exists and works, but `App.tsx`'s `CommissionerRoute` never passes it the
  `ambiguousRows`/`onResolveAmbiguity` props, so a commissioner can never actually
  resolve an ambiguous CSV player match in the running app today. This is a wiring
  fix, not new feature work — likely a fast win.
- [ ] Login screen's role selector only offers Commissioner/Owner — no Host option,
  even though the backend and the League Setup password generator both fully support
  HOST as a role.
- [ ] Rollback preview (Corrections screen) shows the reversed-picks list and a
  plain-language cost statement, but not the PRD's required detailed per-pick,
  per-team budget/roster/Whammy-effect breakdown before confirming.
- [ ] Draft summary email delivery (`POST /report/email`) is a backend stub that only
  logs intent — no actual email send. SendGrid (or equivalent) wiring was explicitly
  deferred; the "email report" button in Draft Complete currently does nothing real.
- [ ] Lobby's Target Values tab is read-only — an owner can see existing custom Owner
  Target Values but there's no control to actually set or edit one from the Lobby.

**Already solid, no action needed:** full auth/session/role-routing flow, Pre-Draft
Lobby (media upload, Watch List, Nomination Queue, Do Not Draft, Auto-Agent config),
League Setup (identity, passwords, roster/auction/AAV/Whammy config, per-team budget
override, Pre-Draft Readiness checklist), Dataset Import (CSV/Excel/ESPN-PDF/FantasyPros
with per-row errors), Draft Control (health, pause/resume/start, timer extend,
nominate/bid-on-behalf, manual↔auto-agent toggle, budget adjustment, audit log),
Corrections & Rollback (price-correct-in-place with legality preview, rollback with
cost preview, Whammy trigger + approval workflow), Draft Complete (pick list, league
summary, CSV/ESPN-worksheet download).

---

## 4. ESPN post-draft roster transfer — in scope, own sprint

Confirmed via user decision: build this out fully, not just log the gap.

- [ ] Team → ESPN-team mapping step (no code exists for this anywhere).
- [ ] Reconciliation tracking: "mark player transfer confirmed" state — no schema
  columns or endpoints currently exist for this.
- [ ] Canonical JSON export. PRD calls for three distinct outputs — canonical JSON,
  generic CSV, and an ESPN-oriented worksheet — only the CSV worksheet is built today.
- [ ] Guided step-through of ESPN's Offline Draft entry flow. Currently reduced to a
  single CSV download button in Draft Complete; needs to become an actual multi-step
  guided flow per the PRD.
- [ ] Ambiguous-mapping flagging for the transfer step itself (distinct from the
  dataset-import ambiguity resolution, which already works once §3's wiring fix lands).

---

## 5. Anti-snipe penalty system — in scope, per PRD

Confirmed via user decision: build the full punitive system, not just deadline
extension.

- [ ] Penalty modes (informational / warning / enforcement) — none exist; currently
  only deadline-extension behavior is implemented.
- [ ] Qualifying-late-bid counter per team.
- [ ] Penalty duration applied against a team's later `PlayerAuction`s.
- [ ] Visible penalty indicator in Draft Room / War Room UI.
- [ ] No `penalty` / `sniping_event` concept exists anywhere in `engine.ts` or the
  schema today — this is new schema plus new engine logic, not a UI-only add.

---

## 6. Bid telemetry & analytics — in scope, own sprint

Confirmed via user decision: real schema migration + new computation, planned as a
named workstream (ties to the append-only-history architectural constraint).

- [ ] `bid_attempts` table has 11 of the ~20 fields PRD §34 requires. Missing:
  client-displayed bid, client/server auction version, client click time,
  server processing/acceptance time, time-remaining-at-receipt, measured latency,
  became-high-bidder flag, timer-reset flag, sniping classification, session/device
  identifier, idempotency key.
- [ ] Bid analytics (§35) has zero implementation — no analytics computation or
  storage anywhere in the codebase. This is blocked by the telemetry gap above and
  should be sequenced after it.
- [ ] Verify JWT token expiry (~48h) is actually enforced at verify-time — the gap
  review confirmed auth_epoch revocation is checked everywhere, but did not confirm
  the `exp` claim itself is checked. Needs a targeted follow-up (not confirmed broken,
  just unconfirmed).

---

## 7. Whammy auto-trigger — in scope, per PRD

Confirmed via user decision: build probability/weight-based auto-triggering in
addition to the existing manual trigger.

- [ ] Probability/weight field(s) per configured Whammy event type.
- [ ] Automatic trigger-rule evaluation (currently 100% commissioner-manual —
  `server/src/draft/whammy.ts` has no probability/weight/auto-trigger logic at all).
- [ ] Client-side Whammy event display (see Draft Room / War Room gap above — this
  auto-trigger work and that missing UI notification are the same underlying gap
  from two different angles: server can now fire more often, and nothing shows it).

---

## 8. General UI/UX polish — needs a UI skill pass before/alongside sprint work

Direct observation confirms the user's read: the app is functionally further along
than it looks, but visually and interaction-wise it reads as unstyled/default —
generic system font in places, large unstyled whitespace blocks (e.g. Lobby), plain
HTML table styling in dense screens (League Setup Teams table, League Roster/Budget
Grid), no visual hierarchy distinguishing primary vs. secondary actions, the header
overlap bug in §0. This needs a real design pass (frontend-design or ui-ux-pro-max
skill), not spot-fixes — recommend treating it as its own sprint-level workstream
once we get to sprint planning, rather than folding polish into each feature gap
above piecemeal.

---

## Next step

Organize everything above into sprints. Suggested sequencing questions for that pass:
does the §0 bug list (budget bug, header overlap, 403) block starting any other
sprint, or can it run in parallel; does §3's Ambiguity Resolution wiring fix and
§2's Do Not Draft UI wiring (both: real backend + dead/missing UI, likely fast) get
bundled as a "quick wins" sprint before the larger §4/§5/§6/§7 workstreams.
