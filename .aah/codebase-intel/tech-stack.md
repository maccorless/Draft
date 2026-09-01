# Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Language | TypeScript | latest | Primary language — server and web [PLANNED] |
| Runtime | Node.js | 20+ LTS | Server runtime [PLANNED] |
| Framework | Fastify | 4.x | HTTP server and REST API [PLANNED] |
| Realtime | ws (native WebSockets) | — | Per-draft bidirectional event channel [PLANNED] |
| Database | PostgreSQL | 15+ | Primary authoritative state store [PLANNED] |
| Validation | Zod | 3.x | Shared client/server schema validation via shared-types [PLANNED] |
| Frontend | React | 18.x | UI rendering [PLANNED] |
| Frontend build | Vite | 5.x | Frontend bundler and dev server [PLANNED] |
| Monorepo | npm workspaces (or pnpm) | — | server/, web/, shared-types/ packages [PLANNED] |
| Migration | TBD (node-pg-migrate / Drizzle / Prisma) | — | DB schema migration; decision required in Phase 0 [PLANNED] |
| Auth | HMAC-signed JWTs (custom) | — | Session tokens with auth_epoch revocation [PLANNED] |
| CI | GitHub Actions | — | Typecheck + lint + test on push [PLANNED] |
| Linting | ESLint + Prettier | — | Code style enforcement [PLANNED] |
