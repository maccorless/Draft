## Id
- F-MOD-015

## Title
- Team icon and nomination audio media

## Module Ref
- MOD-015

## Description
Team presentation media — team icon and optional nomination MP3 (PRD §5.1 "Team presentation
media", PRD §44 "Nomination audio" acceptance scenario) — built with the existing Node.js +
Fastify backend (`server/`) and React + Vite frontend (`web/`), per `architecture-overview.md`
§2–3. This capability is entirely absent today: `server/db/schema/index.ts`'s `teams` table has
no icon/audio columns, and no upload route or nomination-audio broadcast exists anywhere in
`server/src`.

**Storage decision (explicit — do not substitute):** the project targets Railway as a single
Node.js service + Railway-managed Postgres (`architecture-overview.md` §2, §6; no object-storage
service was chosen in the decision registry). Uploaded icon and MP3 files are stored on local
disk under the `server/` package (a directory the Fastify server serves statically), and the
corresponding `teams.icon_url` / `teams.nomination_audio_url` columns store the path/URL the
server serves them from. Do not introduce S3 or any other cloud storage dependency.

**Known production caveat (do not silently fix, just flag):** Railway's default filesystem is
ephemeral — local disk does not survive a redeploy/restart. This is a non-issue for local
development (the target for this iteration), but uploaded media would be lost on the first
Railway redeploy after upload. Leave a `// TODO(railway-volume):` comment at the file-storage
write path noting that a persistent Railway volume mounted at the upload directory (no new
service, just a `railway.toml` volume mount) is the fix when this ships to Railway — do not
implement the volume mount as part of this feature.

**Schema:** add `teams.icon_url` (nullable text) and `teams.nomination_audio_url` (nullable
text) to `server/db/schema/index.ts`'s `teams` table, and `draft_team_states.nomination_audio_played`
(boolean, default false, never reset once true) to the `draft_team_states` table — per
module-map.yaml's MOD-015 `db` layer.

**Upload API:** `POST /leagues/:leagueId/teams/:teamId/media` accepts a multipart body carrying
an icon file and/or an MP3 file, authorized for either that team's owner or the league's
commissioner (mirroring `requireCommissioner`'s auth_epoch-checked JWT pattern in
`server/src/league/auth-hook.ts`, extended to also accept the matching team's own token). Use
`@fastify/multipart` the same way `server/src/player/routes.ts`'s CSV import endpoint does (the
closest existing multipart pattern in this codebase: register the plugin, read `req.file()`,
buffer the stream) — there is no existing generic file-upload utility to reuse beyond that
pattern. `DELETE /leagues/:leagueId/teams/:teamId/media` removes the icon and/or audio (caller
specifies which via body/query) by clearing the corresponding column; it does not need to
physically delete the on-disk file synchronously. Existing team-read responses (`GET
/leagues/:id/teams` in `server/src/league/routes.ts`, and the roster-grid read) must include
`icon_url` and `nomination_audio_url` so downstream screens (MOD-010, MOD-014, and any icon
rendering in `web/src/screens/war-room/index.tsx` / `draft-room/index.tsx`) can consume them —
this feature does not render icons in those screens itself.

**Nomination-audio broadcast:** in `server/src/auction/engine.ts`'s nomination flow (the same
transaction that inserts the `player_auctions` row and the `NOMINATION_STARTED` `draft_events`
row, per the "Built once and reused for both the persisted draft_event and the live broadcast"
pattern already in that function), when the nominating team's `nomination_audio_url` is set and
its `draft_team_states.nomination_audio_played` is false: broadcast a new event type
`TEAM_NOMINATION_AUDIO {team_id, audio_url, duration_cap_ms: 5000}` alongside
`NOMINATION_STARTED`, and set `nomination_audio_played = true` in that same transaction so it can
never fire twice for that team in that draft, consistent with the append-only/atomic-transaction
constraints in `data-model.md` and CLAUDE.md constraint #4.

**UI:** a reusable media upload control (icon + optional MP3, with replace/remove) that MOD-010
(commissioner-side, League Setup) and MOD-014 (owner-side, Pre-Draft Lobby) surface — this feature
builds the control, those two mount it, neither reimplements upload logic. A client-side audio
player that, on receiving `TEAM_NOMINATION_AUDIO`, plays `audio_url` capped at `duration_cap_ms`
and never blocks nomination/bidding controls. Per module-map's MOD-015 `ui` layer, this feature
also owns rendering the team icon itself in the two places module-map names: `web/src/screens/war-room/index.tsx`'s
League Roster/Budget Grid (`war-room__grid-team-name` cell, next to the team name) and
`web/src/screens/draft-room/index.tsx`'s My Team Context panel (`draft-room__panel-heading`
"My Team" section) — a small `<img>` addition next to the existing team-name text in each,
rendered only when `icon_url` is set, sourced from the extended team-read responses this
feature's API layer already exposes it in.

**Behavioral expectations:**
- Given a team owner or the league's commissioner, when they POST a valid image file to
  `/leagues/:leagueId/teams/:teamId/media`, then the file is stored on local disk under the
  server package, `teams.icon_url` is set to a URL the server serves statically, and the response
  (and subsequent `GET /leagues/:leagueId/teams`) reflects the new `icon_url`.
- Given a team owner or the league's commissioner, when they POST a valid MP3 file to the same
  endpoint, then `teams.nomination_audio_url` is set and returned in team reads, and the source
  file is stored as-is (not trimmed) even if longer than 5 seconds.
- Given a user who is neither that team's owner nor the league's commissioner, when they POST to
  `/leagues/:leagueId/teams/:teamId/media`, then the request is rejected (403/401) and no column
  is modified.
- Given a team already has an icon or audio URL set, when a new file of the same media type is
  uploaded, then the existing URL is replaced with the new one (upload-or-replace semantics).
- Given a team has an icon and/or audio URL set, when `DELETE
  /leagues/:leagueId/teams/:teamId/media` is called specifying that media type, then the
  corresponding column is cleared to null and reflected in subsequent team reads.
- Given a team has `nomination_audio_url` set and `nomination_audio_played=false`, when that
  team's `NOMINATION_STARTED` event is emitted (first nomination of the draft), then a
  `TEAM_NOMINATION_AUDIO {team_id, audio_url, duration_cap_ms: 5000}` broadcast fires and
  `draft_team_states.nomination_audio_played` is set to true in the same transaction as the
  nomination insert.
- Given a team's `nomination_audio_played` is already true, when that team nominates again later
  in the same draft, then no additional `TEAM_NOMINATION_AUDIO` broadcast fires.
- Given a team has no `nomination_audio_url` set, when that team nominates, then no
  `TEAM_NOMINATION_AUDIO` broadcast ever fires for that team.
- Given a connected client that permits audio playback, when it receives `TEAM_NOMINATION_AUDIO`,
  then it plays `audio_url` and stops playback at `duration_cap_ms` (5000ms) regardless of the
  source file's actual length, without blocking or delaying nomination/bid UI interactions.
- Given the media upload control component, when rendered standalone (outside any specific
  screen), then it exposes icon and MP3 upload/replace/remove actions wired to this feature's
  endpoints, ready for MOD-010 and MOD-014 to surface without needing their own upload logic.
- Given a team has `icon_url` set, when the War Room's League Roster/Budget Grid renders that
  team's row, then the icon renders next to the team name; when `icon_url` is null, then no
  broken-image element renders and the row layout is unaffected.
- Given a team has `icon_url` set, when the Draft Room's My Team Context panel renders for that
  team (the signed-in owner's own team), then the icon renders next to the team name; when
  `icon_url` is null, then no broken-image element renders.

## Layers
- db
- api
- ui

## Dependencies
- F-MOD-001
- F-MOD-002

## API Contracts
```yaml
api_contracts:
  produces:
    - operation_id: uploadTeamMedia
      schema_file: schema/MOD-015-api-schema.yaml
      request_schema: "multipart/form-data (icon, nomination_audio)"
      response_schema: TeamMediaResponse
    - operation_id: deleteTeamMedia
      schema_file: schema/MOD-015-api-schema.yaml
      request_schema: DeleteTeamMediaRequest
      response_schema: TeamMediaResponse
```

## Required Env Variables

## Test Config

- command: DATABASE_URL=postgres://draft:draft_local_dev@localhost:5432/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! npx vitest run --project node server/src/__tests__/F-MOD-015_team_media.test.ts --project web web/src/__tests__/F-MOD-015_team_media.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-015_team_media.test.ts
  - web/src/__tests__/F-MOD-015_team_media.test.tsx

## Lint Config

## Constraints

## Status
done
