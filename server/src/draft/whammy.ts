/**
 * Commissioner Whammy: Budget Entertainment Events (F-MOD-009)
 *
 *   POST /drafts/:draftId/whammy               — trigger whammy (commissioner only)
 *   POST /drafts/:draftId/whammy/:whammyId/approve — approve pending whammy
 *   POST /drafts/:draftId/whammy/:whammyId/reject  — reject pending whammy
 *
 * Behavioral constraints:
 * - Whammies flow through BudgetLedgerEntry (entry_type=WHAMMY) — no separate ledger.
 * - All effects are append-only; no existing rows mutated except DraftTeamState balance.
 * - Whammy is entertainment/optional: if not configured or disabled, silently rejects.
 * - Money is exact integer units; server never silently alters the commissioner's amount.
 * - validate → persist + DraftEvent in same transaction → broadcast (constraint #4).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';
import { broadcast } from '../auction/engine.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenClaims {
  league_id: string;
  role: string;
  auth_epoch: number;
}

interface DraftRow {
  id: string;
  league_id: string;
  status: string;
}

interface WhammyConfig {
  enabled: boolean;
  allow_positive: boolean;
  allow_negative: boolean;
  max_per_team: number | null;
  max_per_draft: number | null;
  commissioner_approval_required: boolean;
}

type DraftParams = { draftId: string };
type WhammyParams = { draftId: string; whammyId: string };
type LeagueParams = { leagueId: string };
type DefinitionParams = { leagueId: string; definitionId: string };

interface WhammyDefinitionRow {
  id: string;
  name: string;
  type: string;
  budget_delta_minor: number | null;
  trigger_rule_json: Record<string, unknown> | string;
  display_message: string;
  offline_action_text: string | null;
  weight: number;
  active: boolean;
}

// ─── Auth helper (mirrors corrections.ts pattern) ─────────────────────────────

async function requireCommissioner(
  server: FastifyInstance,
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: DraftParams | WhammyParams }>,
  reply: FastifyReply,
): Promise<{ draft: DraftRow; claims: TokenClaims } | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  if (claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }

  // Re-check auth_epoch (constraint #12 — only revocation mechanism)
  const [league] = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM leagues WHERE id = ${claims.league_id} LIMIT 1
  `;
  if (!league) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'League not found' });
    return null;
  }
  if (claims.auth_epoch !== league.auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  const draftId = (req.params as DraftParams).draftId;
  const [draft] = await sql<[DraftRow]>`
    SELECT id, league_id, status FROM drafts WHERE id = ${draftId} LIMIT 1
  `;
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

/** League-scoped commissioner auth (WhammyDefinition CRUD — no :draftId param). */
async function requireLeagueCommissioner(
  req: FastifyRequest<{ Params: LeagueParams | DefinitionParams }>,
  reply: FastifyReply,
  sql: postgres.Sql,
): Promise<TokenClaims | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }
  if (claims.role !== 'COMMISSIONER') {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Commissioner role required' });
    return null;
  }
  const { leagueId } = req.params;
  if (claims.league_id !== leagueId) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Token scope mismatch' });
    return null;
  }
  const [league] = await sql<[{ auth_epoch: number }]>`
    SELECT auth_epoch FROM leagues WHERE id = ${leagueId} LIMIT 1
  `;
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

// ─── Whammy config loader ─────────────────────────────────────────────────────

async function loadWhammyConfig(
  sql: postgres.Sql,
  leagueId: string,
): Promise<WhammyConfig | null> {
  const [row] = await sql<[WhammyConfig]>`
    SELECT enabled, allow_positive, allow_negative, max_per_team, max_per_draft,
           commissioner_approval_required
    FROM whammy_configs
    WHERE league_id = ${leagueId}
    LIMIT 1
  `;
  return row ?? null;
}

// ─── Roster-completion invariant check ───────────────────────────────────────
//
// After the whammy amount is applied, the team must still be able to legally complete
// their roster: remaining_budget + amount_minor >= required_remaining_spots * 100
// (each spot needs at minimum $1 bid = 100 minor units).

async function checkRosterCompletionFeasible(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
  amountMinor: number,
): Promise<boolean> {
  const [state] = await sql<[{
    remaining_budget_minor: number;
    required_remaining_spots: number;
  }]>`
    SELECT remaining_budget_minor, required_remaining_spots
    FROM draft_team_states
    WHERE draft_id = ${draftId} AND team_id = ${teamId}
    LIMIT 1
  `;
  if (!state) return false;

  const projectedBudget = state.remaining_budget_minor + amountMinor;
  const minRequired = state.required_remaining_spots * 100;
  return projectedBudget >= minRequired;
}

// ─── Draft event sequence helper (mirrors corrections.ts) ─────────────────────

async function nextEventSeq(tx: postgres.TransactionSql, draftId: string): Promise<number> {
  const [row] = await tx<[{ max: number | null }]>`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS max FROM draft_events WHERE draft_id = ${draftId}
  `;
  return row?.max ?? 0;
}

// ─── Core apply logic (shared between immediate and approve paths) ─────────────

async function applyWhammy(
  sql: postgres.Sql,
  draftId: string,
  teamId: string,
  amountMinor: number,
  description: string,
  whammyEventId: string | null,
  definitionId: string | null = null,
  triggerEventSequence: number | null = null,
): Promise<{ whammyEventId: string; newRemainingBudgetMinor: number }> {
  let resolvedWhammyId = whammyEventId ?? '';
  let newRemainingBudget = 0;

  await sql.begin(async (tx) => {
    // 1. Create or confirm WhammyEvent (status=APPLIED)
    if (!whammyEventId) {
      // Immediate path: create WhammyEvent with status=APPLIED in the same transaction
      const [we] = await tx<[{ id: string }]>`
        INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status, definition_id, trigger_event_sequence)
        VALUES (${draftId}, ${teamId}, ${amountMinor}, ${description}, 'APPLIED', ${definitionId}, ${triggerEventSequence})
        RETURNING id
      `;
      resolvedWhammyId = we!.id;
    } else {
      // Approval path: update existing PENDING_APPROVAL → APPLIED
      await tx`
        UPDATE whammy_events SET status = 'APPLIED' WHERE id = ${whammyEventId}
      `;
    }

    // 2. Append BudgetLedgerEntry (entry_type=WHAMMY, reference_id=whammyEventId)
    const [ble] = await tx<[{ id: string }]>`
      INSERT INTO budget_ledger_entries
        (draft_id, team_id, amount_minor, entry_type, reference_id, active)
      VALUES
        (${draftId}, ${teamId}, ${amountMinor}, 'WHAMMY', ${resolvedWhammyId}, true)
      RETURNING id
    `;

    // 3. Link BudgetLedgerEntry back to WhammyEvent
    await tx`
      UPDATE whammy_events SET budget_ledger_entry_id = ${ble!.id} WHERE id = ${resolvedWhammyId}
    `;

    // 4. Update DraftTeamState.remaining_budget_minor
    const [stateRow] = await tx<[{ remaining_budget_minor: number }]>`
      UPDATE draft_team_states
      SET remaining_budget_minor = remaining_budget_minor + ${amountMinor}
      WHERE draft_id = ${draftId} AND team_id = ${teamId}
      RETURNING remaining_budget_minor
    `;
    newRemainingBudget = stateRow!.remaining_budget_minor;

    // 5. Append WHAMMY_APPLIED DraftEvent
    const seq = await nextEventSeq(tx, draftId);
    await tx`
      INSERT INTO draft_events (draft_id, sequence, event_type, team_id, payload, created_at)
      VALUES (
        ${draftId}, ${seq}, 'WHAMMY_APPLIED', ${teamId},
        ${JSON.stringify({
          whammy_event_id: resolvedWhammyId,
          team_id: teamId,
          amount_minor: amountMinor,
          description,
          new_remaining_budget_minor: newRemainingBudget,
        })}::jsonb,
        NOW()
      )
    `;
  });

  return { whammyEventId: resolvedWhammyId, newRemainingBudgetMinor: newRemainingBudget };
}

// ─── Request body schema ──────────────────────────────────────────────────────

const WhammyRequestBody = z.object({
  team_id: z.string().uuid(),
  amount_minor: z.number().int().refine((n) => n !== 0, { message: 'amount_minor must be non-zero' }),
  description: z.string().min(1),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerWhammyRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * POST /drafts/:draftId/whammy
   *
   * Commissioner triggers a whammy for a specific team.
   * Validates against WhammyConfiguration constraints.
   * If commissioner_approval_required → creates PENDING_APPROVAL event, no budget effect.
   * Otherwise → applies immediately in one transaction, broadcasts WHAMMY_APPLIED.
   */
  server.post<{ Params: DraftParams }>(
    '/drafts/:draftId/whammy',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req, reply);
      if (!ctx) return;
      const { draft, claims } = ctx;

      const bodyParse = WhammyRequestBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { team_id, amount_minor, description } = bodyParse.data;

      // Load whammy config
      const config = await loadWhammyConfig(sql, claims.league_id);
      if (!config || !config.enabled) {
        return reply.status(409).send({ code: 'WHAMMY_DISABLED', message: 'Whammy is not enabled for this league' });
      }

      // Sign check
      if (amount_minor > 0 && !config.allow_positive) {
        return reply.status(409).send({ code: 'WHAMMY_POSITIVE_NOT_ALLOWED', message: 'Positive whammy amounts are not allowed' });
      }
      if (amount_minor < 0 && !config.allow_negative) {
        return reply.status(409).send({ code: 'WHAMMY_NEGATIVE_NOT_ALLOWED', message: 'Negative whammy amounts are not allowed' });
      }

      // Verify target team exists in this draft
      const [teamState] = await sql<[{ remaining_budget_minor: number }]>`
        SELECT remaining_budget_minor FROM draft_team_states
        WHERE draft_id = ${draft.id} AND team_id = ${team_id}
        LIMIT 1
      `;
      if (!teamState) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this draft' });
      }

      // max_per_team check
      if (config.max_per_team !== null) {
        const [{ count }] = await sql<[{ count: number }]>`
          SELECT COUNT(*)::int AS count FROM whammy_events
          WHERE draft_id = ${draft.id} AND team_id = ${team_id} AND status = 'APPLIED'
        `;
        if (count >= config.max_per_team) {
          return reply.status(409).send({
            code: 'WHAMMY_MAX_PER_TEAM_EXCEEDED',
            message: `Team has reached the maximum of ${config.max_per_team} whammy(s)`,
          });
        }
      }

      // max_per_draft check
      if (config.max_per_draft !== null) {
        const [{ count }] = await sql<[{ count: number }]>`
          SELECT COUNT(*)::int AS count FROM whammy_events
          WHERE draft_id = ${draft.id} AND status = 'APPLIED'
        `;
        if (count >= config.max_per_draft) {
          return reply.status(409).send({
            code: 'WHAMMY_MAX_PER_DRAFT_EXCEEDED',
            message: `Draft has reached the maximum of ${config.max_per_draft} whammy(s)`,
          });
        }
      }

      // Roster-completion invariant: only enforce for negative whammies (debits)
      if (amount_minor < 0) {
        const feasible = await checkRosterCompletionFeasible(sql, draft.id, team_id, amount_minor);
        if (!feasible) {
          return reply.status(409).send({
            code: 'WHAMMY_ROSTER_COMPLETION_INFEASIBLE',
            message: 'This whammy would make it impossible for the team to legally complete their roster',
          });
        }
      }

      // Approval gate
      if (config.commissioner_approval_required) {
        // Create PENDING_APPROVAL event — no budget effect, no broadcast
        const [we] = await sql<[{ id: string }]>`
          INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status)
          VALUES (${draft.id}, ${team_id}, ${amount_minor}, ${description}, 'PENDING_APPROVAL')
          RETURNING id
        `;
        return reply.send({
          whammy_id: we!.id,
          status: 'PENDING_APPROVAL',
          team_id,
          amount_minor,
        });
      }

      // Immediate apply
      const result = await applyWhammy(sql, draft.id, team_id, amount_minor, description, null);

      // Broadcast after commit (constraint #4)
      broadcast(draft.id, {
        type: 'WHAMMY_APPLIED',
        payload: {
          team_id,
          amount_minor,
          description,
          new_remaining_budget_minor: result.newRemainingBudgetMinor,
        },
      });

      return reply.send({
        team_id,
        amount_minor,
        new_remaining_budget_minor: result.newRemainingBudgetMinor,
      });
    },
  );

  /**
   * POST /drafts/:draftId/whammy/:whammyId/approve
   *
   * Commissioner approves a PENDING_APPROVAL whammy.
   * Runs roster-completion invariant check again (amount could now be infeasible).
   * Applies the whammy in a single transaction: BudgetLedgerEntry + DraftTeamState + DraftEvent.
   * Broadcasts WHAMMY_APPLIED after commit.
   */
  server.post<{ Params: WhammyParams }>(
    '/drafts/:draftId/whammy/:whammyId/approve',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req as FastifyRequest<{ Params: DraftParams }>, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const { whammyId } = req.params;

      // Load the WhammyEvent — must be PENDING_APPROVAL and in this draft
      const [we] = await sql<[{
        id: string;
        team_id: string;
        amount_minor: number;
        description: string;
        status: string;
      }]>`
        SELECT id, team_id, amount_minor, description, status
        FROM whammy_events
        WHERE id = ${whammyId} AND draft_id = ${draft.id}
        LIMIT 1
      `;

      if (!we) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Whammy event not found' });
      }
      if (we.status !== 'PENDING_APPROVAL') {
        return reply.status(409).send({ code: 'WHAMMY_NOT_PENDING', message: 'Whammy is not in PENDING_APPROVAL status' });
      }

      // Re-run roster-completion invariant (situation may have changed since trigger)
      if (we.amount_minor < 0) {
        const feasible = await checkRosterCompletionFeasible(sql, draft.id, we.team_id, we.amount_minor);
        if (!feasible) {
          return reply.status(409).send({
            code: 'WHAMMY_ROSTER_COMPLETION_INFEASIBLE',
            message: 'This whammy would now make it impossible for the team to legally complete their roster',
          });
        }
      }

      const result = await applyWhammy(sql, draft.id, we.team_id, we.amount_minor, we.description, whammyId);

      // Broadcast after commit
      broadcast(draft.id, {
        type: 'WHAMMY_APPLIED',
        payload: {
          team_id: we.team_id,
          amount_minor: we.amount_minor,
          description: we.description,
          new_remaining_budget_minor: result.newRemainingBudgetMinor,
        },
      });

      return reply.send({
        team_id: we.team_id,
        amount_minor: we.amount_minor,
        new_remaining_budget_minor: result.newRemainingBudgetMinor,
      });
    },
  );

  /**
   * POST /drafts/:draftId/whammy/:whammyId/reject
   *
   * Commissioner rejects a PENDING_APPROVAL whammy.
   * Sets status=REJECTED; no budget effect, no broadcast.
   */
  server.post<{ Params: WhammyParams }>(
    '/drafts/:draftId/whammy/:whammyId/reject',
    async (req, reply) => {
      const ctx = await requireCommissioner(server, sql, req as FastifyRequest<{ Params: DraftParams }>, reply);
      if (!ctx) return;
      const { draft } = ctx;

      const { whammyId } = req.params;

      const [we] = await sql<[{ id: string; status: string }]>`
        SELECT id, status FROM whammy_events
        WHERE id = ${whammyId} AND draft_id = ${draft.id}
        LIMIT 1
      `;

      if (!we) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Whammy event not found' });
      }
      if (we.status !== 'PENDING_APPROVAL') {
        return reply.status(409).send({ code: 'WHAMMY_NOT_PENDING', message: 'Whammy is not in PENDING_APPROVAL status' });
      }

      await sql`UPDATE whammy_events SET status = 'REJECTED' WHERE id = ${whammyId}`;

      return reply.send({ whammy_id: whammyId, status: 'REJECTED' });
    },
  );

  // ── WhammyDefinition CRUD (F-MOD-009-rework-01) ─────────────────────────────
  // Commissioner-only, league-scoped (not draft-scoped) — these configure the
  // event catalog the auto-trigger evaluator below selects from.

  const WhammyDefinitionRequestBody = z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    budget_delta_minor: z.number().int().nullable().optional(),
    trigger_rule_json: z.record(z.string(), z.unknown()).optional().default({}),
    weight: z.number().int().positive().optional().default(1),
    display_message: z.string().min(1),
    offline_action_text: z.string().nullable().optional(),
    active: z.boolean().optional().default(true),
  });

  server.post<{ Params: LeagueParams }>(
    '/leagues/:leagueId/whammy-definitions',
    async (req, reply) => {
      const claims = await requireLeagueCommissioner(req, reply, sql);
      if (!claims) return;

      const parse = WhammyDefinitionRequestBody.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const d = parse.data;
      const [row] = await sql<[WhammyDefinitionRow]>`
        INSERT INTO whammy_definitions
          (league_id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active)
        VALUES
          (${req.params.leagueId}, ${d.name}, ${d.type}, ${d.budget_delta_minor ?? null},
           ${JSON.stringify(d.trigger_rule_json)}::jsonb, ${d.display_message}, ${d.offline_action_text ?? null},
           ${d.weight}, ${d.active})
        RETURNING id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active
      `;
      return reply.status(201).send(row);
    },
  );

  server.get<{ Params: LeagueParams }>(
    '/leagues/:leagueId/whammy-definitions',
    async (req, reply) => {
      const claims = await requireLeagueCommissioner(req, reply, sql);
      if (!claims) return;

      const rows = await sql<WhammyDefinitionRow[]>`
        SELECT id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active
        FROM whammy_definitions WHERE league_id = ${req.params.leagueId}
        ORDER BY name
      `;
      return reply.send(rows);
    },
  );

  server.put<{ Params: DefinitionParams }>(
    '/leagues/:leagueId/whammy-definitions/:definitionId',
    async (req, reply) => {
      const claims = await requireLeagueCommissioner(req, reply, sql);
      if (!claims) return;

      const parse = WhammyDefinitionRequestBody.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const { leagueId, definitionId } = req.params;
      const [existing] = await sql<[{ id: string } | undefined]>`
        SELECT id FROM whammy_definitions WHERE id = ${definitionId} AND league_id = ${leagueId} LIMIT 1
      `;
      if (!existing) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Whammy definition not found' });
      }
      const d = parse.data;
      const [row] = await sql<[WhammyDefinitionRow]>`
        UPDATE whammy_definitions SET
          name = ${d.name}, type = ${d.type}, budget_delta_minor = ${d.budget_delta_minor ?? null},
          trigger_rule_json = ${JSON.stringify(d.trigger_rule_json)}::jsonb, display_message = ${d.display_message},
          offline_action_text = ${d.offline_action_text ?? null}, weight = ${d.weight}, active = ${d.active}
        WHERE id = ${definitionId}
        RETURNING id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active
      `;
      return reply.send(row);
    },
  );
}

// ─── Auto-trigger evaluation (F-MOD-009-rework-01) ────────────────────────────
//
// Runs once per pick resolution, inside the same serialized command that
// resolved the pick, after that resolution's own transaction commits and
// before the per-draft queue admits the next command (state-machine-flows.md
// §16). Called from auction/engine.ts's awardAuction.

interface TriggerRule {
  // ponytail: simplest workable shape for "a probability/weight check"
  // (PRD §33) absent a stricter shared contract — a definition with no
  // parseable probability in [0,1] is treated as never-eligible rather than
  // defaulting to always-eligible, so a malformed rule fails safe (silent,
  // per EXTRACTED-046) instead of flooding every pick.
  probability?: number;
}

function isEligible(triggerRuleJson: Record<string, unknown> | string): boolean {
  // postgres.js does not consistently auto-parse a jsonb column written via
  // an explicit ::jsonb cast — it can come back as a JSON string rather than
  // an object (same quirk noted elsewhere in this codebase, e.g.
  // F-MOD-004_auto_agent.test.ts's rawPayload handling). Parse defensively.
  const parsed = typeof triggerRuleJson === 'string' ? (JSON.parse(triggerRuleJson) as TriggerRule) : (triggerRuleJson as TriggerRule);
  const p = parsed.probability;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return false;
  return Math.random() < p;
}

function weightedRandomPick<T extends { weight: number }>(items: T[]): T {
  const weights = items.map((i) => (Number.isFinite(i.weight) && i.weight > 0 ? i.weight : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

export async function evaluateWhammyAutoTrigger(
  sql: postgres.Sql,
  draftId: string,
  leagueId: string,
  awardedTeamId: string,
  triggerEventSequence: number,
): Promise<void> {
  const config = await loadWhammyConfig(sql, leagueId);
  if (!config || !config.enabled) return;

  const definitions = await sql<WhammyDefinitionRow[]>`
    SELECT id, name, type, budget_delta_minor, trigger_rule_json, display_message, offline_action_text, weight, active
    FROM whammy_definitions WHERE league_id = ${leagueId} AND active = true
  `;
  if (definitions.length === 0) return;

  const eligible = definitions.filter((d) => isEligible(d.trigger_rule_json));
  if (eligible.length === 0) return;

  const selected = weightedRandomPick(eligible);
  const budgetDelta = selected.budget_delta_minor ?? 0;
  const teamId = budgetDelta !== 0 ? awardedTeamId : null;
  const description = selected.display_message;

  if (budgetDelta > 0 && !config.allow_positive) return;
  if (budgetDelta < 0 && !config.allow_negative) return;

  if (teamId && config.max_per_team !== null) {
    const [{ count }] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM whammy_events
      WHERE draft_id = ${draftId} AND team_id = ${teamId} AND status = 'APPLIED'
    `;
    if (count >= config.max_per_team) return;
  }
  if (config.max_per_draft !== null) {
    const [{ count }] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM whammy_events WHERE draft_id = ${draftId} AND status = 'APPLIED'
    `;
    if (count >= config.max_per_draft) return;
  }
  if (budgetDelta < 0 && teamId) {
    const feasible = await checkRosterCompletionFeasible(sql, draftId, teamId, budgetDelta);
    if (!feasible) return;
  }

  if (config.commissioner_approval_required) {
    await sql`
      INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status, definition_id, trigger_event_sequence)
      VALUES (${draftId}, ${teamId}, ${budgetDelta}, ${description}, 'PENDING_APPROVAL', ${selected.id}, ${triggerEventSequence})
    `;
    return;
  }

  if (teamId) {
    const result = await applyWhammy(sql, draftId, teamId, budgetDelta, description, null, selected.id, triggerEventSequence);
    broadcast(draftId, {
      type: 'WHAMMY_APPLIED',
      payload: { team_id: teamId, amount_minor: budgetDelta, description, new_remaining_budget_minor: result.newRemainingBudgetMinor },
    });
  } else {
    // Message-only definition (no budget delta): no ledger entry, no budget
    // mutation — record the event and broadcast for display purposes only.
    await sql`
      INSERT INTO whammy_events (draft_id, team_id, amount_minor, description, status, definition_id, trigger_event_sequence)
      VALUES (${draftId}, NULL, 0, ${description}, 'APPLIED', ${selected.id}, ${triggerEventSequence})
    `;
    broadcast(draftId, {
      type: 'WHAMMY_APPLIED',
      payload: { team_id: null, amount_minor: 0, description, new_remaining_budget_minor: null },
    });
  }
}
