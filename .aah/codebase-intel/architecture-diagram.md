# System Architecture

> **Note:** Pre-implementation. All components are `[PLANNED]` and derived from design documents.

## Overview

A fantasy-football auction draft platform: real-time server-authoritative salary-cap auction across 12 teams, WebSocket-driven, with post-draft roster transfer to ESPN. One deployment may host multiple concurrent league drafts in isolation. The server owns all auction state; the client is a display + input terminal.

## Architecture Diagram

```mermaid
graph TB
    subgraph "Clients"
        DR["Draft Room<br/>React (bidding surface)<br/>PLANNED"]
        WR["War Room<br/>React (second screen)<br/>PLANNED"]
        CC["Commissioner Console<br/>React<br/>PLANNED"]
        MOB["Mobile View<br/>React responsive<br/>PLANNED"]
    end

    subgraph "shared-types"
        ST["Protocol + Zod Schemas<br/>WS envelope, AUTH shape,<br/>entity types<br/>PLANNED"]
    end

    subgraph "Server — Fastify"
        AUTH["Auth Middleware<br/>HMAC token + auth_epoch<br/>PLANNED"]
        REST["REST API<br/>League config, dataset import<br/>PLANNED"]
        WSH["WS Handler<br/>AUTH handshake, per-draft routing<br/>PLANNED"]

        subgraph "Per-Draft Command Queue (serialized)"
            CQ["Command Queue<br/>one in-flight per draft_id<br/>PLANNED"]
            NOM["Nomination Handler<br/>PLANNED"]
            BID["Bid Pipeline<br/>validate → persist → broadcast<br/>PLANNED"]
            RES["Resolution Handler<br/>Acquisition + Ledger + Roster<br/>PLANNED"]
            AA["Auto-Agent Engine<br/>PLANNED"]
            COR["Corrections + Rollback<br/>PLANNED"]
        end

        WHAMMY["Whammy Engine<br/>PLANNED"]
        REPORTS["Report Generator<br/>Summary + ESPN export<br/>PLANNED"]
    end

    subgraph "Data Stores"
        PG[("PostgreSQL<br/>Primary authority<br/>PLANNED")]
        INMEM[("In-Memory State<br/>per draft_id Map<br/>PLANNED")]
    end

    subgraph "External"
        ESPN["ESPN Fantasy<br/>Transfer worksheet"]
        CSV["Commissioner CSV<br/>Player / AAV data"]
    end

    DR & WR & CC & MOB -->|"WS + REST / HTTPS"| AUTH
    AUTH --> WSH & REST
    WSH --> CQ
    CQ --> NOM & BID & RES & AA & COR
    REST --> REPORTS & WHAMMY
    NOM & BID & RES --> PG
    NOM & BID & RES --> INMEM
    WSH -->|"broadcast DraftEvent"| DR & WR & CC & MOB
    REST --> CSV
    REPORTS --> ESPN
    ST -.->|"shared schemas"| DR & WR & CC & MOB
    ST -.->|"shared schemas"| WSH
```

## Layer Summary

| Layer | Purpose | Key Components |
|-------|---------|----------------|
| Client | Display + input terminal | Draft Room, War Room, Commissioner Console, Mobile View [PLANNED] |
| Shared types | WS protocol contract + Zod validation | protocol.ts, entity types [PLANNED] |
| Auth | Token issuance + epoch validation on every command | HMAC tokens, auth_epoch check [PLANNED] |
| REST API | League setup, dataset import, reports | Fastify routes [PLANNED] |
| WS Handler | Per-draft connection routing, AUTH handshake | ws server, 5s auth timeout [PLANNED] |
| Command Queue | Serialized mutation pipeline (one in-flight per draft) | In-memory queue per draft_id [PLANNED] |
| Draft Core | Nomination FSM, bid atomicity, resolution, ledger, roster | Per-draft state machine [PLANNED] |
| Auto-Agent | Automated bidder / nominator on disconnect | Cadence engine [PLANNED] |
| Corrections | Price correction (in-place) + rollback (reverse order) | CommissionerAction [PLANNED] |
| Whammy | Random budget events with commissioner approval gate | WhammyEvent, ledger entries [PLANNED] |
| Reports | Draft summary, per-team report, ESPN worksheet | DraftSummaryReport [PLANNED] |
| PostgreSQL | Authoritative state + DraftEvent audit log | All entities [PLANNED] |

## External Integrations

- Commissioner CSV import (player data / AAVs / projections) [PLANNED]
- ESPN AAV PDF import [PLANNED]
- FantasyPros / Sleeper / nflverse adapters (Phase 2b) [PLANNED]
- ESPN roster-transfer worksheet (Phase 9) [PLANNED]
- Email delivery for Draft Summary Reports — SendGrid stub (Phase 9) [PLANNED]
