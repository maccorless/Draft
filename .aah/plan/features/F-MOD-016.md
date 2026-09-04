## Id
- F-MOD-016

## Title
- Multi-source AAV and player intelligence data

## Module Ref
- MOD-016

## Description
Closes two related Core MVP data gaps identified in the module-map audit (`module-map.yaml` MOD-016):
(1) **Multi-source AAV** (`knowledge/PRD.md` §10 "Multi-Source AAV") — a player must be able to carry
more than one named AAV value at once (e.g. "ESPN $42 / FantasyPros $47 / Custom $51") with a
commissioner-selected Primary and optional Secondary, but the current schema stores exactly one
`aav_minor`/`tier`/`source` row per player per dataset. (2) **Player intelligence fields**
(`knowledge/PRD.md` §9.2) — bye week, injury status/detail, freshness timestamp, and prior-season
stats do not exist anywhere in the `players` table today. Built with the existing Node.js 20 +
Fastify 4.x backend (`server/`, Drizzle ORM over `postgres.js`) and React 18 + Vite 5 frontend
(`web/`), per `architecture-overview.md` §3/§7. This project has no `design-spec.yaml` or wireframe
set (iteration-2 gap-fill modules are audited against `knowledge/screen-information-architecture.md`
directly).

**This is a schema restructuring, not an additive-only change.** Today
`server/db/schema/index.ts`'s `playerDatasetEntries` table (`player_dataset_entries`) has one row
per `(dataset_id, player_id)`, and four other tables — `playerAuctions.dataset_player_id`,
`watchListItems.dataset_player_id`, `nominationQueueItems.dataset_player_id`, and
`ownerTargetValues.dataset_player_id` — all FK to that row's `id`, using it as a stand-in for "this
player in this dataset." Once one row per `(dataset_id, player_id, source)` is required, that FK
target is no longer a unique-per-player identity, so it cannot stay pointed at the restructured
table. `knowledge/data-model.md` §7.1/§12/§10.1 never had this problem because its `PlayerAuction`,
`OwnerPlayerTarget`, and equivalent watch-list/queue entities were always keyed by `player_id`
directly (a `Draft` has exactly one frozen `DraftDataset`, so `player_id` alone is a sufficient and
stable scope) — this module repoints those four FKs from `player_dataset_entries.id` to `players.id`,
matching the original data-model design, and updates every existing reader/writer of that column:
`server/src/auction/engine.ts` (nomination, the raw-SQL argmax auto-nominate query, bid pipeline),
`server/src/draft/strategy.ts` (watch-list/queue/target-value routes), `server/src/draft/corrections.ts`,
`server/src/draft/reports.ts`, `server/src/draft/war-room.ts`, `server/src/ws/auction-handler.ts`, and
`server/src/session/routes.ts` (reconnect snapshot). The identifier the frontend already sends for
these calls (`dataset_entry_id` / `dataset_player_id` in `web/src/screens/draft-room/index.tsx` and
`web/src/screens/war-room/index.tsx`) must keep resolving correctly end-to-end — this module does not
need to change those two files' call sites, only ensure the identifier they already round-trip
through `GET /leagues/:id/players` still uniquely and correctly identifies a player.

**Schema (db layer):**
- `players`: add `bye_week` (int, nullable), `injury_status` (text, nullable), `injury_detail`
  (text, nullable), `injury_updated_at` (timestamptz, nullable), `prior_season_stats` (jsonb,
  nullable) — per `knowledge/PRD.md` §9.2 and module-map's MOD-016 `db` layer.
- Restructure `player_dataset_entries` into `player_aav_sources`: `(dataset_id, player_id, source,
  aav_minor, tier, projected_points)`, unique on `(dataset_id, player_id, source)` — one row per
  player per source per dataset, replacing the single-row-per-player shape. `source` keeps using the
  same string values the existing `ImportSource` union already defines
  (`server/src/player/adapters/types.ts`: `CSV | EXCEL | ESPN_PDF | FANTASYPROS`).
- `draft_datasets`: add `primary_aav_source` (text, nullable), `secondary_aav_source` (text,
  nullable) — new from scratch, storing one of the `source` values present among that dataset's
  `player_aav_sources` rows.
- Repoint `playerAuctions.dataset_player_id`, `watchListItems.dataset_player_id`,
  `nominationQueueItems.dataset_player_id`, `ownerTargetValues.dataset_player_id` to FK `players.id`
  instead of `player_dataset_entries.id` (rename the column if convenient, but the FK target change
  is the required part).

**Adapters (api layer, extends MOD-007):** `server/src/player/adapters/types.ts`'s `ParsedRow` gains
optional `bye_week`, `injury_status`, `injury_detail` fields. Each of the four adapters — `csv.ts`,
`excel.ts`, `espn-pdf.ts` (`EspnPdfAdapter`), `fantasypros.ts` (`FantasyProsAdapter`) — populates
whichever of these fields its source format actually supplies, leaving the rest absent rather than
fabricating a value (`knowledge/PRD.md` §9.2 "when available"). `server/src/player/routes.ts`'s
upsert pipeline (`upsertRows` and the inline CSV-import path) changes its upsert key from
`(dataset_id, player_id)` to `(dataset_id, player_id, source)`: it inserts a new `player_aav_sources`
row per source or updates the existing row for that exact source, and separately writes
`bye_week`/`injury_status`/`injury_detail`/`injury_updated_at` onto the shared `players` row (not
per-source) whenever an incoming row supplies them, without clearing previously-set values when a
later import from a different source omits them.

**API (api layer):** `GET /leagues/:id/players` (existing, MOD-001, `schema/MOD-001-api-schema.yaml`
operation `listPlayers`) is extended so each player entry includes `primary_aav_minor` and
`secondary_aav_minor` resolved from the active dataset's `primary_aav_source`/`secondary_aav_source`,
an `aav_sources` list (source name + `aav_minor` + `tier` + `projected_points` per loaded source),
and the new intelligence fields (`bye_week`, `injury_status`, `injury_detail`, `injury_updated_at`,
`prior_season_stats`). The existing top-level `aav_minor`/`tier` fields that
`web/src/screens/draft-room/index.tsx` and `web/src/screens/war-room/index.tsx` already read are kept
in the response, mirroring the resolved primary values, so those two screens keep working unchanged.
New endpoint `PUT /leagues/:id/datasets/:id/aav-sources` (commissioner-only) sets
`primary_aav_source`/`secondary_aav_source`, validated against the `source` values actually present
among that dataset's currently-loaded `player_aav_sources` rows (an unrecognized or not-yet-loaded
source is rejected). No `schema/MOD-016-api-schema.yaml` exists yet in `.aah/architecture/schema/`
(only MOD-000 through MOD-009 have one); this module's implementer authors it in the same OpenAPI 3.1
shape as `schema/MOD-001-api-schema.yaml`, adding the new `setAavSources` operation and extending
`PlayerEntry`/`PlayerListResponse` there with the fields above (MOD-001's file already owns
`listPlayers`, so this module amends it in place rather than duplicating the operation elsewhere).

**UI (ui layer):** `web/src/screens/draft-room/index.tsx` (Zone A, `knowledge/screen-information-architecture.md`
§2.1) gains an injury indicator next to the active player's name/position, shown when `injury_status`
is set. `web/src/screens/war-room/index.tsx` (Zone A, `screen-information-architecture.md` §4.1)
gains bye week, injury detail + freshness (computed from `injury_updated_at`, e.g. "updated 22m ago"),
and the full `aav_sources` list alongside the existing Primary AAV display — none of these fields
exist in that panel today. This module supplies the data and these two direct display additions only;
MOD-010's Primary/Secondary AAV source dropdowns and MOD-017's expandable player-detail
popover/comparables consume this module's endpoints/fields but are built in those modules.

**Behavioral expectations:**
- Given a migration runs, then `players` has `bye_week`, `injury_status`, `injury_detail`,
  `injury_updated_at`, and `prior_season_stats` columns, all nullable, none populated by any other
  existing module.
- Given a dataset has no rows imported yet, when a player is imported from one source (e.g. CSV),
  then exactly one `player_aav_sources` row exists for that `(dataset_id, player_id)` with
  `source = 'CSV'`.
- Given a player already has a `player_aav_sources` row for source CSV in a dataset, when the same
  player is subsequently imported from a second source (e.g. FantasyPros) into the same dataset,
  then a second `player_aav_sources` row is inserted for `source = 'FANTASYPROS'` and the original
  CSV row is left unchanged — both rows coexist and are both visible in the player's detail.
- Given a player is re-imported from a source it was already loaded from, when the adapter/upsert
  pipeline runs again, then the existing `(dataset_id, player_id, source)` row is updated in place
  rather than duplicated.
- Given an adapter's source format supplies `bye_week` and/or `injury_status`/`injury_detail` for a
  row, when that row is upserted, then the corresponding columns on the shared `players` row are set
  and `injury_updated_at` is stamped to the import time; given a different source's import for the
  same player omits those fields, then previously-set values are left untouched, not cleared.
- Given `playerAuctions`, `watchListItems`, `nominationQueueItems`, and `ownerTargetValues` are
  migrated to reference `players.id` instead of `player_dataset_entries.id`, when the existing
  nomination, bid, watch-list, nomination-queue, target-value, corrections, reports, war-room, and
  session-reconnect-snapshot code paths run against the restructured schema, then they continue to
  resolve player identity correctly and the project's existing regression test suite for those
  modules (MOD-002 through MOD-006, MOD-008) continues to pass unmodified in intent.
- Given the empty-nomination-queue auto-nominate path (`server/src/auction/engine.ts`, "highest AAV
  available") runs after this migration, when it selects the next player, then it resolves AAV via
  the dataset's `primary_aav_source` (falling back to the only loaded source if none is yet
  selected) rather than querying the removed single-row `player_dataset_entries` shape.
- Given the commissioner has imported players from two different sources into one dataset, when they
  call `PUT /leagues/:id/datasets/:id/aav-sources` with a `primary_aav_source` and
  `secondary_aav_source` matching two of the loaded `source` values, then the selection is persisted
  on `draft_datasets` and returned on subsequent reads.
- Given a `PUT /leagues/:id/datasets/:id/aav-sources` request names a `source` value that has no
  `player_aav_sources` rows in that dataset, when the server validates it, then the request is
  rejected and no selection is changed.
- Given a non-commissioner (or missing/expired/auth_epoch-invalidated JWT) calls
  `PUT /leagues/:id/datasets/:id/aav-sources`, when the preHandler runs, then the request is
  rejected with an auth error before any write occurs.
- Given a dataset has `primary_aav_source` and `secondary_aav_source` selected, when
  `GET /leagues/:id/players` is called, then each player entry includes `primary_aav_minor` and
  `secondary_aav_minor` resolved from the matching `player_aav_sources` rows (null when that
  player has no row for the selected source), an `aav_sources` array covering every loaded source for
  that player, and the top-level `aav_minor`/`tier` fields still present and equal to the resolved
  primary values, so `web/src/screens/draft-room/index.tsx` and `web/src/screens/war-room/index.tsx`
  keep functioning unchanged against the extended response.
- Given a player has `bye_week`, `injury_status`, `injury_detail`, and `injury_updated_at` set, when
  `GET /leagues/:id/players` returns that player, then all four fields are present in the response;
  given a source never supplied them, then they are returned as null rather than omitted or
  fabricated.
- Given the active player in the Draft Room has `injury_status` set, when the Draft Room renders,
  then an injury indicator appears next to that player's name/position; given `injury_status` is
  null, then no indicator renders.
- Given the active player in the War Room, when the player intelligence panel renders, then it shows
  bye week, injury detail with a freshness string derived from `injury_updated_at`, and every
  configured AAV source for that player (not just a single value) alongside the existing Primary AAV
  display.
- Given `tsc --noEmit` runs across the `server/` and `web/` packages after this module's changes,
  then it passes with zero errors.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-001
- F-MOD-007

## API Contracts
```yaml
produces:
  - operation_id: listPlayers
    schema_file: schema/MOD-001-api-schema.yaml
    request_schema: "(none)"
    response_schema: PlayerListResponse

  - operation_id: setAavSources
    schema_file: schema/MOD-016-api-schema.yaml
    request_schema: SetAavSourcesRequest
    response_schema: AavSourceSelectionResponse
```

## Required Env Variables

## Test Config

- command: npx vitest run --project node server/src/__tests__/F-MOD-016_multi_source_aav.test.ts
- test_paths:
  - server/src/__tests__/F-MOD-016_multi_source_aav.test.ts

## Lint Config

## Constraints

## Status
done
