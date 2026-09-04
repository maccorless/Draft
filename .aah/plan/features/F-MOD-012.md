## Id
F-MOD-012

## Title
Commissioner Corrections, Rollback, and Whammy UI

## Module Ref
MOD-012

## Description
Replaces the `ComingSoon` placeholder currently rendered for the "Corrections & Rollback" nav
section of the Commissioner Console (`web/src/screens/commissioner/index.tsx`, `ConsoleSection ===
'corrections'`) with a real React + TypeScript UI, and adds a Whammy panel to the same section. Both
backends are already fully built and tested — this module wires the UI to existing endpoints and adds
no new server logic:

- `server/src/draft/corrections.ts` — `POST /drafts/:draftId/corrections/price` and
  `POST /drafts/:draftId/rollback`.
- `server/src/draft/whammy.ts` — `POST /drafts/:draftId/whammy`,
  `POST /drafts/:draftId/whammy/:whammyId/approve`, `POST /drafts/:draftId/whammy/:whammyId/reject`.

Ground the flow in PRD §31 (Commissioner Correction and Rollback), §33 (Whammy Framework), and
`screen-information-architecture.md` §9.4 (Correction and Rollback) and §9.5 (Whammy). All requests
are commissioner-authenticated (`Authorization: Bearer <token>`, the same `token` prop pattern used
by `DatasetImport`/`AmbiguityResolution` in this console) and target the currently selected
`draftId`/`leagueId`.

**Price correction (in-place; PRD §31.1, IA §9.4).** A form lets the commissioner pick an
already-awarded acquisition (pick), enter a new price, and see — before confirming — the plain
old-price vs. new-price comparison, this team's budget delta (`old_price_minor - new_price_minor`),
and the resulting remaining budget, computed client-side from the selected acquisition's current
price and the team's current remaining budget (no separate server-side check endpoint exists; the
correction endpoint itself is the only legality check, per `corrections.ts`'s ledger-replay gate).
Confirming calls `POST /drafts/:draftId/corrections/price` with `{acquisition_id, new_price_minor}`.
A `200` (`PriceCorrectionResponse`: `acquisition_id, old_price_minor, new_price_minor, team_id,
new_remaining_budget_minor`) shows the applied result and updates the team's displayed budget. A
`409 CORRECTION_ILLEGAL` shows the server's plain-language refusal and offers a "Roll back instead"
action that opens the Rollback panel pre-targeted at that pick. The form only ever edits price — per
PRD §31.1/§31.2, a wrong winner or wrong player is never edited in place — so the UI additionally
offers a direct "Wrong winner or player? Roll back instead" affordance next to the price form for
that case, which also opens the Rollback panel pre-targeted at that pick.

**Rollback (PRD §31.1, IA §9.4).** A panel lets the commissioner choose a target pick or a count `N`
of most-recently-resolved picks to undo. Before confirming, the UI shows the plain-language cost
statement (e.g. "This will undo picks #18 through #10 (8 players). Those players return to the
pool.") derived from the currently active acquisitions ordered by `resolution_sequence`, followed by
the detailed per-pick preview (player, team, price for each pick that will be reversed). If the draft
is not already `PAUSED`, the UI pauses it first (existing pause control/endpoint from MOD-002,
`server/src/auction/routes.ts` — MOD-011 only wires a button to this pre-existing endpoint, it
does not build it) before
submitting. Confirming calls `POST /drafts/:draftId/rollback` with `{count}`. A `409
DRAFT_NOT_PAUSED` or `409 NO_PICKS_TO_ROLLBACK` is shown inline without side effects. A `200`
(`RollbackResponse`: `rolled_back, picks_reversed[]` — each `{acquisition_id, player_name, team_id,
price_minor}`) immediately surfaces the **re-apply assist**: the undone picks, reordered to their
original (oldest-undone-first) sequence, each one click from being re-awarded exactly as before via
the existing manual-award path (MOD-011 Live Interventions), with the first (erroneous) pick's
fields editable before re-award so the commissioner can fix it, then continue clicking through the
rest unchanged.

**Whammy panel (PRD §33, IA §9.5).** A trigger form (team selector, signed dollar amount, required
description) calls `POST /drafts/:draftId/whammy` with `{team_id, amount_minor, description}`. The
response is one of two shapes and the UI must branch on it: an immediate application
(`WhammyResponse`: `team_id, amount_minor, new_remaining_budget_minor`) shown as an applied
confirmation, or a queued approval (`{whammy_id, status: 'PENDING_APPROVAL', team_id, amount_minor}`)
added to a pending-approval list. Each pending entry has Approve and Reject buttons wired to `POST
.../whammy/:whammyId/approve` (`WhammyResponse` on success) and `POST .../whammy/:whammyId/reject`
(`WhammyRejectResponse`: `{whammy_id, status: 'REJECTED'}`), removing the entry from the pending list
on either action. All `409` trigger rejections (`WHAMMY_DISABLED`, `WHAMMY_POSITIVE_NOT_ALLOWED`,
`WHAMMY_NEGATIVE_NOT_ALLOWED`, `WHAMMY_MAX_PER_TEAM_EXCEEDED`, `WHAMMY_MAX_PER_DRAFT_EXCEEDED`,
`WHAMMY_ROSTER_COMPLETION_INFEASIBLE`), the approve-path's `WHAMMY_ROSTER_COMPLETION_INFEASIBLE`
re-check, and `WHAMMY_NOT_PENDING` (approve or reject attempted on an entry no longer in
`PENDING_APPROVAL` — e.g. a double-click race, or another commissioner window already
resolved it) are shown inline using the response's `message`; a `WHAMMY_NOT_PENDING` response
also removes the entry from the pending list, since it means the entry is already resolved
elsewhere.

**Behavioral expectations:**
- Given the commissioner opens the Commissioner Console and selects the "Corrections & Rollback" nav
  item, when the section renders, then the `ComingSoon` placeholder is gone and the price-correction
  form, rollback panel, and Whammy panel all render in its place.
- Given an already-awarded acquisition and a new price entered in the price-correction form, when the
  form renders (before any submit), then it shows the old price, the new price, the computed budget
  delta, and the resulting remaining budget.
- Given a price correction that the server accepts, when the commissioner confirms, then the UI calls
  `POST /drafts/:draftId/corrections/price` with `{acquisition_id, new_price_minor}`, and on `200`
  displays the returned old/new price and updates the team's shown remaining budget from
  `new_remaining_budget_minor`.
- Given a price correction that would make a later pick by that team illegal, when the commissioner
  confirms, then the UI receives `409 CORRECTION_ILLEGAL`, displays the refusal message, and offers a
  "Roll back instead" action that opens the Rollback panel pre-targeted at that pick.
- Given the commissioner indicates the problem is the winner or player (not price), when they use the
  "roll back instead" affordance next to the price form, then the Rollback panel opens pre-targeted at
  that pick without attempting an in-place correction.
- Given the commissioner selects a target pick or count `N` in the Rollback panel, when the preview
  renders (before confirm), then it shows the plain-language cost statement naming the pick range and
  player count, followed by the detailed per-pick preview (player, team, price) for every pick that
  will be reversed.
- Given the draft is not currently `PAUSED`, when the commissioner confirms a rollback, then the UI
  pauses the draft before submitting `POST /drafts/:draftId/rollback`.
- Given a rollback request with `{count}`, when the server returns `200` with `rolled_back` and
  `picks_reversed`, then the UI renders the re-apply assist listing the undone picks in their
  original (oldest-first) order, each with a one-click re-award action, and the first (erroneous)
  pick's fields are editable before its re-award.
- Given a rollback request when the draft is not `PAUSED` or there are no active picks to roll back,
  when the server returns `409` (`DRAFT_NOT_PAUSED` or `NO_PICKS_TO_ROLLBACK`), then the UI shows the
  rejection inline and makes no further state change.
- Given the Whammy trigger form is submitted with a team, signed amount, and description, when the
  server responds `200` with an immediate `WhammyResponse`, then the UI shows the applied confirmation
  and the team's updated remaining budget; when the server instead responds with
  `{status: 'PENDING_APPROVAL'}`, then the UI adds the whammy to the pending-approval list instead.
- Given a pending-approval whammy, when the commissioner clicks Approve, then the UI calls `POST
  .../whammy/:whammyId/approve` and on `200` removes it from the pending list and shows the applied
  result; when the commissioner clicks Reject, then the UI calls `POST .../whammy/:whammyId/reject`
  and on `200` removes it from the pending list showing `REJECTED`.
- Given the Whammy trigger is rejected with any of the documented `409` codes (`WHAMMY_DISABLED`,
  `WHAMMY_POSITIVE_NOT_ALLOWED`, `WHAMMY_NEGATIVE_NOT_ALLOWED`, `WHAMMY_MAX_PER_TEAM_EXCEEDED`,
  `WHAMMY_MAX_PER_DRAFT_EXCEEDED`, `WHAMMY_ROSTER_COMPLETION_INFEASIBLE`), when the response arrives,
  then the UI shows the rejection message inline and does not add anything to the pending list.
- Given a pending-approval whammy that has already been resolved (approved, rejected, or by another
  commissioner window), when Approve or Reject is clicked again, then the server returns `409
  WHAMMY_NOT_PENDING`, the UI shows the message, and the entry is removed from the pending list
  (it is already resolved elsewhere, not actionable).
- Given any of the above requests, when it is sent, then it carries the commissioner's bearer token in
  the `Authorization` header.

## Layers
- ui

## Dependencies
- F-MOD-005
- F-MOD-009

## API Contracts
```yaml
api_contracts:
  consumes:
    - operation_id: correctPrice
      schema_file: schema/MOD-005-api-schema.yaml
      request_schema: PriceCorrectionRequest
      response_schema: PriceCorrectionResponse
    - operation_id: rollbackPicks
      schema_file: schema/MOD-005-api-schema.yaml
      request_schema: RollbackRequest
      response_schema: RollbackResponse
    - operation_id: triggerWhammy
      schema_file: schema/MOD-009-api-schema.yaml
      request_schema: WhammyRequest
      response_schema: "WhammyResponse | WhammyPendingApprovalResponse (oneOf; UI branches on status field)"
    - operation_id: approveWhammy
      schema_file: schema/MOD-009-api-schema.yaml
      request_schema: null
      response_schema: WhammyResponse
    - operation_id: rejectWhammy
      schema_file: schema/MOD-009-api-schema.yaml
      request_schema: null
      response_schema: WhammyRejectResponse
```

## Required Env Variables

## Lint Config

## Test Config

## Constraints

## Status
implementing
