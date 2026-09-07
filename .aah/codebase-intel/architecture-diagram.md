# System Architecture

## Overview

A fantasy-football auction draft platform: real-time server-authoritative salary-cap auction across 12 teams, WebSocket-driven, with post-draft roster transfer to ESPN. One deployment may host multiple concurrent league drafts in isolation (keyed by `draft_id`, re-checked against `league_id` on every command). The server owns all auction state; the client is a display + input terminal. Implemented as a Node.js/Fastify monolith (state-stored, not event-sourced) against a single PostgreSQL database.

## Architecture Diagram

```mermaid
graph TB
    subgraph "Clients (React + Vite)"
        DR["Draft Room<br/>Primary bidding surface"]
        WR["War Room<br/>Second-screen analytics (read-only)"]
        CC["Commissioner Console<br/>League Setup, Dataset Import,<br/>Draft Control, Corrections,<br/>Ambiguity Resolution, Dev Tools"]
        LB["Lobby / Draft Complete<br/>pre- and post-draft screens"]
    end

    subgraph "shared-types"
        ST["protocol.ts + schemas/<br/>WS envelope, AUTH shape,<br/>Zod-validated entity types"]
    end

    subgraph "Server - Fastify + ws"
        AUTHR["auth/routes.ts<br/>Site/League/Team password login,<br/>HMAC JWT issuance"]
        AUTHHOOK["league/auth-hook.ts<br/>requireCommissioner /<br/>requireLeagueMember,<br/>auth_epoch re-check every command"]
        WSH["ws/auction-handler.ts<br/>AUTH handshake,<br/>server_receipt_time stamp,<br/>commissioner on-behalf-of override"]

        subgraph "Per-draft serialized pipeline"
            CQ["auction/queue.ts<br/>AsyncQueue - one in-flight<br/>command per draft_id"]
            ENGINE["auction/engine.ts<br/>Nomination + Bid + Award FSM,<br/>computeMaxLegalBid,<br/>starter-first roster assignment"]
            AA["auction/auto-agent.ts<br/>control-mode FSM,<br/>willingness-ceiling bidding cadence"]
            COR["draft/corrections.ts<br/>price-only correction (in-place)<br/>+ reverse-order rollback"]
        end

        STRAT["draft/strategy.ts<br/>Watch List + Nomination Queue"]
        DND["draft/do-not-draft.ts"]
        WHAMMY["draft/whammy.ts<br/>random budget events"]
        REPORTS["draft/reports.ts<br/>Summary report, ESPN worksheet,<br/>SendGrid email stub"]
        SESSION["session/routes.ts<br/>buildDraftStateSnapshot<br/>(reconnect replay)"]
        PLAYER["player/*<br/>DraftDataset ingestion:<br/>CSV / Excel / ESPN-PDF / FantasyPros<br/>adapters, AAV resolution"]
        TEAMMEDIA["team-media/*<br/>icon + nomination-audio upload"]
    end

    subgraph "Data Stores"
        PG[("PostgreSQL<br/>32-table Drizzle schema -<br/>primary authority")]
        INMEM[("In-memory DraftRuntime<br/>Map keyed by draft_id -<br/>hot cache, populated from<br/>and updated only after DB commit")]
    end

    subgraph "External"
        ESPN["ESPN Fantasy<br/>roster-transfer worksheet (CSV)"]
        SG["SendGrid<br/>draft summary email (stub)"]
        ADAPTERS["Commissioner CSV / Excel /<br/>ESPN AAV PDF / FantasyPros<br/>player + AAV sources"]
    end

    DR & WR & CC & LB -->|"WS + REST / HTTPS"| AUTHR
    AUTHR --> AUTHHOOK
    AUTHHOOK --> WSH
    DR & CC -->|"BID/NOMINATE/PASS/MATCH commands"| WSH
    WSH --> CQ
    CQ --> ENGINE
    ENGINE --> AA
    ENGINE --> COR
    ENGINE --> STRAT
    ENGINE --> DND
    CC -->|"corrections/rollback REST"| COR
    CC -->|"Whammy trigger"| WHAMMY --> ENGINE
    CC -->|"dataset import"| PLAYER
    PLAYER --> PG
    WHAMMY --> PG
    ENGINE --> PG
    ENGINE --> INMEM
    WSH -->|"reconnect snapshot"| SESSION --> ENGINE
    WSH -->|"broadcast DraftEvent"| DR & WR & CC & LB
    CC -->|"report / worksheet request"| REPORTS --> PG
    REPORTS --> ESPN
    REPORTS --> SG
    PLAYER --> ADAPTERS
    CC -->|"media upload"| TEAMMEDIA --> PG
    ST -.->|"shared schemas"| DR & WR & CC & LB
    ST -.->|"shared schemas"| WSH
```

## Layer Summary

| Layer | Purpose | Key Components |
|-------|---------|----------------|
| Client | Display + input terminal | Draft Room, War Room, Commissioner Console, Lobby, Draft Complete |
| Shared types | WS protocol contract + Zod validation | `protocol.ts`, `schemas/` |
| Auth | Token issuance + `auth_epoch` re-check on every command | `auth/routes.ts`, `league/auth-hook.ts` |
| WS Handler | Per-draft connection routing, AUTH handshake, `server_receipt_time` stamping | `ws/auction-handler.ts` |
| Command Queue | Serialized mutation pipeline (one in-flight per draft) | `auction/queue.ts` (`AsyncQueue`) |
| Auction Core | Nomination FSM, bid atomicity, resolution, ledger, starter-first roster assignment | `auction/engine.ts` |
| Auto-Agent | Automated bidder/nominator on disconnect, willingness-ceiling cadence | `auction/auto-agent.ts` |
| Corrections | Price correction (in-place) + rollback (reverse `resolution_sequence` order) | `draft/corrections.ts` |
| Whammy | Random budget/entertainment events flowing through the ledger | `draft/whammy.ts` |
| Strategy / Lists | Watch List, Nomination Queue, Do Not Draft | `draft/strategy.ts`, `draft/do-not-draft.ts` |
| Player Ingestion | Player/AAV data import, pre-draft only | `player/*` (CSV, Excel, ESPN-PDF, FantasyPros adapters), `aav-resolution.ts` |
| Reports | Draft summary, ESPN worksheet, SendGrid email stub | `draft/reports.ts` |
| Session | Reconnect snapshot + missed-event replay | `session/routes.ts` |
| PostgreSQL | Authoritative state + `draft_events` audit log | 32-table Drizzle schema (`server/db/schema/index.ts`) |

## External Integrations

- Commissioner CSV / Excel import (player data / AAVs / projections)
- ESPN AAV PDF import (`espn-pdf.ts` adapter, `espn-pdf-worker.ts`)
- FantasyPros adapter (`fantasypros.ts`) — multi-source AAV resolution via `aav-resolution.ts`
- ESPN roster-transfer worksheet export (CSV, `GET /drafts/:draftId/espn-worksheet`)
- SendGrid email stub for Draft Summary Reports (`POST /drafts/:draftId/report/email`)
- Railway deployment (Node app service + managed PostgreSQL, `railway.toml`)
