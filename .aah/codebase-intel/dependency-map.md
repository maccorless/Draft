# Dependency Map

> **Note:** Pre-implementation. All entries are `[PLANNED]`.

## External Dependencies

| Package | Version | Purpose | Category |
|---------|---------|---------|----------|
| fastify | 4.x | HTTP server framework | Server / Core [PLANNED] |
| ws | 8.x | WebSocket server | Server / Realtime [PLANNED] |
| pg / postgres | — | PostgreSQL client | Server / DB [PLANNED] |
| zod | 3.x | Schema validation (shared) | Shared / Validation [PLANNED] |
| react | 18.x | UI rendering | Web / Core [PLANNED] |
| react-dom | 18.x | DOM rendering | Web / Core [PLANNED] |
| vite | 5.x | Dev server and bundler | Web / Build [PLANNED] |
| typescript | 5.x | Type system (all packages) | Dev / Tooling [PLANNED] |
| eslint | 8.x | Linting | Dev / Quality [PLANNED] |
| prettier | 3.x | Code formatting | Dev / Quality [PLANNED] |
| vitest / jest | — | Test runner (TBD) | Dev / Test [PLANNED] |
| node-pg-migrate / drizzle / prisma | — | DB migrations (one to be chosen in Phase 0) | Server / DB [PLANNED] |

## Internal Module Dependencies

| Module | Depends On | Depended By |
|--------|-----------|-------------|
| `shared-types/protocol` | — | `server/ws`, `web/ws` [PLANNED] |
| `shared-types/entities` | `shared-types/protocol` | `server/*`, `web/*` [PLANNED] |
| `server/auth` | `shared-types/entities` | `server/ws`, `server/draft/*`, `server/league` [PLANNED] |
| `server/draft/commands` | `server/auth`, `shared-types` | `server/ws` [PLANNED] |
| `server/draft/auction` | `server/draft/commands` | `server/draft/resolution` [PLANNED] |
| `server/draft/resolution` | `server/draft/auction`, `server/league` | `server/ws` [PLANNED] |
| `server/draft/auto-agent` | `server/draft/commands`, `server/player` | `server/draft/auction` [PLANNED] |
| `server/draft/rollback` | `server/draft/resolution`, `server/draft/auction` | `server/ws` [PLANNED] |
| `server/ws` | `server/auth`, `server/draft/*`, `shared-types` | — (top-level) [PLANNED] |
| `web/ws` | `shared-types/protocol` | `web/screens/*` [PLANNED] |
