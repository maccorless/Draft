# Dependency Map

## External Dependencies

| Package | Version | Purpose | Category |
|---------|---------|---------|----------|
| fastify | 5.12.x | HTTP server framework | Server / Core |
| @fastify/jwt | 10.2.x | JWT sign/verify | Server / Auth |
| @fastify/websocket | 11.3.x | WS route registration | Server / Realtime |
| @fastify/rate-limit | 11.2.x | Brute-force protection on auth routes | Server / Security |
| @fastify/multipart | 10.1.x | File upload (dataset import, team media) | Server / Ingestion |
| @fastify/cors | 11.3.x | CORS | Server / Core |
| ws | 8.18.x | WebSocket server (auction handler) | Server / Realtime |
| postgres | 3.4.x | PostgreSQL client (raw tagged-template queries) | Server / DB |
| drizzle-orm / drizzle-kit | 0.45.x / 0.31.x | Schema + migrations | Server / DB |
| @node-rs/bcrypt | 1.10.x | Password hashing (work factor 12) | Server / Auth |
| pdfjs-dist | 6.3.x | ESPN PDF dataset import | Server / Ingestion |
| xlsx | 0.18.x | Excel dataset import | Server / Ingestion |
| pino / pino-opentelemetry-transport | — | Structured logging | Server / Observability |
| zod | 3.23.x | Schema validation (shared) | Shared / Validation |
| react / react-dom | 18.3.x | UI rendering | Web / Core |
| react-router-dom | 7.18.x | Client-side routing | Web / Core |
| @phosphor-icons/react | 2.1.x | Icon set | Web / UI |
| vite | 8.2.x | Dev server and bundler | Web / Build |
| typescript | 5.5.x | Type system (all packages) | Dev / Tooling |
| eslint + @typescript-eslint | 9.x / 8.69.x | Linting | Dev / Quality |
| vitest | 5.x | Test runner (no mocks — real Postgres) | Dev / Test |

## Internal Module Dependencies

| Module | Depends On | Depended By |
|--------|-----------|-------------|
| `shared-types/protocol` | — | `server/ws`, `web/*` |
| `shared-types/schemas` | `shared-types/protocol` | `server/auth`, `server/league`, `server/*` |
| `server/auth` | `shared-types/schemas` | `server/ws` (auth flow), `web/screens/auth` |
| `server/league/auth-hook` | — | nearly every authenticated route module |
| `server/auction/queue` (`AsyncQueue`) | — | `server/auction/engine`, `server/auction/auto-agent` |
| `server/auction/engine` | `server/auction/queue`, DB schema | `server/ws/auction-handler`, `server/auction/routes`, `server/auction/auto-agent`, `server/draft/corrections` |
| `server/auction/auto-agent` | `server/auction/engine` (`getOrCreateRuntime`, `processBidCommand`) | `server/ws/auction-handler`, `server/auction/auto-agent-routes` |
| `server/draft/strategy` (Nomination Queue / Watch List) | DB schema | `server/auction/engine` (intended integration point for auto-nomination fix), `web/screens/war-room` |
| `server/draft/do-not-draft` | DB schema | `server/auction/auto-agent`, `server/auction/engine` |
| `server/draft/corrections` | `server/auction/engine` | `web/screens/commissioner/Corrections.tsx` |
| `server/session/routes` (`buildDraftStateSnapshot`) | `server/auction/engine`, DB schema | `server/ws/auction-handler` (on AUTHENTICATE) |
| `server/ws/auction-handler` | `server/auction/engine`, `server/auction/auto-agent`, `server/session/routes` | — (top-level WS entry point) |
| `server/player/*` | DB schema | `server/league` (dataset freeze), `server/auction/engine` (player lookups) |
| `web/src/screens/*` | `shared-types/protocol` (via WS client) | — (top-level) |
