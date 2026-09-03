/**
 * War Room / Draft Room read endpoints:
 *   GET /drafts/:draftId/roster-grid  — all-team budget/roster grid (War Room §5)
 *   GET /drafts/:draftId/config       — roster slot defs + auction config (client-side
 *                                        max-legal-bid + "would fill" logic)
 *   GET /drafts/:draftId/activity     — recent completed auctions (War Room §6)
 *
 * All three are read-only and open to any authenticated league member (COMMISSIONER
 * or OWNER) — this is shared, public in-draft information per screen-information-
 * architecture.md §5 ("who can still compete with me"), not private per-team data.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';

import { computeMaxLegalBid } from '../auction/engine.js';

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

type DraftParams = { draftId: string };

/** Validates any authenticated league member (COMMISSIONER or OWNER). Mirrors reports.ts. */
async function requireLeagueMember(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
): Promise<{ draft: { id: string; league_id: string; status: string }; claims: TokenClaims } | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

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

  const draftRows = await sql<[{ id: string; league_id: string; status: string }]>`
    SELECT id, league_id, status FROM drafts WHERE id = ${req.params.draftId} LIMIT 1
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

export async function registerWarRoomRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // ── Roster / Budget Grid ─────────────────────────────────────────────────────

  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/roster-grid',
    async (req, reply) => {
      const ctx = await requireLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const teamRows = await sql<Array<{ id: string; name: string; draft_order: number }>>`
        SELECT id, name, draft_order FROM teams
        WHERE league_id = ${draft.league_id}
        ORDER BY draft_order ASC
      `;

      const stateRows = await sql<Array<{
        team_id: string;
        remaining_budget_minor: number;
        roster_filled_count: number;
        required_remaining_spots: number;
        control_mode: string;
      }>>`
        SELECT team_id, remaining_budget_minor, roster_filled_count,
               required_remaining_spots, control_mode
        FROM draft_team_states
        WHERE draft_id = ${draft.id}
      `;
      const stateByTeam = new Map(stateRows.map((s) => [s.team_id, s]));

      const slotDefRows = await sql<Array<{
        id: string;
        position: string;
        priority: number;
        is_starter: boolean;
        slot_count: number;
      }>>`
        SELECT rsd.id, rsd.position, rsd.priority, rsd.is_starter, rsd.slot_count
        FROM roster_slot_definitions rsd
        JOIN roster_configurations rc ON rc.id = rsd.config_id
        WHERE rc.league_id = ${draft.league_id}
        ORDER BY rsd.priority ASC
      `;

      const filledRows = await sql<Array<{ team_id: string; roster_slot_id: string; n: number }>>`
        SELECT team_id, roster_slot_id, COUNT(*)::int AS n
        FROM roster_entries
        WHERE draft_id = ${draft.id} AND active = true
        GROUP BY team_id, roster_slot_id
      `;
      const filledByTeamSlot = new Map<string, number>();
      for (const r of filledRows) {
        filledByTeamSlot.set(`${r.team_id}:${r.roster_slot_id}`, r.n);
      }

      const teams = teamRows.map((team) => {
        const state = stateByTeam.get(team.id);
        const remainingBudgetMinor = state?.remaining_budget_minor ?? 0;
        const requiredRemainingSpots = state?.required_remaining_spots ?? 0;

        const slots = slotDefRows.map((slot) => ({
          position: slot.position,
          is_starter: slot.is_starter,
          filled: filledByTeamSlot.get(`${team.id}:${slot.id}`) ?? 0,
          total: slot.slot_count,
        }));

        return {
          team_id: team.id,
          team_name: team.name,
          draft_order: team.draft_order,
          remaining_budget_minor: remainingBudgetMinor,
          max_legal_bid_minor: computeMaxLegalBid(remainingBudgetMinor, requiredRemainingSpots),
          roster_filled_count: state?.roster_filled_count ?? 0,
          control_mode: state?.control_mode ?? 'MANUAL',
          slots,
        };
      });

      return reply.send({ teams });
    },
  );

  // ── Config (roster slots + auction settings) ─────────────────────────────────

  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/config',
    async (req, reply) => {
      const ctx = await requireLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const rosterRows = await sql<Array<{
        total_roster_size: number;
        bench_slots: number;
      }>>`
        SELECT total_roster_size, bench_slots FROM roster_configurations
        WHERE league_id = ${draft.league_id} LIMIT 1
      `;

      const slotRows = await sql<Array<{
        position: string;
        priority: number;
        is_starter: boolean;
        slot_count: number;
      }>>`
        SELECT rsd.position, rsd.priority, rsd.is_starter, rsd.slot_count
        FROM roster_slot_definitions rsd
        JOIN roster_configurations rc ON rc.id = rsd.config_id
        WHERE rc.league_id = ${draft.league_id}
        ORDER BY rsd.priority ASC
      `;

      const auctionCfgRows = await sql<Array<{
        initial_budget_minor: number;
        min_bid_minor: number;
        nomination_timer_ms: number;
        second_bid_timer_ms: number;
        rebid_timer_ms: number;
        anti_snipe_threshold_ms: number;
        anti_snipe_extension_ms: number;
      }>>`
        SELECT initial_budget_minor, min_bid_minor, nomination_timer_ms,
               second_bid_timer_ms, rebid_timer_ms, anti_snipe_threshold_ms,
               anti_snipe_extension_ms
        FROM auction_configurations
        WHERE league_id = ${draft.league_id} LIMIT 1
      `;

      return reply.send({
        roster: rosterRows[0] ?? null,
        roster_slots: slotRows,
        auction: auctionCfgRows[0] ?? null,
      });
    },
  );

  // ── Recent Activity ───────────────────────────────────────────────────────────

  server.get<{ Params: DraftParams }>(
    '/drafts/:draftId/activity',
    async (req, reply) => {
      const ctx = await requireLeagueMember(server, sql, req, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const rows = await sql<Array<{
        acquisition_id: string;
        player_name: string;
        position: string;
        price_minor: number;
        resolution_sequence: number;
        team_id: string;
        team_name: string;
        awarded_at: Date;
        bid_count: number;
      }>>`
        SELECT
          a.id AS acquisition_id,
          p.name AS player_name,
          p.position,
          a.price_minor,
          a.resolution_sequence,
          a.team_id,
          t.name AS team_name,
          a.awarded_at,
          COUNT(ba.id)::int AS bid_count
        FROM acquisitions a
        JOIN player_auctions pa ON pa.id = a.player_auction_id
        JOIN player_dataset_entries pde ON pde.id = pa.dataset_player_id
        JOIN players p ON p.id = pde.player_id
        JOIN teams t ON t.id = a.team_id
        LEFT JOIN bid_attempts ba ON ba.player_auction_id = a.player_auction_id AND ba.accepted = true
        WHERE a.draft_id = ${draft.id} AND a.active = true
        GROUP BY a.id, p.name, p.position, a.price_minor, a.resolution_sequence,
                 a.team_id, t.name, a.awarded_at
        ORDER BY a.resolution_sequence DESC
        LIMIT 15
      `;

      return reply.send({
        recent: rows.map((r) => ({
          acquisition_id: r.acquisition_id,
          player_name: r.player_name,
          position: r.position,
          price_minor: r.price_minor,
          resolution_sequence: r.resolution_sequence,
          team_id: r.team_id,
          team_name: r.team_name,
          awarded_at: r.awarded_at instanceof Date ? r.awarded_at.toISOString() : r.awarded_at,
          bid_count: r.bid_count,
        })),
      });
    },
  );
}
