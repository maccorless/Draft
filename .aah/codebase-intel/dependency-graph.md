# Module Dependencies

## Overview

Three-package monorepo with a strict layering rule: `web` and `server` both consume `shared-types`; `web` never imports `server`. Within `server`, `auction/queue.ts`'s `AsyncQueue` is the serialization boundary — `auction/engine.ts` (the core FSM) and everything downstream of it (auto-agent, corrections, whammy, reports) route through it, keyed by `draft_id`. Module names below reflect the actual implemented layout, not the original design-doc sketch (there is no separate `draft/nomination/` or `draft/bid-pipeline/` directory — those concerns live inside `auction/engine.ts`).

## Dependency Graph

```mermaid
graph TD
    subgraph "shared-types"
        ST_PROTO["protocol.ts<br/>WS envelope + AUTH shape"]
        ST_SCHEMA["schemas/<br/>auth.ts, league.ts, auction.ts"]
    end

    subgraph "server"
        SRV_AUTH["auth/routes.ts<br/>token issuance"]
        SRV_HOOK["league/auth-hook.ts<br/>requireCommissioner /<br/>requireLeagueMember"]
        SRV_LEAGUE["league/routes.ts<br/>League/Team CRUD"]
        SRV_PLAYER["player/*<br/>DraftDataset + ingestion + aav-resolution"]
        SRV_WS["ws/handler.ts + auction-handler.ts"]
        SRV_SESSION["session/routes.ts<br/>buildDraftStateSnapshot"]
        SRV_TEAMMEDIA["team-media/*"]

        subgraph "auction/ (serialized pipeline)"
            AUC_QUEUE["queue.ts<br/>AsyncQueue"]
            AUC_ENGINE["engine.ts<br/>nomination + bid + award FSM,<br/>getOrCreateRuntime"]
            AUC_AA["auto-agent.ts<br/>control-mode FSM +<br/>willingness ceiling"]
            AUC_ROUTES["routes.ts + auto-agent-routes.ts"]
        end

        subgraph "draft/"
            DFT_STRAT["strategy.ts<br/>Watch List + Nomination Queue"]
            DFT_DND["do-not-draft.ts"]
            DFT_COR["corrections.ts<br/>price correction + rollback"]
            DFT_WHAMMY["whammy.ts"]
            DFT_REPORTS["reports.ts"]
            DFT_WARROOM["war-room.ts"]
            DFT_CONTROL["draft-control.ts"]
        end
    end

    subgraph "web"
        WEB_SOCKET["lib/useAuctionSocket.ts<br/>WS client hook"]
        WEB_SCREENS["screens/*<br/>Draft Room, War Room,<br/>Commissioner Console, Lobby"]
    end

    ST_PROTO --> ST_SCHEMA
    ST_SCHEMA --> SRV_AUTH
    ST_PROTO --> SRV_WS

    SRV_AUTH --> SRV_HOOK
    SRV_HOOK --> SRV_LEAGUE
    SRV_HOOK --> AUC_ROUTES
    SRV_HOOK --> DFT_CONTROL

    SRV_WS --> AUC_QUEUE
    AUC_QUEUE --> AUC_ENGINE
    AUC_ENGINE --> AUC_AA
    AUC_ENGINE --> DFT_COR
    AUC_ENGINE --> DFT_STRAT
    AUC_ENGINE --> DFT_DND
    DFT_WHAMMY --> AUC_ENGINE
    DFT_REPORTS --> AUC_ENGINE
    DFT_WARROOM --> AUC_ENGINE
    SRV_SESSION --> AUC_ENGINE
    SRV_WS --> SRV_SESSION

    SRV_PLAYER --> SRV_LEAGUE
    SRV_PLAYER --> AUC_ENGINE

    ST_PROTO --> WEB_SOCKET
    ST_SCHEMA --> WEB_SCREENS
    WEB_SOCKET --> WEB_SCREENS
```

## Coupling Analysis

| Module | Fan-In | Fan-Out | Assessment |
|--------|--------|---------|------------|
| `shared-types/protocol.ts` | High (server/ws, web/lib) | Low | Stable contract — a breaking change requires coordinated update across every consumer |
| `server/auction/engine.ts` | High (ws/auction-handler, auto-agent, corrections, whammy, reports, war-room, session) | High (queue, DB schema, strategy, do-not-draft) | Hottest module (~1290 lines) — every bid/nominate/award/rollback path runs through it |
| `server/auction/queue.ts` | Medium (ws/auction-handler) | Low | The serialization boundary — breaking it allows concurrent mutations to race; never bypass, even from a timer callback |
| `server/league/auth-hook.ts` | High (nearly every authenticated route module) | Low | Every command touches it; correctness bugs here are league-wide |
| `server/ws/auction-handler.ts` | Low (entry point) | High (queue, session) | Top-level orchestrator — owns `server_receipt_time` stamping and the commissioner on-behalf-of override |
| `web/lib/useAuctionSocket.ts` | Low | Medium (all screens) | Client's single WS state source — all screens read from it |

## Circular Dependencies

None detected. The strict layering (`shared-types` → `server`/`web`, `web` never imports `server`) prevents cycles. Within `server/auction/`, `queue.ts` is the acyclic root — `engine.ts` and downstream `draft/*` modules do not back-import the queue directly (they call into `engine.ts`, which owns the queue interaction).
