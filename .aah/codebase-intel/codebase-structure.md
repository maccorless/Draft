# Codebase Structure

> **Note:** Pre-implementation project. All entries are `[PLANNED]` and derived from design documents.

## Directory Layout

```
Draft/                                   # project root
├── server/                              # [PLANNED] Fastify + ws backend
│   ├── src/
│   │   ├── index.ts                     # [PLANNED] server entry point
│   │   ├── auth/                        # [PLANNED] HMAC token, epoch validation
│   │   ├── league/                      # [PLANNED] League/Team/Membership CRUD
│   │   ├── player/                      # [PLANNED] DraftDataset, Player, ingestion
│   │   ├── draft/                       # [PLANNED] Draft FSM, command queue
│   │   │   ├── commands/                # [PLANNED] bid, nominate, pause, correct
│   │   │   ├── auction/                 # [PLANNED] PlayerAuction FSM
│   │   │   ├── resolution/              # [PLANNED] Acquisition, ledger, roster
│   │   │   ├── auto-agent/              # [PLANNED] Auto-Agent control loop
│   │   │   └── rollback/               # [PLANNED] rollback + price correction
│   │   ├── ws/                          # [PLANNED] WS handler, auth handshake, broadcast
│   │   ├── whammy/                      # [PLANNED] WhammyConfiguration, events
│   │   └── reports/                     # [PLANNED] DraftSummaryReport, ESPN export
│   ├── migrations/                      # [PLANNED] DB schema migrations
│   └── package.json
├── web/                                 # [PLANNED] React + Vite frontend
│   ├── src/
│   │   ├── main.tsx                     # [PLANNED] app entry point
│   │   ├── screens/
│   │   │   ├── lobby/                   # [PLANNED] pre-draft lobby
│   │   │   ├── draft-room/              # [PLANNED] active bidding surface
│   │   │   ├── war-room/                # [PLANNED] second screen / analytics
│   │   │   ├── commissioner/            # [PLANNED] commissioner console
│   │   │   ├── board/                   # [PLANNED] draft board / presentation
│   │   │   └── mobile/                  # [PLANNED] mobile draft view
│   │   ├── ws/                          # [PLANNED] WS client, reconnect logic
│   │   └── components/
│   └── package.json
├── shared-types/                        # [PLANNED] Zod schemas + TS types shared by server + web
│   ├── src/
│   │   ├── protocol.ts                  # [PLANNED] WS envelope, AUTH shape, command/ack shapes
│   │   ├── entities.ts                  # [PLANNED] domain entity types
│   │   └── validation.ts                # [PLANNED] shared Zod validators
│   └── package.json
├── knowledge/                           # design documents (non-code)
│   ├── PRD.md
│   ├── data-model.md
│   ├── state-machine-flows.md
│   ├── screen-information-architecture.md
│   └── BUILD_PLAN.md
├── .aah/                                # AAH harness state
├── CLAUDE.md                            # project + AAH delivery rules
└── package.json                         # [PLANNED] monorepo root
```

## Entry Points

| File | Role | Description |
|------|------|-------------|
| `server/src/index.ts` | Server entry | Start Fastify + WS, crash recovery (RUNNING→PAUSED) [PLANNED] |
| `web/src/main.tsx` | Web entry | Mount React app, init WS connection [PLANNED] |
| `shared-types/src/protocol.ts` | Protocol definition | Versioned WS envelope, AUTH handshake shape [PLANNED] |

## API Routes (planned — Phase 1+)

| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/health` | GET | health | Server health check [PLANNED] |
| `/auth/login` | POST | auth | League/team password login, returns HMAC token [PLANNED] |
| `/leagues` | POST | league | Create league (commissioner setup) [PLANNED] |
| `/leagues/:id/draft-dataset` | POST | dataset | Freeze DraftDataset from import [PLANNED] |
| `/leagues/:id/draft` | POST | draft | Create Draft [PLANNED] |
| `/drafts/:id/pause` | POST | draft | Pause/resume Draft [PLANNED] |
| `/drafts/:id/corrections` | POST | corrections | Price correction or trigger rollback [PLANNED] |
| `/ws` | WS upgrade | ws | Per-draft WebSocket connection (AUTH as first message) [PLANNED] |

## Module Organization

Domain-layered within a three-package monorepo. `shared-types` is the contract layer; `server` owns all mutable state and business logic; `web` is a thin presentation layer consuming the WS event stream and REST API. All draft state mutations flow through the per-draft serialized command queue in `server/src/draft/`.
