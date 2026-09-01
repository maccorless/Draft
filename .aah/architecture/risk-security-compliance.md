# Risk, Security, and Compliance

**Project:** Draft — Fantasy Football Auction Platform
**Date:** 2026-08-31
**Tier:** mvp
**Scope:** Global (one per project)

---

## 1. Overview

This document covers security controls, risk areas, and performance targets for the mvp tier. The platform is a private hobby application (12 teams, 1-5 concurrent leagues) and is explicitly NOT subject to SOC 2, HIPAA, PCI, or other regulatory frameworks. Controls are proportional to actual risk.

---

## 2. Authentication and Authorization

### 2.1 Auth Model

| Layer | Mechanism | Notes |
|-------|-----------|-------|
| Site access | Site password → bcrypt compare | One shared password; all league participants know it |
| League access | League or team password → bcrypt compare → JWT | Separate commissioner and per-team passwords |
| Token signing | HMAC-SHA256 JWT (@fastify/jwt) | Secret from `JWT_SECRET` env var (Railway managed) |
| Token expiry | 48 hours | Re-auth required after expiry |
| Revocation | `auth_epoch` bump | Instantly invalidates all previously issued tokens for that scope |

### 2.2 auth_epoch Enforcement

**Risk:** A stolen or leaked JWT can be used until expiry (up to 48h).

**Control:** `auth_epoch` is stored on the `League` and `Team` rows. Every command handler re-reads it from the database (via the preHandler hook) and rejects any token whose `payload.auth_epoch` does not match the current DB value. Bumping `auth_epoch` (password change or explicit revoke) invalidates all existing tokens immediately.

**Implementation note:** `auth_epoch` must NOT be cached in-memory between commands. It is always re-read.

### 2.3 Role Enforcement

| Role | Permissions |
|------|-------------|
| COMMISSIONER | All team actions + draft control, corrections, rollback, Whammy, reports, dataset management |
| HOST | Observe only; no mutating commands |
| OWNER | Bid, nominate, manage own team's strategy; no cross-team data |

`league_id` from the JWT payload must match the `league_id` of the target draft on EVERY command. This is checked independently at both routing and auth preHandler layers.

---

## 3. Password Security

| Decision | Value | Rationale |
|----------|-------|-----------|
| Hashing | @node-rs/bcrypt | Native bcrypt, work factor 12 |
| Work factor | 12 | ~250ms per hash on modern hardware; acceptable for low-volume auth |
| Storage | Only hash stored | Plaintext never persisted |
| Rotation | auth_epoch bump + re-hash | Commissioner rotates passwords; all tokens for that scope invalidated |

bcrypt is intentionally slow. At work factor 12, a brute-force attack on a stolen hash is computationally expensive. Given this is a hobby app with physical attendance at the draft, the risk of credential compromise is low.

---

## 4. Rate Limiting

| Scope | Limit | Library |
|-------|-------|---------|
| Auth routes | 5 failures per IP per minute | @fastify/rate-limit (in-memory) |
| All other routes | No limit (low volume, private app) | — |

In-memory rate limiting is sufficient for single-instance Railway deployment. If multiple instances are added in the future, shared state (Redis) would be needed, but that is explicitly out of scope.

---

## 5. WebSocket Security

| Risk | Control |
|------|---------|
| Unauthenticated WS connections | First message must be AUTHENTICATE; server closes connection if not received within 5s |
| Token replay after disconnect | auth_epoch checked on reconnect; stale tokens rejected |
| Cross-draft data leakage | Broadcast groups keyed by `draft_id`; a client in Draft A never receives Draft B events |
| Multi-draft isolation | Every command re-checks that `payload.draft_id` matches `token.league_id`'s draft ownership |

---

## 6. Data Security

### 6.1 Secrets

| Secret | Storage | Notes |
|--------|---------|-------|
| JWT_SECRET | Railway env var | Never committed to code; not in `.env.example` value field |
| DATABASE_URL | Railway env var | Injected automatically by Railway; never hardcoded |
| SENDGRID_API_KEY | Railway env var | Used only for post-draft email |
| All passwords | DB as bcrypt hash only | Plaintext discarded after hashing |

### 6.2 Private Data

`OwnerTargetValue` rows are only returned to the authenticated team. They are never included in WS broadcasts. The API requires `team_id` in the JWT to match the target `team_id`.

### 6.3 Append-Only History

All financial rows (`Acquisition`, `BudgetLedgerEntry`, `RosterEntry`) are append-only. `active = false` supersedes; no hard deletes. This provides an auditable record of all transactions.

---

## 7. Input Validation

All inputs are validated with Zod schemas defined in `shared-types/`. Validation runs:
- **FE:** before submitting a REST request or WS command
- **BE:** in Fastify's request validation (via Zod-to-JSON-Schema) for REST; in the WS message handler for WS commands

**Critical bid validations (server-only):**
- `bid_amount_minor >= min_bid_minor`
- `bid_amount_minor > current_bid_minor` (ABSOLUTE type)
- `bid_amount_minor <= max_legal_bid` where `max_legal_bid = remaining_budget_minor - (100 * required_remaining_roster_spots)`
- `expected_auction_version == player_auction.auction_version` (RELATIVE/NOMINATOR_MATCH)
- `player_auction.status == OPEN`
- `team.remaining_budget_minor >= bid_amount_minor + reserve_for_remaining_spots`

The server NEVER silently adjusts a user's entered amount. Rejected bids return a specific error code.

---

## 8. Bid Pipeline Performance

| Target | Metric | Notes |
|--------|--------|-------|
| p99 bid latency | < 200ms | From WS receipt to broadcast |
| Measurement | OTel histogram `bid_pipeline_duration_ms` | Via pino-opentelemetry-transport |
| Serialization overhead | Per-draft AsyncQueue | One command in-flight per draft; at 1-5 concurrent leagues this is negligible |
| DB write cost | ~10-30ms | INSERT bid_attempt + UPDATE player_auction + INSERT draft_event in one transaction |
| Broadcast cost | O(n) where n = connected clients per draft | At 12 teams, n ≤ ~30 connections (Draft Room + War Room per team) |

If p99 exceeds target, the first investigation point is the DB write cost. Postgres on Railway is on the same network as the Node service.

---

## 9. Concurrency Safety

| Risk | Control |
|------|---------|
| Two bids arriving simultaneously for the same auction | Per-draft serialized AsyncQueue (Map<draft_id, AsyncQueue>); one command in-flight at a time |
| Timer expiry racing with a bid | Timer expiry is enqueued through the same AsyncQueue; cannot interleave with a bid |
| In-memory state getting ahead of a failed DB commit | In-memory state is updated AFTER commit, never before; on commit failure the state is unchanged |
| Draft state on crash/restart | Any RUNNING draft is set to PAUSED on startup before WS accepts connections |

---

## 10. Infrastructure Security

| Area | Control |
|------|---------|
| TLS | Railway provides TLS termination; all traffic is HTTPS/WSS in production |
| Database access | DATABASE_URL is internal to Railway; not publicly accessible |
| Environment secrets | Railway env var injection; no secrets in `.env.example` value fields, Git history, or code |
| Startup validation | Env checker (`config/env-check.cjs`) fails with `ERR_CDR_78_EX_CONFIG` if any required var is missing |
| CORS | Restrict `Access-Control-Allow-Origin` to `RAILWAY_PUBLIC_DOMAIN` value |

---

## 11. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R-01 | JWT secret leaked from `.env` | Low | High | Railway env vars; gitignored `.env`; env checker |
| R-02 | In-memory command queue lost on crash | Medium | Medium | Any RUNNING draft → PAUSED on restart; commissioner resumes |
| R-03 | Timer fires against stale deadline after pause/resume | Low | High | Timers always compare against the server's current `player_auction.rebid_deadline` row, not in-memory cache |
| R-04 | Budget desync between in-memory and DB | Low | High | `remaining_budget_minor` always recalculated from active BudgetLedgerEntries on reconnect/snapshot |
| R-05 | Rollback applied to wrong picks | Low | High | Rollback operates on `resolution_sequence DESC` order; all-or-nothing transaction |
| R-06 | Price correction makes a later pick illegal | Medium | Medium | Ledger replay gate: correction rejected if any later pick becomes illegal |
| R-07 | auth_epoch cached and not re-read | Low | High | Implementation rule: auth_epoch re-read on every command preHandler, never from token payload |
| R-08 | FantasyPros API down at import time | Medium | Low | Import is pre-draft only; fallback to CSV/Excel imports; draft is not affected |
| R-09 | SendGrid delivery failure post-draft | Low | Low | Report is also downloadable via REST; email is best-effort |
| R-10 | Railway single-region outage during draft | Low | Critical | Out of scope for mvp; no mitigation beyond Railway's own HA |

---

## 12. Non-Goals (Security Scope)

| Not In Scope | Rationale |
|--------------|-----------|
| SOC 2 / HIPAA / PCI compliance | Hobby application; no regulated data |
| End-to-end encryption of WS messages | Railway TLS handles transport encryption |
| Multi-region failover | Single Railway service; acceptable for 12-team hobby draft |
| Audit log export or retention policy | DraftEvent log is stored in Postgres; no external SIEM |
| Penetration testing | Proportionate to risk level of a private hobby app |
| Mobile push notifications | All participants at devices during draft |

---

## Provenance

| Section | Origin | Source |
|---------|--------|--------|
| Auth Model | Inherited | `knowledge/PRD.md` (§4.4 Auth), `decision-registry.yaml` → `password-hashing`, `jwt-signing`, `secrets-management` |
| auth_epoch Enforcement | Inherited | `knowledge/data-model.md` (§3.6), `CLAUDE.md` (constraint #12) |
| Password Security | Inherited | `decision-registry.yaml` → `password-hashing` |
| Rate Limiting | Inherited | `decision-registry.yaml` → `rate-limiter-approach` |
| WS Security | Inherited | `knowledge/PRD.md` (§39, WS protocol), `CLAUDE.md` (constraint #11) |
| Data Security | Inherited | `decision-registry.yaml` → `secrets-management`, `state-management-model` |
| Bid Pipeline Performance | Inherited | `decision-registry.yaml` → `bid-latency-target`, `observability-impl` |
| Concurrency Safety | Inherited | `knowledge/state-machine-flows.md` (§4, §26), `CLAUDE.md` (constraint #4) |
| Infrastructure Security | Inherited | `decision-registry.yaml` → `railway-topology`, `ci-cd-pipeline` |
| Risk Register | Authored | Architecture phase risk analysis, `knowledge/PRD.md` constraints, `decision-registry.yaml` → `crash-recovery-ux` |
| Non-Goals | Inherited | `discuss-prd.md` (Solution boundaries), `project-intent.yaml` (constraints) |
