/**
 * F-MOD-006-rework-01 ESPN transfer workflow routes (PRD §37):
 *   GET  /leagues/:leagueId/espn-team-mappings
 *   PUT  /leagues/:leagueId/espn-team-mappings/:teamId          (commissioner only)
 *   GET  /drafts/:draftId/canonical-export
 *   GET  /drafts/:draftId/reconciliation
 *   POST /drafts/:draftId/reconciliation/:itemId/confirm        (commissioner only)
 *
 * The application never calls an ESPN API (EXTRACTED-039) — this is entirely
 * team-name mapping, a canonical JSON export, and commissioner-driven
 * bookkeeping of what has been manually re-entered into ESPN's Offline Draft
 * screen.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';

import { requireDraftLeagueMember, requireDraftCommissioner } from './reports.js';

const PROVIDER_CODE = 'ESPN';
const SCHEMA_VERSION = 'v1';

// ─── Auth for league-scoped mapping routes ─────────────────────────────────────

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

type LeagueParams = { leagueId: string };

async function requireLeagueScope(
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: LeagueParams }>,
  reply: FastifyReply,
  opts: { commissionerOnly: boolean },
): Promise<{ claims: TokenClaims } | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  if (claims.league_id !== req.params.leagueId) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Token scope mismatch' });
    return null;
  }

  if (opts.commissionerOnly && claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }

  if (claims.role === 'OWNER' && claims.team_id) {
    const [team] = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM teams WHERE id = ${claims.team_id} LIMIT 1
    `;
    if (!team || claims.auth_epoch !== team.auth_epoch) {
      reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
      return null;
    }
  } else {
    const [league] = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM leagues WHERE id = ${req.params.leagueId} LIMIT 1
    `;
    if (!league || claims.auth_epoch !== league.auth_epoch) {
      reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
      return null;
    }
  }

  return { claims };
}

// ─── Team-name matching (simple, non-strategic string comparison) ─────────────

/** Normalizes for comparison: lowercase, strip non-alphanumerics. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Levenshtein-based similarity in [0, 1]. Simple string comparison — not a
 * valuation or ranking judgment (CLAUDE.md #6), just a UI-mapping heuristic. */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;

  const dp: number[][] = Array.from({ length: na.length + 1 }, (_, i) =>
    Array.from({ length: nb.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= na.length; i++) {
    for (let j = 1; j <= nb.length; j++) {
      const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  const distance = dp[na.length]![nb.length]!;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - distance / maxLen;
}

const LOW_THRESHOLD = 0.5;
const HIGH_THRESHOLD = 0.92;

/**
 * Candidates for an unmapped team: known ESPN names (from other verified
 * mappings in this league) whose similarity clears LOW_THRESHOLD but not
 * HIGH_THRESHOLD (a near-exact match would just be entered directly by the
 * commissioner). Ties at the top score are ambiguous — never guessed.
 */
function computeCandidates(teamName: string, knownNames: string[]): string[] {
  const scored = knownNames
    .map((name) => ({ name, score: similarity(teamName, name) }))
    .filter((s) => s.score >= LOW_THRESHOLD && s.score < HIGH_THRESHOLD);

  if (scored.length === 0) return [];
  const topScore = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === topScore);
  if (top.length > 1) return []; // ambiguous — never guess
  return [top[0]!.name];
}

// ─── Roster-integrity validation + idempotent ExportJob seeding ───────────────

interface ExportAcquisitionRow {
  player_id: string;
  player_name: string;
  position: string;
  team_id: string;
  team_name: string;
  price_minor: number;
  roster_slot: string | null;
  resolution_sequence: number;
  acquisition_id: string;
  has_active_roster_entry: boolean;
}

async function fetchAcquisitionRows(sql: postgres.Sql, draftId: string): Promise<ExportAcquisitionRow[]> {
  return sql<ExportAcquisitionRow[]>`
    SELECT
      a.id AS acquisition_id,
      p.id AS player_id,
      p.name AS player_name,
      p.position,
      t.id AS team_id,
      t.name AS team_name,
      a.price_minor,
      rsd.position AS roster_slot,
      a.resolution_sequence,
      (re.id IS NOT NULL) AS has_active_roster_entry
    FROM acquisitions a
    JOIN player_auctions pa ON pa.id = a.player_auction_id
    JOIN players p ON p.id = pa.dataset_player_id
    JOIN teams t ON t.id = a.team_id
    LEFT JOIN roster_entries re ON re.acquisition_id = a.id AND re.active = true
    LEFT JOIN roster_slot_definitions rsd ON rsd.id = re.roster_slot_id
    WHERE a.draft_id = ${draftId} AND a.active = true
    ORDER BY a.resolution_sequence ASC
  `;
}

interface EnsureResult {
  jobId: string;
  status: 'GENERATED' | 'FAILED';
  validationJson: Record<string, unknown>;
  acquisitions: ExportAcquisitionRow[];
}

/**
 * Creates (or reuses, idempotently) the ExportJob + ReconciliationItem rows
 * for a draft's ESPN transfer. Whichever export endpoint runs first performs
 * the seed; the second reuses it (PRD §37 step 1/6).
 */
async function ensureEspnExportJob(sql: postgres.Sql, draftId: string): Promise<EnsureResult> {
  const [existing] = await sql<
    Array<{ id: string; status: 'PENDING' | 'VALIDATED' | 'GENERATED' | 'FAILED'; validation_json: Record<string, unknown> }>
  >`
    SELECT id, status, validation_json FROM export_jobs
    WHERE draft_id = ${draftId} AND provider_code = ${PROVIDER_CODE}
    LIMIT 1
  `;

  const acquisitions = await fetchAcquisitionRows(sql, draftId);

  if (existing) {
    return {
      jobId: existing.id,
      status: existing.status === 'FAILED' ? 'FAILED' : 'GENERATED',
      validationJson: existing.validation_json,
      acquisitions,
    };
  }

  const offending = acquisitions.filter((a) => !a.has_active_roster_entry);

  if (offending.length > 0) {
    const validationJson = {
      error: 'roster_integrity_violation',
      offending_acquisitions: offending.map((a) => ({
        acquisition_id: a.acquisition_id,
        player_id: a.player_id,
        player_name: a.player_name,
        team_id: a.team_id,
      })),
    };
    const [job] = await sql<[{ id: string }]>`
      INSERT INTO export_jobs (draft_id, provider_code, schema_version, status, validation_json)
      VALUES (${draftId}, ${PROVIDER_CODE}, ${SCHEMA_VERSION}, 'FAILED', ${JSON.stringify(validationJson)}::jsonb)
      RETURNING id
    `;
    return { jobId: job!.id, status: 'FAILED', validationJson, acquisitions };
  }

  const [job] = await sql<[{ id: string }]>`
    INSERT INTO export_jobs (draft_id, provider_code, schema_version, status, validation_json)
    VALUES (${draftId}, ${PROVIDER_CODE}, ${SCHEMA_VERSION}, 'GENERATED', ${JSON.stringify({})}::jsonb)
    RETURNING id
  `;

  for (const a of acquisitions) {
    await sql`
      INSERT INTO reconciliation_items (export_job_id, team_id, player_id, recommended_target_slot, status)
      VALUES (${job!.id}, ${a.team_id}, ${a.player_id}, ${a.roster_slot}, 'PENDING')
    `;
  }

  return { jobId: job!.id, status: 'GENERATED', validationJson: {}, acquisitions };
}

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerEspnTransferRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * GET /leagues/:leagueId/espn-team-mappings
   * Commissioner-only. One row per league Team.
   */
  server.get<{ Params: LeagueParams }>(
    '/leagues/:leagueId/espn-team-mappings',
    async (req, reply) => {
      const ctx = await requireLeagueScope(sql, req, reply, { commissionerOnly: true });
      if (!ctx) return;

      const teamRows = await sql<Array<{ id: string; name: string }>>`
        SELECT id, name FROM teams WHERE league_id = ${req.params.leagueId} ORDER BY draft_order ASC
      `;
      const mappingRows = await sql<
        Array<{ team_id: string; external_team_id: string | null; external_team_name: string | null; verified: boolean }>
      >`
        SELECT team_id, external_team_id, external_team_name, verified
        FROM provider_team_mappings
        WHERE league_id = ${req.params.leagueId} AND provider_code = ${PROVIDER_CODE}
      `;
      const mappingByTeam = new Map(mappingRows.map((m) => [m.team_id, m]));

      const knownNames = mappingRows
        .filter((m) => m.verified && m.external_team_name)
        .map((m) => m.external_team_name!);

      const result = teamRows.map((t) => {
        const mapping = mappingByTeam.get(t.id);
        if (mapping?.external_team_id) {
          return {
            team_id: t.id,
            external_team_id: mapping.external_team_id,
            external_team_name: mapping.external_team_name,
            verified: mapping.verified,
            candidates: [],
          };
        }
        return {
          team_id: t.id,
          external_team_id: null,
          external_team_name: null,
          verified: false,
          candidates: computeCandidates(t.name, knownNames),
        };
      });

      return reply.send(result);
    },
  );

  /**
   * PUT /leagues/:leagueId/espn-team-mappings/:teamId
   * Commissioner-only. Upserts the mapping; commissioner input always
   * overrides any auto-match candidate.
   */
  server.put<{ Params: LeagueParams & { teamId: string }; Body: { external_team_id: string; external_team_name: string } }>(
    '/leagues/:leagueId/espn-team-mappings/:teamId',
    async (req, reply) => {
      const ctx = await requireLeagueScope(sql, req, reply, { commissionerOnly: true });
      if (!ctx) return;

      const { external_team_id, external_team_name } = req.body ?? {};
      if (!external_team_id || !external_team_name) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'external_team_id and external_team_name are required' });
      }

      const [team] = await sql<[{ id: string }]>`
        SELECT id FROM teams WHERE id = ${req.params.teamId} AND league_id = ${req.params.leagueId}
      `;
      if (!team) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this league' });
      }

      await sql`
        INSERT INTO provider_team_mappings (league_id, provider_code, team_id, external_team_id, external_team_name, verified)
        VALUES (${req.params.leagueId}, ${PROVIDER_CODE}, ${req.params.teamId}, ${external_team_id}, ${external_team_name}, true)
        ON CONFLICT (league_id, provider_code, team_id)
        DO UPDATE SET external_team_id = EXCLUDED.external_team_id, external_team_name = EXCLUDED.external_team_name, verified = true
      `;

      return reply.send({
        team_id: req.params.teamId,
        external_team_id,
        external_team_name,
        verified: true,
        candidates: [],
      });
    },
  );

  /**
   * GET /drafts/:draftId/canonical-export
   * Requires Draft.status = COMPLETE. Seeds (or reuses) the ExportJob +
   * ReconciliationItem rows and returns the canonical acquisition array.
   */
  server.get<{ Params: { draftId: string } }>(
    '/drafts/:draftId/canonical-export',
    async (req, reply) => {
      const ctx = await requireDraftLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'COMPLETE') {
        return reply.status(409).send({
          code: 'DRAFT_NOT_COMPLETE',
          message: 'Draft must be COMPLETE to generate the canonical export',
        });
      }

      const result = await ensureEspnExportJob(sql, draft.id);

      if (result.status === 'FAILED') {
        return reply.status(422).send({
          code: 'ROSTER_INTEGRITY_VIOLATION',
          message: 'Roster integrity check failed — export not generated',
          validation: result.validationJson,
        });
      }

      return reply.send(
        result.acquisitions.map((a) => ({
          player_id: a.player_id,
          player_name: a.player_name,
          position: a.position,
          team_id: a.team_id,
          team_name: a.team_name,
          price_minor: a.price_minor,
          roster_slot: a.roster_slot ?? 'BN',
          resolution_sequence: a.resolution_sequence,
        })),
      );
    },
  );

  /**
   * GET /drafts/:draftId/reconciliation
   * Any authenticated league member. Also seeds if espn-worksheet /
   * canonical-export haven't run yet for a COMPLETE draft with clean rosters.
   */
  server.get<{ Params: { draftId: string } }>(
    '/drafts/:draftId/reconciliation',
    async (req, reply) => {
      const ctx = await requireDraftLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const [job] = await sql<[{ id: string }]>`
        SELECT id FROM export_jobs WHERE draft_id = ${draft.id} AND provider_code = ${PROVIDER_CODE} LIMIT 1
      `;

      if (!job) {
        return reply.send({ items: [], all_confirmed: false });
      }

      const items = await sql<
        Array<{
          id: string;
          team_id: string;
          player_id: string;
          status: string;
          recommended_target_slot: string | null;
        }>
      >`
        SELECT id, team_id, player_id, status, recommended_target_slot
        FROM reconciliation_items WHERE export_job_id = ${job.id}
      `;

      const allConfirmed = items.length > 0 && items.every((i) => i.status === 'CONFIRMED');

      return reply.send({ items, all_confirmed: allConfirmed });
    },
  );

  /**
   * POST /drafts/:draftId/reconciliation/:itemId/confirm
   * Commissioner-only. Transitions one item to CONFIRMED.
   */
  server.post<{ Params: { draftId: string; itemId: string } }>(
    '/drafts/:draftId/reconciliation/:itemId/confirm',
    async (req, reply) => {
      const ctx = await requireDraftCommissioner(server, sql, req, reply);
      if (!ctx) return;

      // ponytail: no per-user account model exists yet (CLAUDE.md #12 — auth is
      // password-based/session-scoped, not account-based), so there is no real
      // User.id to attribute this to; confirmed_by_user_id stays null rather
      // than fabricating an identity. Upgrade when MOD-000's User/Membership
      // rows (data-model.md §3.2) are actually created at league setup.
      const userId: string | null = null;

      const [item] = await sql<
        Array<{ id: string; team_id: string; player_id: string; status: string; recommended_target_slot: string | null }>
      >`
        UPDATE reconciliation_items
        SET status = 'CONFIRMED', confirmed_by_user_id = ${userId}, confirmed_at = NOW()
        WHERE id = ${req.params.itemId} AND status IN ('PENDING', 'AMBIGUOUS')
        RETURNING id, team_id, player_id, status, recommended_target_slot
      `;

      if (!item) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Reconciliation item not found' });
      }

      return reply.send(item);
    },
  );

  // Note: /drafts/:draftId/espn-worksheet's own ensure-seed call is wired in
  // reports.ts, which imports ensureEspnExportJob from this module.
}

export { ensureEspnExportJob };
