# Codebase Structure

> Reflects the implemented codebase as of the wave-18 catch-up refresh (F-MOD-000 through F-MOD-017, plus reworks, all `done`). Superseded the pre-implementation `[PLANNED]` layout — actual module names differ from the original design-doc sketch (e.g. `draft/nomination/`, `draft/bid-pipeline/` never existed; nomination/bid/award all live in `auction/engine.ts`).

## Directory Layout

```
Draft/                                   # project root
├── server/                              # Fastify + ws backend
│   ├── src/
│   │   ├── main.ts                      # server entry point: env check → crash recovery → Fastify start
│   │   ├── health.ts                    # /health liveness route
│   │   ├── auth/
│   │   │   └── routes.ts                # site/league/team password login, HMAC JWT issuance
│   │   ├── league/
│   │   │   ├── routes.ts                # League/Team/Membership/RosterConfig/AuctionConfig CRUD
│   │   │   └── auth-hook.ts             # requireCommissioner / requireLeagueMember (auth_epoch checks)
│   │   ├── player/                      # DraftDataset lifecycle + ingestion
│   │   │   ├── routes.ts
│   │   │   ├── aav-resolution.ts        # resolvePlayerPrimaryAav / multi-source AAV blending policy
│   │   │   ├── csv-worker.ts / excel-worker.ts / espn-pdf-worker.ts
│   │   │   └── adapters/                # csv.ts, excel.ts, espn-pdf.ts, fantasypros.ts, types.ts
│   │   ├── auction/                     # the auction engine (nomination + bid + award FSM)
│   │   │   ├── engine.ts                # core FSM: processBidCommand, processNominateCommand, awardAuction, computeMaxLegalBid (~1290 lines)
│   │   │   ├── queue.ts                 # AsyncQueue — per-draft serialized command queue
│   │   │   ├── auto-agent.ts            # control-mode FSM + willingness-ceiling bidding cadence
│   │   │   ├── auto-agent-routes.ts     # PUT auto-agent, PATCH control-mode
│   │   │   └── routes.ts                # start/pause/resume draft
│   │   ├── draft/                       # surrounding draft features
│   │   │   ├── strategy.ts              # Watch List + Nomination Queue (getTopNominationQueueEntry)
│   │   │   ├── do-not-draft.ts          # per-team Do Not Draft list
│   │   │   ├── corrections.ts           # price-only correction + reverse-order rollback
│   │   │   ├── reports.ts               # DraftSummaryReport, ESPN worksheet CSV, SendGrid email stub
│   │   │   ├── war-room.ts              # second-screen analytics data
│   │   │   ├── whammy.ts                # WhammyEvent trigger + budget-ledger integration
│   │   │   └── draft-control.ts         # commissioner draft-control endpoints
│   │   ├── session/
│   │   │   └── routes.ts                # buildDraftStateSnapshot — reconnect/session snapshot
│   │   ├── team-media/
│   │   │   ├── routes.ts                # icon + nomination-audio upload
│   │   │   └── storage.ts
│   │   ├── ws/
│   │   │   ├── handler.ts               # generic WS connection lifecycle
│   │   │   └── auction-handler.ts       # per-draft WS endpoint: AUTH handshake, server_receipt_time stamp, command dispatch, commissioner on-behalf-of override
│   │   ├── dev/
│   │   │   └── routes.ts                # /dev/reseed (non-production only)
│   │   ├── config/
│   │   │   └── env-check.cjs            # startup env validator (ERR_CDR_78_EX_CONFIG)
│   │   └── __tests__/                   # 24+ files, named F-MOD-NNN_<area>.test.ts
│   ├── db/
│   │   ├── schema/index.ts              # single Drizzle schema file — all 32 tables
│   │   ├── migrate.ts / seed.ts / seed-data.ts / wipe.ts
│   │   └── migrations/                  # Drizzle-generated SQL migrations
│   └── package.json
├── web/                                 # React + Vite frontend
│   ├── src/
│   │   ├── main.tsx                     # app entry point
│   │   ├── App.tsx                      # router + DevIdentityPicker (dev-only quick sign-in)
│   │   ├── lib/
│   │   │   └── useAuctionSocket.ts      # WS client hook: connect, reconnect, event dispatch
│   │   ├── components/
│   │   │   ├── AuctionCloseCard.tsx     # auction-close summary card (F-MOD-017)
│   │   │   ├── PlayerDetailPopover.tsx  # player detail popover (F-MOD-017)
│   │   │   ├── TeamIcon.tsx / TeamMediaUpload.tsx
│   │   │   └── NominationAudioPlayer.tsx
│   │   ├── screens/
│   │   │   ├── lobby/index.tsx          # pre-draft lobby
│   │   │   ├── draft-room/index.tsx     # primary live bidding UI
│   │   │   ├── war-room/index.tsx       # second-screen analytics view
│   │   │   ├── draft-complete/index.tsx # post-draft summary screen
│   │   │   └── commissioner/            # Commissioner Console
│   │   │       ├── index.tsx
│   │   │       ├── LeagueSetup.tsx
│   │   │       ├── DatasetImport.tsx
│   │   │       ├── DraftControl.tsx
│   │   │       ├── Corrections.tsx
│   │   │       ├── AmbiguityResolution.tsx
│   │   │       └── DevTools.tsx
│   │   └── __tests__/
│   └── package.json
├── shared-types/                        # Zod schemas + TS types shared by server + web
│   ├── src/
│   │   ├── protocol.ts                  # WS envelope, AUTH shape, command/event shapes
│   │   ├── schemas/                     # auth.ts, league.ts, auction.ts, index.ts
│   │   └── index.ts
│   └── package.json
├── knowledge/                           # design documents (non-code, authoritative spec)
│   ├── PRD.md
│   ├── data-model.md
│   ├── state-machine-flows.md
│   ├── screen-information-architecture.md
│   └── BUILD_PLAN.md
├── .aah/                                # AAH harness state
├── CLAUDE.md                            # project + AAH delivery rules
└── package.json                         # npm workspaces root (server, web, shared-types)
```

## Entry Points

| File | Role | Description |
|------|------|-------------|
| `server/src/main.ts` | Server entry | Env check → crash recovery (all `RUNNING` drafts forced to `PAUSED`) → Fastify + WS start |
| `web/src/main.tsx` | Web entry | Mount React app |
| `web/src/App.tsx` | Web router | Screen routing + `DevIdentityPicker` (dev-only one-click sign-in) |
| `shared-types/src/protocol.ts` | Protocol definition | Versioned WS envelope, AUTH handshake shape |

## API Routes

| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/health` | GET | `health.ts` | Liveness check |
| `/auth/site`, `/auth/league/:id` | POST | `auth/routes.ts` | Site/league/team password login, HMAC JWT issuance |
| `/leagues`, `/leagues/:id/*` | CRUD | `league/routes.ts` | League/Team/Membership/RosterConfiguration/AuctionConfiguration |
| `/drafts/:draftId/start`, `/pause`, `/resume` | POST | `auction/routes.ts` | Draft FSM transitions |
| `/drafts/:draftId/teams/:teamId/auto-agent` | PUT | `auction/auto-agent-routes.ts` | Enable/disable Auto-Agent |
| `/drafts/:draftId/teams/:teamId/control-mode` | PATCH | `auction/auto-agent-routes.ts` | MANUAL/AUTO_AGENT switch |
| `/drafts/:draftId/corrections` | POST | `draft/corrections.ts` | Price correction (in-place) or rollback trigger |
| `/drafts/:draftId/rollback/preview` | GET | `draft/corrections.ts` | Read-only rollback dry-run: per-pick budget/roster/Whammy impact + current `state_version` for staleness detection (F-MOD-005-rework-01) |
| `/leagues/:leagueId/players` | GET | `player/routes.ts` | Persistent player list; now `requireLeagueMember` (was `requireCommissioner`, was 403-ing Owners) |
| `/drafts/:draftId/report` | GET | `draft/reports.ts` | DraftSummaryReport (COMPLETE drafts only) |
| `/drafts/:draftId/espn-worksheet` | GET | `draft/reports.ts` | CSV export for ESPN roster transfer |
| `/drafts/:draftId/report/email` | POST | `draft/reports.ts` | SendGrid email stub (commissioner only) |
| Watch List / Nomination Queue / Do Not Draft CRUD | GET/POST/DELETE | `draft/strategy.ts`, `draft/do-not-draft.ts` | Private per-team lists |
| `/ws/drafts/:draftId` | WS upgrade | `ws/auction-handler.ts` | Per-draft WS connection: AUTHENTICATE, BID_COMMAND, NOMINATE_COMMAND, PASS_NOMINATION, NOMINATOR_MATCH_COMMAND |
| `/dev/reseed` | POST | `dev/routes.ts` | Non-production dev reseed |
| Team icon / nomination-audio upload | POST | `team-media/routes.ts` | Media upload for owner customization |

## Module Organization

Domain-layered within a three-package npm-workspaces monorepo. `shared-types` is the contract layer; `server` owns all mutable state and business logic; `web` is a thin presentation layer consuming the WS event stream + REST API. All draft state mutations flow through the per-draft serialized `AsyncQueue` in `server/src/auction/queue.ts`, wired via `getOrCreateRuntime(draftId)` in `server/src/auction/engine.ts`. The original design-doc split of `draft/nomination|bid-pipeline|resolution|auto-agent|rollback` subfolders was not built as separate directories — those concerns are implemented as functions within `auction/engine.ts` and `auction/auto-agent.ts`, with `draft/corrections.ts` as the standalone rollback/price-correction module.
