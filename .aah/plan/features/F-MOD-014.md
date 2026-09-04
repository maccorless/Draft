## Id

F-MOD-014

## Title

Pre-Draft Lobby Restyle and Prep Tools

## Module Ref

MOD-014

## Description

This module finishes two pre-draft screens for the Draft platform (Node.js 20 + Fastify 4.x backend, React 18 + Vite 5 + TypeScript frontend, PostgreSQL + Drizzle ORM, Zod-validated shared-types), per `module-map.yaml` (id: MOD-014) and `screen-information-architecture.md` §0 and §0.1.

**(1) Restyle SiteLogin/LeagueLogin.** `web/src/App.tsx` currently defines `SiteLogin` and `LeagueLogin` using a raw inline `styles` object (`center`, `form`, `input`, `btn`, `error` — hex colors, no design tokens), never touched by the app's brand design system. Replace every inline `style={styles.*}` usage in these two components with classes drawn from the same token system used by `web/src/screens/commissioner/commissioner-console.css`, `web/src/screens/draft-room/draft-room.css`, and `web/src/screens/war-room/war-room.css` — all of which consume the CSS custom properties defined in `web/src/styles/tokens.css` (`--color-*`, `--space-*`, `--radius-*`, `--font-*`, `--text-*`, `--shadow-*`). Add a new CSS file (e.g. `web/src/screens/auth/auth.css`, or colocated with `App.tsx`) built from those same tokens — no new hex/px literals, no new color values outside `tokens.css`. Preserve all existing behavior (site password submit, 429 handling, league/role/team selection, error states, loading states) — this is a visual-only change to these two components; do not touch `DevAutoLogin`, `CommissionerRoute`, `DraftGateway`, or the routing logic in `App.tsx`.

**(2) Pre-Draft Lobby (`web/src/screens/lobby/index.tsx`).** Per IA §0.1, the Lobby is shown to an authenticated owner once logged in but before the draft starts, for any `UPCOMING`-state draft (i.e. `draftStatus !== 'RUNNING' && draftStatus !== 'PAUSED'` — `App.tsx`'s `DraftGateway` already routes `RUNNING`/`PAUSED` drafts straight to the Draft Room, so the Lobby only ever renders for `CREATED`/`COMPLETE`... note `MOD-013` routes `COMPLETE` to `/draft-complete` instead, so in practice the Lobby is the `CREATED`/upcoming case). The component currently has zero CSS file and renders only league name, team name, and scheduled time (`formatScheduledTime`) — it has no readiness/status messaging and no prep-tool tabs. This module:

- Adds a `web/src/screens/lobby/lobby.css` file built from `web/src/styles/tokens.css`, following the same class-naming and token-usage pattern as `war-room.css`/`draft-room.css` (BEM-ish `lobby__*` classes, no ad hoc hex/px values).
- Adds a readiness/status messaging section (IA §0.1: "readiness/status messaging from the commissioner if provided") — renders MOD-010's `leagues.status_message` field (exposed via the league read the Lobby already has, e.g. `GET /leagues/:id` / `LeagueSummary`) when set, and renders nothing for this section when it is null, rather than an empty box.
- Adds a tabbed section reusing the exact pattern already implemented in `web/src/screens/war-room/index.tsx`'s "My Preparation" section (`prepTab` state, the `authedJson` helper, and the `watchlist`/`queue`/`targets` fetch+mutate functions calling `/drafts/:draftId/teams/:teamId/watchlist`, `/drafts/:draftId/teams/:teamId/nomination-queue`, and `/drafts/:draftId/teams/:teamId/target-values`) — the Lobby does not reimplement this logic differently, it extracts/mirrors the same calls against the same existing MOD-008 endpoints. Adds two further tabs beyond War Room's three: Auto-Agent configuration (calling MOD-004's existing `PUT /drafts/:draftId/teams/:teamId/auto-agent` with `willingness_pct`, per `server/src/auction/auto-agent-routes.ts`) and Do Not Draft (new, see below). Also surfaces the team icon/audio upload control from MOD-015 (`POST /leagues/:id/teams/:teamId/media`) as an additional Lobby section/tab — this module does not build that upload control itself, only mounts/wires it in the Lobby.
- The Lobby only receives a `draftId`/`teamId` for these tabs when a draft has actually been created for the league; since `DraftGateway` in `App.tsx` already resolves `active` (the picked draft) before rendering `<Lobby .../>`, thread `draftId` through as a new Lobby prop so these tabs have something to call against (currently `Lobby` receives no `draftId`).

**(3) Do Not Draft (new, PRD §12.3, data-model.md §10.4).** Do Not Draft has no existing backend anywhere. Per `data-model.md` §10.4, add a `DoNotDraftEntry`-equivalent Drizzle table (`do_not_draft_items` or similar, matching the project's existing naming convention for sibling MOD-008 tables) keyed `(draft_id, team_id, player_id)`, scoped per-team and never broadcast (same privacy posture as `OwnerTargetValue`/`OwnerPlayerTarget`). Add three REST endpoints under the existing per-team-auth pattern established by `server/src/draft/strategy.ts` (MOD-008) and `server/src/auction/auto-agent-routes.ts` (MOD-004) — JWT `preHandler`, `auth_epoch` re-read from DB, `token.team_id == :teamId` enforcement (403 on mismatch), and league-isolation check (`token.league_id == draft.league_id`, 403 on mismatch): `POST /drafts/:draftId/teams/:teamId/do-not-draft` (add), `GET /drafts/:draftId/teams/:teamId/do-not-draft` (list), `DELETE /drafts/:draftId/teams/:teamId/do-not-draft/:playerId` (remove). Wire this into `server/src/auction/auto-agent.ts`'s bid-candidate selection: both `triggerAutoAgentBidsOnNomination` and `triggerAutoAgentBidsOnLeaderChange` iterate `AUTO_AGENT`-mode teams and compute a `bidAmount` per team without ever checking which player is being bid on against that team's Do Not Draft list — add that exclusion filter (skip the team entirely for that `playerAuctionId` when its `player_id` is in that team's `do_not_draft_items` for the draft) in both functions, so a team's Do Not Draft players are never bid on by that team's Auto-Agent, while a human owner in `MANUAL` mode is unaffected (Do Not Draft only constrains Auto-Agent per PRD §12.3: "used primarily to prevent Auto-Agent acquisition").

**Behavioral expectations:**

- Given `SiteLogin` and `LeagueLogin` in `web/src/App.tsx` render, when their markup is inspected, then no element uses the inline `styles` object (`styles.center`, `styles.form`, `styles.input`, `styles.btn`, `styles.error`) — every element instead carries a CSS class resolving to properties defined via `var(--color-*)`/`var(--space-*)`/`var(--radius-*)`/`var(--font-*)` tokens from `web/src/styles/tokens.css`, matching the pattern in `commissioner-console.css`/`draft-room.css`/`war-room.css`.
- Given a user submits the site password form, when the request fails with 429, then the existing "Too many attempts" message still renders (styling changed, behavior unchanged); when it fails otherwise, "Wrong site password" still renders; when it succeeds, `onLeagues` is still called with the league list and password.
- Given an owner authenticates and their league's active draft is in an UPCOMING (`CREATED`) state, when `DraftGateway` renders, then the Lobby renders league name, team name, and scheduled-time/status text exactly as today, plus a new readiness/status-messaging section and a set of prep-tool tabs.
- Given the league's `status_message` (MOD-010) is set, when the Lobby renders, then the readiness/status-messaging section displays it; given `status_message` is null, then that section renders nothing (no empty box or placeholder).
- Given the Lobby's Watch List tab is active, when it loads, then it calls `GET /drafts/:draftId/teams/:teamId/watchlist` and renders items identically in shape to the War Room's watch list tab, and add/remove actions call the same `POST`/`DELETE .../watchlist[...]` endpoints MOD-008 already exposes.
- Given the Lobby's Nomination Queue tab is active, when it loads, then it calls `GET /drafts/:draftId/teams/:teamId/nomination-queue`, renders items in `queue_position` order, and reorder actions call `PUT .../nomination-queue` with `ordered_player_ids`.
- Given the Lobby's Target Values tab is active, when it loads, then it calls `GET /drafts/:draftId/teams/:teamId/target-values` and a submitted target calls `PUT .../target-values`.
- Given the Lobby's Auto-Agent tab is active, when the owner adjusts the willingness slider and submits, then `PUT /drafts/:draftId/teams/:teamId/auto-agent` is called with `{ willingness_pct }` in `[0, 1]` and the current value round-trips from a subsequent read.
- Given the Lobby's Do Not Draft tab is active and empty, when it loads, then `GET /drafts/:draftId/teams/:teamId/do-not-draft` returns an empty list and the tab renders an empty state (not an error).
- Given an owner adds a player to Do Not Draft from the Lobby, when the request completes, then `POST /drafts/:draftId/teams/:teamId/do-not-draft` persists a row keyed `(draft_id, team_id, player_id)` and a subsequent `GET` includes it; removing it calls `DELETE .../do-not-draft/:playerId` and a subsequent `GET` no longer includes it.
- Given a request to any Do Not Draft endpoint where `token.team_id != :teamId` in the URL, when the handler runs, then the server returns 403 and no data is read or written; given `token.league_id != draft.league_id`, the server returns 403.
- Given a team has one or more Do Not Draft player entries and that team is in `AUTO_AGENT` control mode, when `triggerAutoAgentBidsOnNomination` or `triggerAutoAgentBidsOnLeaderChange` runs for a `PlayerAuction` whose player is in that team's Do Not Draft set, then that team is excluded from the computed bid candidates for that auction (no `enqueueAutoAgentBid` call is made for that team/auction pair), while teams without that player on their Do Not Draft list are evaluated normally.
- Given a team has a Do Not Draft entry for a player, when that same team is in `MANUAL` control mode, then the owner can still manually bid on that player through the normal bid pipeline (Do Not Draft never restricts manual bidding, only Auto-Agent candidate selection).
- Given the Lobby renders the team icon/audio upload control (MOD-015), when it is present, then it calls MOD-015's existing `POST /leagues/:id/teams/:teamId/media` endpoint and does not duplicate or reimplement upload logic.
- Given the Lobby is rendered for a draft that has not yet been created for the league (no `active` draft in `DraftGateway`), when it renders, then the prep-tool tabs are omitted or shown as unavailable rather than erroring on a missing `draftId`.

## Layers

- db
- api
- ui

## Dependencies

- F-MOD-000
- F-MOD-004
- F-MOD-008
- F-MOD-015

## API Contracts
```yaml
api_contracts:
  produces:
    - operation_id: listDoNotDraft
      schema_file: schema/MOD-014-api-schema.yaml
      request_schema: "(none)"
      response_schema: DoNotDraftListResponse
    - operation_id: addDoNotDraft
      schema_file: schema/MOD-014-api-schema.yaml
      request_schema: AddDoNotDraftRequest
      response_schema: DoNotDraftEntry
    - operation_id: removeDoNotDraft
      schema_file: schema/MOD-014-api-schema.yaml
      request_schema: "(none)"
      response_schema: "204 No Content"
```

## Required Env Variables

## Lint Config

## Test Config

## Constraints
