# Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Language | TypeScript | 5.5.x | Primary language — server, web, shared-types (strict mode) |
| Runtime | Node.js | 20+ LTS | Server runtime |
| Framework | Fastify | 5.12.x | HTTP server and REST API |
| Realtime | ws (native WebSockets) | 8.18.x | Per-draft bidirectional event channel at `/ws/drafts/:draftId` |
| Database | PostgreSQL | via `postgres` (postgres.js) 3.4.x | Primary authoritative state store |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45.x / 0.31.x | Schema (`server/db/schema/index.ts`) + migrations (`npm run db:migrate`) |
| Validation | Zod | 3.23.x | Shared client/server schema validation via shared-types |
| Frontend | React | 18.3.x | UI rendering |
| Frontend build | Vite | 8.2.x | Frontend bundler and dev server |
| Frontend routing | react-router-dom | 7.18.x | Client-side routing |
| Monorepo | npm workspaces | — | `server/`, `web/`, `shared-types/` packages |
| Auth | `@fastify/jwt` (HMAC) + `@node-rs/bcrypt` | — | Session tokens with `auth_epoch` revocation; bcrypt work factor 12 |
| Test runner | Vitest | 5.x | Root + per-package configs, no mocks (real Postgres via `vitest.globalSetup.ts`) |
| Ingestion | `pdfjs-dist`, `xlsx` | — | ESPN PDF / Excel draft-dataset import adapters |
| Rate limiting | `@fastify/rate-limit` | 11.x | Auth endpoint brute-force protection |
| Logging | pino + pino-opentelemetry-transport | — | Structured server logs |
| CI | GitHub Actions | — | `.github/workflows/ci.yml` |
| Deployment | Railway | — | `railway.toml` — Node app service + managed Postgres |
