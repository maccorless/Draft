# API Interface Contract

**Project:** Draft — Fantasy Football Auction Platform
**Date:** 2026-08-31
**Tier:** mvp
**Scope:** Global (one per project)

---

## 1. Overview

This document defines the contract between the React frontend (`web/`) and the Node/Fastify backend (`server/`). All shared types live in `shared-types/` and are validated with Zod on both sides.

**Transport summary:**
- **REST (HTTPS):** Auth, league/team setup, dataset management, corrections, reports
- **WebSocket (WSS):** All real-time auction events and commands; one persistent connection per draft per client

**Base URL:** `https://$RAILWAY_PUBLIC_DOMAIN` (injected at Railway deploy time)
**WS endpoint:** `wss://$RAILWAY_PUBLIC_DOMAIN/ws/drafts/:draftId`

---

## 2. WebSocket Envelope

All WS messages (client → server and server → client) use this envelope, defined in `shared-types/src/protocol.ts`:

```typescript
interface WsEnvelope<T> {
  type: string;     // command or event name
  payload: T;
  seq: number;      // monotonically increasing; client tracks last_seen_sequence for reconnect
}
```

Client commands carry a `seq` counter. Server events carry a `seq` from the `DraftEvent.sequence` column. On reconnect, client sends its `last_seen_sequence` and the server replays any missed events.

---

## 3. Screen-to-API Mapping

### 3.1 Site Login Screen

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| Discover leagues | REST POST | MOD-000 | `authSite` → `POST /auth/site` |

**FE state:** stores `league_id` and `league_name`; no token yet.

---

### 3.2 League Login Screen

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| Authenticate as commissioner or owner | REST POST | MOD-000 | `authLeague` → `POST /auth/league/:id` |

**FE state:** stores JWT; decodes role, team_id, league_id from token payload. On every WS connect, sends token in first AUTHENTICATE message.

---

### 3.3 Commissioner Setup Screen

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| Create league | REST POST | MOD-001 | `createLeague` → `POST /leagues` |
| Add teams | REST POST | MOD-001 | `createTeam` → `POST /leagues/:id/teams` |
| Configure roster slots | REST PUT | MOD-001 | `setRosterConfig` → `PUT /leagues/:id/config/roster` |
| Configure auction timers/budget | REST PUT | MOD-001 | `setAuctionConfig` → `PUT /leagues/:id/config/auction` |
| Create draft dataset | REST POST | MOD-001 | `createDataset` → `POST /leagues/:id/datasets` |
| Import players (CSV) | REST POST | MOD-001 | `importDatasetCsv` → `POST /leagues/:id/datasets/:id/import/csv` |
| Import players (Excel) | REST POST | MOD-007 | `importDatasetExcel` → `POST /leagues/:id/datasets/:id/import/excel` |
| Import players (ESPN PDF) | REST POST | MOD-007 | `importDatasetEspnPdf` → `POST /leagues/:id/datasets/:id/import/espn-pdf` |
| Import players (FantasyPros) | REST POST | MOD-007 | `importDatasetFantasyPros` → `POST /leagues/:id/datasets/:id/import/fantasypros` |
| Freeze dataset | REST POST | MOD-001 | `freezeDataset` → `POST /leagues/:id/datasets/:id/freeze` |
| Create draft | REST POST | MOD-001 | `createDraft` → `POST /leagues/:id/drafts` |

---

### 3.4 Draft Lobby Screen

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| List available drafts | REST GET | MOD-003 | `listDrafts` → `GET /leagues/:id/drafts` |
| Start draft (commissioner) | REST POST | MOD-002 | `startDraft` → `POST /drafts/:id/start` |
| Pause draft (commissioner) | REST POST | MOD-002 | `pauseDraft` → `POST /drafts/:id/pause` |

---

### 3.5 Draft Room (Draft Board)

This screen opens a persistent WS connection on mount. All auction events arrive over WS. Bidding actions are sent as WS commands.

**WS connection:** `wss://$HOST/ws/drafts/:draftId`

| Operation | Transport | Module | Command / Event |
|-----------|-----------|--------|-----------------|
| Authenticate and reconnect | WS | MOD-002/003 | `AUTHENTICATE {token, last_seen_sequence}` |
| Receive full state snapshot | WS receive | MOD-003 | `STATE_SNAPSHOT` |
| Place bid | WS send | MOD-002 | `BID_COMMAND {player_auction_id, bid_amount_minor, bid_type, expected_version}` |
| Nominate player | WS send | MOD-002 | `NOMINATE_COMMAND {player_dataset_entry_id, opening_bid_minor}` |
| Receive bid accepted | WS receive | MOD-002 | `BID_ACCEPTED {bid_amount_minor, leading_team_id, rebid_deadline_ts}` |
| Receive bid rejected | WS receive | MOD-002 | `BID_REJECTED {code, reason}` |
| Receive nomination started | WS receive | MOD-002 | `NOMINATION_STARTED {player, deadline_ts}` |
| Receive player awarded | WS receive | MOD-002 | `PLAYER_AWARDED {team, price, roster_slot}` |
| Receive auto-agent enabled | WS receive | MOD-004 | `TEAM_AUTO_AGENT_ENABLED` |
| Receive whammy | WS receive | MOD-009 | `WHAMMY_APPLIED` |
| Receive rollback | WS receive | MOD-005 | `ROLLBACK_APPLIED` |
| Render countdown | FE-only | — | Countdown from `deadline_ts - Date.now()` every 100ms; no server query |

**Draft board loading:** simple spinner on WS connect until `STATE_SNAPSHOT` arrives.

---

### 3.6 War Room Screen

War Room is a second synchronized window for the same team owner. It connects to the same WS draft endpoint with the same token (same `team_id`). No special handshake; duplicate broadcast is built-in.

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| View target values | REST GET | MOD-008 | `getTargetValues` → `GET /drafts/:id/teams/:id/target-values` |
| Set target values | REST PUT | MOD-008 | `setTargetValues` → `PUT /drafts/:id/teams/:id/target-values` |
| View watch list | REST GET | MOD-008 | `getWatchList` → `GET /drafts/:id/teams/:id/watchlist` |
| Add to watch list | REST POST | MOD-008 | `addToWatchList` → `POST /drafts/:id/teams/:id/watchlist` |
| Remove from watch list | REST DELETE | MOD-008 | `removeFromWatchList` → `DELETE /drafts/:id/teams/:id/watchlist/:playerId` |
| View nomination queue | REST GET | MOD-008 | `getNominationQueue` → `GET /drafts/:id/teams/:id/nomination-queue` |
| Reorder nomination queue | REST PUT | MOD-008 | `reorderNominationQueue` → `PUT /drafts/:id/teams/:id/nomination-queue` |
| Configure auto-agent | REST PUT | MOD-004 | `setAutoAgentConfig` → `PUT /drafts/:id/teams/:id/auto-agent` |
| Take manual control | REST PATCH | MOD-004 | `setControlMode` → `PATCH /drafts/:id/teams/:id/control-mode` |
| Receive nominator match available | WS receive | MOD-008 | `NOMINATOR_MATCH_AVAILABLE` |

---

### 3.7 Commissioner Control Screen

Commissioner-only actions during and after the draft.

| Operation | Transport | Module | Endpoint / Command |
|-----------|-----------|--------|--------------------|
| Resume draft | REST POST | MOD-002 | `resumeDraft` → `POST /drafts/:id/resume` |
| Correct pick price | REST POST | MOD-005 | `correctPrice` → `POST /drafts/:id/corrections/price` |
| Roll back picks | REST POST | MOD-005 | `rollbackPicks` → `POST /drafts/:id/rollback` |
| Trigger Whammy | REST POST | MOD-009 | `triggerWhammy` → `POST /drafts/:id/whammy` |
| View draft report | REST GET | MOD-006 | `getDraftReport` → `GET /drafts/:id/report` |
| Download ESPN worksheet | REST GET | MOD-006 | `getEspnWorksheet` → `GET /drafts/:id/espn-worksheet` |
| Email report to owners | REST POST | MOD-006 | `emailDraftReport` → `POST /drafts/:id/report/email` |

---

## 4. Shared Type Conventions

All types are defined in `shared-types/src/protocol.ts` and `shared-types/src/schemas/`. Both FE and BE import from this package.

| Convention | Rule |
|------------|------|
| Money | All `*_minor` fields are integers (cents). Frontend formats as `${ (minor / 100).toFixed(2) }` |
| Timestamps | All `*_deadline_ts` fields are epoch milliseconds (`number`); `*_at` fields are ISO-8601 strings |
| IDs | All entity IDs are UUID v4 strings |
| Auth header | `Authorization: Bearer <token>` on all REST calls; AUTHENTICATE WS command on connect |
| Countdown | FE calculates `deadline_ts - Date.now()` every 100ms; never calls server for remaining time |
| Stale-state | `BID_COMMAND` of type RELATIVE or NOMINATOR_MATCH MUST include `expected_current_bid_minor` and `expected_auction_version` |

---

## 5. Error Response Contract

All REST errors return:

```json
{
  "code": "ERR_SLUG",
  "message": "Human-readable description"
}
```

All WS command rejections return a `WS ERROR` event:

```json
{
  "type": "ERROR",
  "payload": { "code": "ERR_SLUG", "reason": "Human-readable description" },
  "seq": 0
}
```

Common error codes:

| Code | Meaning |
|------|---------|
| `ERR_AUTH_EPOCH_INVALID` | Token's auth_epoch no longer matches DB; re-authenticate |
| `ERR_STALE_BID` | expected_auction_version mismatch |
| `ERR_INSUFFICIENT_BUDGET` | Bid exceeds max_legal_bid |
| `ERR_AUCTION_NOT_OPEN` | PlayerAuction is not in OPEN status |
| `ERR_DRAFT_NOT_PAUSED` | Rollback attempted on a RUNNING draft |
| `ERR_CORRECTION_ILLEGAL` | Price correction would make a later pick illegal |
| `ERR_FORBIDDEN` | Role insufficient for this action |

---

## Provenance

| Section | Origin | Source |
|---------|--------|--------|
| Overview | Inherited | `decision-registry.yaml` → `realtime-transport`, `frontend-framework`, `railway-topology` |
| WS Envelope | Inherited | `knowledge/PRD.md` (§WS protocol), `decision-registry.yaml` → `realtime-transport`, `validation-library` |
| Screen-to-API Mapping | Authored | `module-map.yaml` (module layers), `knowledge/screen-information-architecture.md` (screen inventory) |
| Shared Type Conventions | Inherited | `decision-registry.yaml` → `money-representation`, `client-countdown`, `stale-state-protection`, `validation-library` |
| Error Response Contract | Inherited | `knowledge/PRD.md` (§15-16 stale-state protection), `knowledge/state-machine-flows.md` (§4 bid atomicity) |
