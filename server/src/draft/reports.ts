/**
 * F-MOD-006 Report routes:
 *   GET  /drafts/:draftId/report          — DraftSummaryReport (any league member)
 *   GET  /drafts/:draftId/espn-worksheet  — CSV export (any league member)
 *   POST /drafts/:draftId/report/email    — SendGrid stub (commissioner only)
 *
 * Behavioral constraints:
 * - Reports are read-only queries — no mutations, no new state.
 * - Report is regenerated on each request from Acquisition + DraftTeamState rows.
 * - Draft must be COMPLETE for GET /report and GET /espn-worksheet.
 * - Email dispatch is fire-and-forget; failure must never affect report availability.
 * - No strategic valuation, no blended AAVs — static reference data only (CLAUDE.md #6).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';

import { resolveEffectivePrimarySource } from '../player/aav-resolution.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

type DraftParams = { draftId: string };

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/** Validates any authenticated league member (COMMISSIONER or OWNER). */
async function requireLeagueMember(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
): Promise<{ draft: { id: string; league_id: string; status: string; completed_at: Date | null }; claims: TokenClaims } | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  // Re-read auth_epoch (constraint #12)
  if (claims.role === 'OWNER' && claims.team_id) {
    const rows = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM teams WHERE id = ${claims.team_id} LIMIT 1
    `;
    if (!rows[0] || claims.auth_epoch !== rows[0].auth_epoch) {
      reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
      return null;
    }
  } else {
    const rows = await sql<[{ auth_epoch: number }]>`
      SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
    `;
    if (!rows[0] || claims.auth_epoch !== rows[0].auth_epoch) {
      reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
      return null;
    }
  }

  // Load draft — verify league_id matches token (constraint #11)
  const draftRows = await sql<[{ id: string; league_id: string; status: string; completed_at: Date | null }]>`
    SELECT id, league_id, status, completed_at FROM drafts
    WHERE id = ${req.params.draftId} LIMIT 1
  `;
  const draft = draftRows[0];
  if (!draft) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'Draft not found' });
    return null;
  }
  if (draft.league_id !== claims.league_id) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Draft belongs to a different league' });
    return null;
  }

  return { draft, claims };
}

/** Validates commissioner JWT + auth_epoch + league_id match. */
async function requireCommissioner(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
): Promise<{ draft: { id: string; league_id: string; status: string; completed_at: Date | null }; claims: TokenClaims } | null> {
  const ctx = await requireLeagueMember(server, sql, req, reply);
  if (!ctx) return null;

  if (ctx.claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }

  return ctx;
}

// ─── Report generation ────────────────────────────────────────────────────────

interface AcquisitionEntry {
  player_name: string;
  position: string;
  price_minor: number;
  roster_slot: string;
}

// PRD §36.2: roster_depth_score's formula is versioned and transparent, so a
// future formula change is distinguishable from a past report's figure.
const ROSTER_DEPTH_SCORE_VERSION = 'v1';

interface TeamEntry {
  team_id: string;
  team_name: string;
  final_budget_minor: number;
  acquisitions: AcquisitionEntry[];
  projected_starter_points: number;
  roster_depth_score: { value: number; calculation_version: string };
  aav_efficiency_pct: number;
}

interface DraftSummaryReport {
  draft_id: string;
  completed_at: string;
  teams: TeamEntry[];
  league_totals: { spend_minor: number; aav_minor: number };
}

/**
 * Generates the DraftSummaryReport from live Acquisition + DraftTeamState rows.
 * Read-only; runs async so the event loop is never blocked.
 */
async function generateReport(sql: postgres.Sql, draftId: string): Promise<DraftSummaryReport> {
  // Draft header
  const [draft] = await sql<[{ completed_at: Date; dataset_id: string }]>`
    SELECT completed_at, dataset_id FROM drafts WHERE id = ${draftId}
  `;

  // All teams with their remaining budgets
  const teamRows = await sql<Array<{
    team_id: string;
    team_name: string;
    remaining_budget_minor: number;
  }>>`
    SELECT t.id AS team_id, t.name AS team_name, dts.remaining_budget_minor
    FROM draft_team_states dts
    JOIN teams t ON t.id = dts.team_id
    WHERE dts.draft_id = ${draftId}
    ORDER BY t.draft_order ASC
  `;

  // All acquisitions with player data, roster slot, and whether that slot is
  // a starter slot (PRD §36.1 needs this to exclude bench picks).
  const acquisitionRows = await sql<Array<{
    team_id: string;
    player_id: string;
    player_name: string;
    position: string;
    price_minor: number;
    roster_slot: string;
    is_starter: boolean;
    resolution_sequence: number;
  }>>`
    SELECT
      a.team_id,
      p.id    AS player_id,
      p.name  AS player_name,
      p.position,
      a.price_minor,
      COALESCE(rsd.position, 'BN') AS roster_slot,
      COALESCE(rsd.is_starter, false) AS is_starter,
      a.resolution_sequence
    FROM acquisitions a
    JOIN player_auctions pa ON pa.id = a.player_auction_id
    JOIN players p ON p.id = pa.dataset_player_id
    LEFT JOIN roster_entries re ON re.acquisition_id = a.id AND re.active = true
    LEFT JOIN roster_slot_definitions rsd ON rsd.id = re.roster_slot_id
    WHERE a.draft_id = ${draftId} AND a.active = true
    ORDER BY a.resolution_sequence ASC
  `;

  // Resolve each acquired player's AAV/projected_points from the dataset's
  // effective primary source (F-MOD-016) — one query for every acquisition
  // rather than one round trip per player.
  const effectiveSource = await resolveEffectivePrimarySource(sql, draft.dataset_id);
  const playerIds = [...new Set(acquisitionRows.map((r) => r.player_id))];
  const aavByPlayer = new Map<string, { aav_minor: number; projected_points: number | null }>();
  if (effectiveSource && playerIds.length > 0) {
    const aavRows = await sql<Array<{ player_id: string; aav_minor: number; projected_points: string | null }>>`
      SELECT player_id, aav_minor, projected_points
      FROM player_aav_sources
      WHERE dataset_id = ${draft.dataset_id} AND source = ${effectiveSource} AND player_id = ANY(${playerIds})
    `;
    for (const row of aavRows) {
      aavByPlayer.set(row.player_id, {
        aav_minor: Math.trunc(Number(row.aav_minor)),
        projected_points: row.projected_points !== null ? parseFloat(row.projected_points) : null,
      });
    }
  }

  // Build per-team acquisitions + metric accumulators.
  const acqByTeam = new Map<string, AcquisitionEntry[]>();
  const starterPointsByTeam = new Map<string, number>();
  const benchPointsByTeam = new Map<string, number>();
  const spendByTeam = new Map<string, number>();
  const aavByTeam = new Map<string, number>();
  let leagueSpendMinor = 0;
  let leagueAavMinor = 0;

  for (const row of acquisitionRows) {
    if (!acqByTeam.has(row.team_id)) acqByTeam.set(row.team_id, []);
    acqByTeam.get(row.team_id)!.push({
      player_name: row.player_name,
      position: row.position,
      price_minor: row.price_minor,
      roster_slot: row.roster_slot,
    });

    const points = aavByPlayer.get(row.player_id)?.projected_points ?? 0;
    if (row.is_starter) {
      starterPointsByTeam.set(row.team_id, (starterPointsByTeam.get(row.team_id) ?? 0) + points);
    } else {
      benchPointsByTeam.set(row.team_id, (benchPointsByTeam.get(row.team_id) ?? 0) + points);
    }

    const resolvedAav = aavByPlayer.get(row.player_id)?.aav_minor;
    if (resolvedAav !== undefined) {
      spendByTeam.set(row.team_id, (spendByTeam.get(row.team_id) ?? 0) + row.price_minor);
      aavByTeam.set(row.team_id, (aavByTeam.get(row.team_id) ?? 0) + resolvedAav);
      leagueSpendMinor += row.price_minor;
      leagueAavMinor += resolvedAav;
    }
  }

  const teams: TeamEntry[] = teamRows.map((t) => {
    const sumAav = aavByTeam.get(t.team_id) ?? 0;
    const sumPrice = spendByTeam.get(t.team_id) ?? 0;
    // AAV efficiency (PRD §36.3): how purchase price compares to the frozen
    // dataset's AAV. Positive = paid under AAV on average, negative =
    // paid over. Never a fair-value/skill judgment (CLAUDE.md #6) — just a
    // labeled comparison of two already-known numbers.
    const aavEfficiencyPct = sumAav > 0 ? ((sumAav - sumPrice) / sumAav) * 100 : 0;

    return {
      team_id: t.team_id,
      team_name: t.team_name,
      final_budget_minor: t.remaining_budget_minor,
      acquisitions: acqByTeam.get(t.team_id) ?? [],
      projected_starter_points: starterPointsByTeam.get(t.team_id) ?? 0,
      roster_depth_score: {
        value: benchPointsByTeam.get(t.team_id) ?? 0,
        calculation_version: ROSTER_DEPTH_SCORE_VERSION,
      },
      aav_efficiency_pct: aavEfficiencyPct,
    };
  });

  return {
    draft_id: draftId,
    completed_at: draft.completed_at instanceof Date
      ? draft.completed_at.toISOString()
      : String(draft.completed_at),
    teams,
    league_totals: { spend_minor: leagueSpendMinor, aav_minor: leagueAavMinor },
  };
}

/**
 * Generates ESPN-compatible CSV for manual roster entry.
 * Rows are ordered by team then resolution_sequence (draft order).
 * No ESPN API is called (EXTRACTED-039, CLAUDE.md #9).
 */
async function generateEspnCsv(sql: postgres.Sql, draftId: string): Promise<string> {
  const rows = await sql<Array<{
    team_name: string;
    player_name: string;
    position: string;
    price_minor: number;
    roster_slot: string;
    resolution_sequence: number;
  }>>`
    SELECT
      t.name  AS team_name,
      p.name  AS player_name,
      p.position,
      a.price_minor,
      COALESCE(rsd.position, 'BN') AS roster_slot,
      a.resolution_sequence
    FROM acquisitions a
    JOIN player_auctions pa ON pa.id = a.player_auction_id
    JOIN players p ON p.id = pa.dataset_player_id
    JOIN teams t ON t.id = a.team_id
    LEFT JOIN roster_entries re ON re.acquisition_id = a.id AND re.active = true
    LEFT JOIN roster_slot_definitions rsd ON rsd.id = re.roster_slot_id
    WHERE a.draft_id = ${draftId} AND a.active = true
    ORDER BY t.draft_order ASC, a.resolution_sequence ASC
  `;

  const header = 'Team,Player,Position,Price (Minor Units),Roster Slot';
  const dataLines = rows.map((r) =>
    [
      csvEscape(r.team_name),
      csvEscape(r.player_name),
      csvEscape(r.position),
      String(r.price_minor),
      csvEscape(r.roster_slot),
    ].join(','),
  );

  return [header, ...dataLines].join('\n');
}

function csvEscape(value: string): string {
  // RFC 4180: wrap in quotes if value contains comma, quote, or newline
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerReportRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * GET /drafts/:draftId/report
   *
   * Returns the DraftSummaryReport JSON for a COMPLETE draft.
   * Any authenticated league member can call this.
   * Report is regenerated each call from live Acquisition + DraftTeamState rows
   * — no separate storage needed (constraint: survives server restart).
   */
  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/report',
    async (req, reply) => {
      const ctx = await requireLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'COMPLETE') {
        return reply.status(409).send({
          code: 'DRAFT_NOT_COMPLETE',
          message: 'Draft must be COMPLETE to retrieve a report',
        });
      }

      const report = await generateReport(sql, draft.id);
      return reply.send(report);
    },
  );

  /**
   * GET /drafts/:draftId/espn-worksheet
   *
   * Returns a downloadable CSV file in ESPN roster-entry order.
   * No ESPN API is called (EXTRACTED-039).
   * Content-Disposition header includes the draft id.
   */
  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/espn-worksheet',
    async (req, reply) => {
      const ctx = await requireLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      if (draft.status !== 'COMPLETE') {
        return reply.status(409).send({
          code: 'DRAFT_NOT_COMPLETE',
          message: 'Draft must be COMPLETE to download the ESPN worksheet',
        });
      }

      const csv = await generateEspnCsv(sql, draft.id);

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="espn-worksheet-${draft.id}.csv"`,
        )
        .send(csv);
    },
  );

  /**
   * POST /drafts/:draftId/report/email
   *
   * Commissioner-only. Stub that logs dispatch intent and returns 202.
   * Until Phase 9 wire-up, the SendGrid call is replaced by a log statement.
   * Email delivery failure must never affect in-app report availability (EXTRACTED-038).
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/report/email',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      // Count teams in this league (recipients)
      const [countRow] = await sql<[{ recipients: number }]>`
        SELECT COUNT(*)::int AS recipients FROM teams WHERE league_id = ${draft.league_id}
      `;
      const recipients = countRow?.recipients ?? 0;

      // ponytail: SendGrid stub — log the dispatch attempt; real wire-up in Phase 9.
      server.log.info(
        { draft_id: draft.id, recipients, sendgrid_key_set: !!process.env['SENDGRID_API_KEY'] },
        '[reports] email dispatch stub — SendGrid wire-up deferred to Phase 9',
      );

      return reply.status(202).send({ accepted: true, recipients });
    },
  );
}
