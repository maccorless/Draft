# Module Dependencies

> **Note:** Pre-implementation. All modules are `[PLANNED]`.

## Overview

Three-package monorepo with a strict layering rule: `web` and `server` both consume `shared-types`; `web` never imports `server`. Within `server`, the draft command pipeline is the most coupled core — nomination, bid, resolution, auto-agent, and rollback all route through the per-draft serialized command queue.

## Dependency Graph

```mermaid
graph TD
    subgraph "shared-types"
        ST_PROTO["protocol.ts<br/>WS envelope + AUTH shape<br/>PLANNED"]
        ST_ENT["entities.ts<br/>domain types<br/>PLANNED"]
        ST_VAL["validation.ts<br/>Zod schemas<br/>PLANNED"]
    end

    subgraph "server"
        SRV_AUTH["auth/<br/>token + auth_epoch<br/>PLANNED"]
        SRV_LEAGUE["league/<br/>League + Team CRUD<br/>PLANNED"]
        SRV_PLAYER["player/<br/>DraftDataset + ingestion<br/>PLANNED"]
        SRV_WS["ws/<br/>handler + broadcast<br/>PLANNED"]

        subgraph "draft/"
            DFT_CQ["Command Queue<br/>PLANNED"]
            DFT_NOM["nomination/<br/>PLANNED"]
            DFT_BID["bid pipeline/<br/>PLANNED"]
            DFT_RES["resolution/<br/>PLANNED"]
            DFT_AA["auto-agent/<br/>PLANNED"]
            DFT_COR["corrections/<br/>PLANNED"]
        end

        SRV_WHAMMY["whammy/<br/>PLANNED"]
        SRV_REPORTS["reports/<br/>PLANNED"]
    end

    subgraph "web"
        WEB_WS["ws/<br/>client + reconnect<br/>PLANNED"]
        WEB_SCREENS["screens/<br/>Draft Room, War Room, etc.<br/>PLANNED"]
    end

    ST_PROTO --> ST_ENT --> ST_VAL

    ST_PROTO --> SRV_WS
    ST_ENT --> SRV_AUTH
    ST_VAL --> SRV_AUTH

    SRV_AUTH --> SRV_WS
    SRV_AUTH --> DFT_CQ
    SRV_LEAGUE --> DFT_RES
    SRV_PLAYER --> DFT_NOM

    SRV_WS --> DFT_CQ
    DFT_CQ --> DFT_NOM & DFT_BID & DFT_RES & DFT_AA & DFT_COR
    DFT_NOM --> DFT_BID
    DFT_BID --> DFT_RES
    DFT_AA --> DFT_BID
    DFT_COR --> DFT_RES

    SRV_WHAMMY --> DFT_RES
    SRV_REPORTS --> DFT_RES

    ST_PROTO --> WEB_WS
    ST_ENT --> WEB_SCREENS
    WEB_WS --> WEB_SCREENS
```

## Coupling Analysis

| Module | Fan-In | Fan-Out | Assessment |
|--------|--------|---------|------------|
| `shared-types/protocol.ts` | High (server/ws + web/ws) | Low | Stable contract — change carefully, all WS code depends on it [PLANNED] |
| `server/draft/resolution` | High (bid, nomination, corrections, whammy, reports) | High (league, player, DB) | Hottest module — owns the Acquisition/Ledger/Roster transaction [PLANNED] |
| `server/draft/command-queue` | Medium (WS handler) | High (all draft sub-modules) | Serialization boundary — all mutations flow through here [PLANNED] |
| `server/auth` | Medium (WS, REST, all draft commands) | Low | Every command touches it; keep it thin and fast [PLANNED] |
| `server/ws` | Low (entry point) | High (auth, draft queue) | Top-level orchestrator, thin by design [PLANNED] |
| `web/ws` | Low | Medium (all screens) | Client's single state source — all screens read from it [PLANNED] |

## Circular Dependencies

None planned. The strict layering (shared-types → server/web, web never imports server) prevents cycles. Within `server/draft/`, the queue is the acyclic root — sub-modules do not back-import the queue.
