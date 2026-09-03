/**
 * Session REST routes (F-MOD-003):
 *   GET /leagues/:leagueId/drafts  — list drafts for a league (lobby/reconnect flow)
 *   GET /drafts/:draftId/state     — full DraftStateSnapshot (REST fallback; WS preferred)
 *
 * Both require a valid bearer JWT. auth_epoch is re-read from DB on every request.
 * Per constraint #11: every request also verifies league_id matches token.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

async function verifyTokenAndEpoch(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<TokenClaims | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  // Re-read auth_epoch from DB — constraint #12
  const rows = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
  `;
  const league = rows[0];
  if (!league) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
    return null;
  }
  if (claims.auth_epoch !== league.auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  return claims;
}

export async function registerSessionRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * GET /leagues/:leagueId/drafts
   * Returns { drafts: DraftSummary[] } — id, league_id, status, started_at, completed_at
   */
  server.get<{ Params: { leagueId: string } }>(
    '/leagues/:leagueId/drafts',
    async (req, reply) => {
      const claims = await verifyTokenAndEpoch(server, sql, req, reply);
      if (!claims) return;

      const { leagueId } = req.params;

      // Constraint #11: token's league_id must match the path leagueId
      if (claims.league_id !== leagueId) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'League mismatch' });
      }

      const drafts = await sql<Array<{
        id: string;
        league_id: string;
        status: string;
        started_at: string | null;
        completed_at: string | null;
      }>>`
        SELECT id, league_id, status,
               started_at::text AS started_at,
               completed_at::text AS completed_at
        FROM drafts
        WHERE league_id = ${leagueId}
        ORDER BY started_at DESC NULLS LAST
      `;

      return reply.send({
        drafts: drafts.map((d) => ({
          id: d.id,
          league_id: d.league_id,
          status: d.status,
          started_at: d.started_at ?? null,
          completed_at: d.completed_at ?? null,
        })),
      });
    },
  );

  /**
   * GET /drafts/:draftId/state
   * Returns DraftStateSnapshot — REST fallback; WS STATE_SNAPSHOT is the preferred delivery path.
   */
  server.get<{ Params: { draftId: string } }>(
    '/drafts/:draftId/state',
    async (req, reply) => {
      const claims = await verifyTokenAndEpoch(server, sql, req, reply);
      if (!claims) return;

      const { draftId } = req.params;

      // Load draft
      const draftRows = await sql<[{ id: string; league_id: string; status: string }]>`
        SELECT id, league_id, status FROM drafts WHERE id = ${draftId} LIMIT 1
      `;
      const draft = draftRows[0];
      if (!draft) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Draft not found' });
      }

      // Constraint #11: token's league_id must match the draft's league_id
      if (claims.league_id !== draft.league_id) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'League mismatch' });
      }

      const snapshot = await buildDraftStateSnapshot(sql, draftId, draft.status);
      return reply.send(snapshot);
    },
  );
}

/**
 * Build a full DraftStateSnapshot from the DB for a given draftId.
 * Used by both the REST endpoint and the WS reconnect flow.
 */
export async function buildDraftStateSnapshot(
  sql: postgres.Sql,
  draftId: string,
  status: string,
): Promise<DraftStateSnapshot> {
  // Load all team states for this draft
  const teamStates = await sql<Array<{
    team_id: string;
    remaining_budget_minor: number;
    roster_filled_count: number;
    control_mode: string;
  }>>`
    SELECT team_id, remaining_budget_minor, roster_filled_count, control_mode
    FROM draft_team_states
    WHERE draft_id = ${draftId}
  `;

  // Whose turn it is to nominate — derived from nomination_cursor + draft_order
  // the same way engine.ts's turn-advance logic resolves it. There is no
  // broadcast event for this until the *first* turn changes (draft start
  // doesn't announce a nominator), so a client attaching before that has
  // nothing else to go on.
  let currentNominatorTeamId: string | null = null;
  const draftRows = await sql<Array<{ nomination_cursor: number }>>`
    SELECT nomination_cursor FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
  if (draftRows[0]) {
    const orderedTeams = await sql<Array<{ id: string }>>`
      SELECT t.id FROM teams t
      JOIN drafts d ON d.league_id = t.league_id
      WHERE d.id = ${draftId}
      ORDER BY t.draft_order ASC
    `;
    if (orderedTeams.length > 0) {
      const idx = draftRows[0].nomination_cursor % orderedTeams.length;
      currentNominatorTeamId = orderedTeams[idx]?.id ?? null;
    }
  }

  // Load active auction (if any), enriched with player details so the Draft
  // Room can render on initial load/reconnect without a second round trip —
  // live clients also get player_name etc. via the NOMINATION_STARTED broadcast,
  // but a client attaching mid-auction only has this snapshot to go on.
  const auctionRows = await sql<Array<{
    id: string;
    current_bid_minor: number;
    current_leader_id: string | null;
    auction_version: number;
    nomination_deadline: Date | null;
    rebid_deadline: Date | null;
    nominator_team_id: string | null;
    player_name: string;
    position: string;
    nfl_team: string;
    tier: number | null;
    aav_minor: number;
    projected_points: string | null;
  }>>`
    SELECT
      pa.id, pa.current_bid_minor, pa.current_leader_id, pa.auction_version,
      pa.nomination_deadline, pa.rebid_deadline, pa.nominator_team_id,
      p.name AS player_name, p.position, p.nfl_team,
      pde.tier, pde.aav_minor, pde.projected_points
    FROM player_auctions pa
    JOIN player_dataset_entries pde ON pde.id = pa.dataset_player_id
    JOIN players p ON p.id = pde.player_id
    WHERE pa.draft_id = ${draftId} AND pa.status = 'OPEN'
    LIMIT 1
  `;
  const auction = auctionRows[0] ?? null;

  // Get max sequence for this draft
  const [seqRow] = await sql<[{ max: number | null }]>`
    SELECT MAX(sequence) AS max FROM draft_events WHERE draft_id = ${draftId}
  `;
  const asOfSequence = seqRow.max ?? -1;

  return {
    draft_id: draftId,
    status,
    teams: teamStates.map((t) => ({
      team_id: t.team_id,
      remaining_budget_minor: t.remaining_budget_minor,
      roster_filled_count: t.roster_filled_count,
      control_mode: t.control_mode,
    })),
    current_nominator_team_id: currentNominatorTeamId,
    current_auction: auction
      ? {
          player_auction_id: auction.id,
          current_bid_minor: auction.current_bid_minor,
          leading_team_id: auction.current_leader_id,
          auction_version: auction.auction_version,
          nomination_deadline_ts: auction.nomination_deadline
            ? new Date(auction.nomination_deadline as unknown as string | Date).getTime()
            : 0,
          rebid_deadline_ts: auction.rebid_deadline
            ? new Date(auction.rebid_deadline as unknown as string | Date).getTime()
            : 0,
          nominator_team_id: auction.nominator_team_id,
          player_name: auction.player_name,
          position: auction.position,
          nfl_team: auction.nfl_team,
          tier: auction.tier,
          aav_minor: auction.aav_minor,
          projected_points: auction.projected_points !== null ? Number(auction.projected_points) : null,
        }
      : null,
    as_of_sequence: asOfSequence,
    missed_events_replayed: 0, // set by WS handler when replaying; REST always 0
  };
}

export interface DraftStateSnapshot {
  draft_id: string;
  status: string;
  current_nominator_team_id: string | null;
  teams: Array<{
    team_id: string;
    remaining_budget_minor: number;
    roster_filled_count: number;
    control_mode: string;
  }>;
  current_auction: {
    player_auction_id: string;
    current_bid_minor: number;
    leading_team_id: string | null;
    auction_version: number;
    nomination_deadline_ts: number;
    rebid_deadline_ts: number;
    nominator_team_id: string | null;
    player_name: string;
    position: string;
    nfl_team: string;
    tier: number | null;
    aav_minor: number;
    projected_points: number | null;
  } | null;
  as_of_sequence: number;
  missed_events_replayed: number;
}
