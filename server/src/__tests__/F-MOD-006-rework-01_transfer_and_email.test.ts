/**
 * F-MOD-006-rework-01: ESPN transfer workflow + real SendGrid email delivery.
 *
 * Tests run against a real Postgres database and a real Fastify HTTP server.
 * SendGrid itself is an external paid service with no test sandbox reachable
 * from CI — this test stands up a real local HTTP server that speaks the
 * same "POST /v3/mail/send" contract and points SENDGRID_API_URL at it
 * (mirrors the FANTASYPROS_API_URL override pattern in
 * player/adapters/fantasypros.ts). This is a real HTTP round trip, not a
 * mocked function — only the DNS endpoint differs from production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
process.env['SENDGRID_API_KEY'] =
  process.env['SENDGRID_API_KEY'] ?? 'test-sendgrid-key-placeholder';
process.env['SENDGRID_FROM_EMAIL'] =
  process.env['SENDGRID_FROM_EMAIL'] ?? 'test-sender@example.com';

const DATABASE_URL = process.env['DATABASE_URL'];
const SKIP_DB = !DATABASE_URL;

describe.skipIf(SKIP_DB)('F-MOD-006-rework-01 ESPN transfer + SendGrid delivery', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let fakeSendGrid: http.Server;
  let receivedSends: Array<{ to: string }> = [];

  let leagueId: string;
  let team1Id: string;
  let team2Id: string;
  let draftId: string;
  let commToken: string;
  let team1Token: string;
  let datasetId: string;
  let player1Id: string;
  let player2Id: string;

  function makeToken(payload: object): string {
    return server.jwt.sign(payload);
  }

  beforeAll(async () => {
    // Stand up the fake SendGrid endpoint FIRST so SENDGRID_API_URL is set
    // before main.ts (and its route handlers) load.
    fakeSendGrid = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { personalizations: Array<{ to: Array<{ email: string }> }> };
        const to = parsed.personalizations[0]?.to[0]?.email ?? '';
        receivedSends.push({ to });
        if (to.includes('fail')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ message: 'simulated SendGrid failure' }] }));
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => fakeSendGrid.listen(0, resolve));
    const addr = fakeSendGrid.address() as AddressInfo;
    process.env['SENDGRID_API_URL'] = `http://127.0.0.1:${addr.port}/mail/send`;

    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
  }, 20000);

  afterAll(async () => {
    await server.close();
    await sql.end();
    await new Promise<void>((resolve) => fakeSendGrid.close(() => resolve()));
    // Vitest runs test files sequentially in one worker (fileParallelism: false)
    // — clear the override so later test files fall back to the real URL default.
    delete process.env['SENDGRID_API_URL'];
  });

  async function setupCompleteDraft(): Promise<void> {
    receivedSends = [];

    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: {
        name: `F006R1 Test ${Date.now()}`,
        site_password: 'site',
        commissioner_password: 'comm',
      },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    commToken = makeToken({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    const t1 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Alpha', team_password: 'alpha', draft_order: 1 },
    });
    team1Id = t1.json<{ id: string }>().id;

    const t2 = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { name: 'Beta Bears', team_password: 'beta', draft_order: 2 },
    });
    team2Id = t2.json<{ id: string }>().id;

    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { bench_slots: 0, slots: [{ position: 'QB', priority: 1, is_starter: true, slot_count: 1 }] },
    });
    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: 50000,
        nomination_timer_ms: 60000,
        second_bid_timer_ms: 5000,
        rebid_timer_ms: 5000,
        anti_snipe_threshold_ms: 500,
        anti_snipe_extension_ms: 500,
        min_bid_minor: 100,
      },
    });

    const dsRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/datasets`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    datasetId = dsRes.json<{ id: string }>().id;

    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F006R1-QB1', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F006R1-QB2', 'QB', 'KC') RETURNING id
    `;
    player1Id = p1!.id;
    player2Id = p2!.id;
    await sql`INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source) VALUES (${datasetId}, ${player1Id}, 3500, 'test')`;
    await sql`INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source) VALUES (${datasetId}, ${player2Id}, 2500, 'test')`;
    await sql`UPDATE draft_datasets SET status = 'FROZEN' WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;

    await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/start`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    const now = new Date();
    const pastDeadline = new Date(now.getTime() - 10000);
    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id, auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${player1Id}, 'OPEN', 2000, ${team1Id}, 1, ${pastDeadline}, NULL)
    `;
    await sql`
      INSERT INTO player_auctions
        (draft_id, dataset_player_id, status, current_bid_minor, current_leader_id, auction_version, rebid_deadline, resolution_sequence)
      VALUES (${draftId}, ${player2Id}, 'OPEN', 1500, ${team2Id}, 1, ${pastDeadline}, NULL)
    `;

    // Wait for the award cycle to pick up the OPEN auctions (timer runs every
    // 500ms) — 4s gives 8 award cycles to process both auctions safely
    // (matches F-MOD-006_reports.test.ts's createCompleteDraft).
    await new Promise((r) => setTimeout(r, 4000));
  }

  // ─── ESPN team mappings ───────────────────────────────────────────────────

  it('F_MOD_006_rework_01_mappings_empty_candidates_with_no_prior_mappings', async () => {
    await setupCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/espn-team-mappings`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ team_id: string; external_team_id: string | null; verified: boolean; candidates: string[] }>>();
    expect(body.length).toBe(2);
    for (const row of body) {
      expect(row.external_team_id).toBeNull();
      expect(row.verified).toBe(false);
      expect(row.candidates).toEqual([]);
    }
  }, 20000);

  it('F_MOD_006_rework_01_put_mapping_sets_verified_and_overrides_candidate', async () => {
    await setupCompleteDraft();

    const putRes = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/espn-team-mappings/${team1Id}`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { external_team_id: 'espn-101', external_team_name: 'Alpha Squad' },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json<{ verified: boolean; external_team_id: string }>();
    expect(putBody.verified).toBe(true);
    expect(putBody.external_team_id).toBe('espn-101');

    const getRes = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/espn-team-mappings`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const rows = getRes.json<Array<{ team_id: string; external_team_id: string | null; verified: boolean }>>();
    const team1Row = rows.find((r) => r.team_id === team1Id)!;
    expect(team1Row.external_team_id).toBe('espn-101');
    expect(team1Row.verified).toBe(true);
  }, 20000);

  it('F_MOD_006_rework_01_put_mapping_rejects_non_commissioner', async () => {
    await setupCompleteDraft();

    const res = await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/espn-team-mappings/${team1Id}`,
      headers: { authorization: `Bearer ${team1Token}` },
      payload: { external_team_id: 'espn-999', external_team_name: 'Should Not Save' },
    });
    expect(res.statusCode).toBe(403);

    const [row] = await sql<Array<{ external_team_id: string | null }>>`
      SELECT external_team_id FROM provider_team_mappings WHERE league_id = ${leagueId} AND team_id = ${team1Id}
    `;
    expect(row).toBeUndefined();
  }, 20000);

  // ─── Canonical export ─────────────────────────────────────────────────────

  it('F_MOD_006_rework_01_canonical_export_rejects_incomplete_draft', async () => {
    // Reuse setup but stop before completion: create a fresh CREATED draft.
    await setupCompleteDraft();
    // Spin up a second, still-CREATED draft in the same league/dataset for the negative case.
    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    const incompleteDraftId = draftRes.json<{ id: string }>().id;

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${incompleteDraftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(409);

    const [job] = await sql<Array<{ id: string }>>`
      SELECT id FROM export_jobs WHERE draft_id = ${incompleteDraftId}
    `;
    expect(job).toBeUndefined();
  }, 20000);

  it('F_MOD_006_rework_01_canonical_export_fails_on_roster_integrity_violation', async () => {
    await setupCompleteDraft();

    // Simulate a roster-integrity violation: deactivate one acquisition's
    // active RosterEntry so it has zero active roster entries.
    await sql`
      UPDATE roster_entries SET active = false
      WHERE acquisition_id = (
        SELECT id FROM acquisitions WHERE draft_id = ${draftId} AND team_id = ${team1Id} LIMIT 1
      )
    `;

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).not.toBe(200);
    const body = res.json<{ validation: { offending_acquisitions: Array<{ team_id: string }> } }>();
    expect(body.validation.offending_acquisitions.some((a) => a.team_id === team1Id)).toBe(true);

    const [job] = await sql<Array<{ status: string; validation_json: { offending_acquisitions: unknown[] } }>>`
      SELECT status, validation_json FROM export_jobs WHERE draft_id = ${draftId}
    `;
    expect(job!.status).toBe('FAILED');
    expect(job!.validation_json.offending_acquisitions.length).toBeGreaterThan(0);

    // No partial export — no reconciliation rows were seeded for this draft's job.
    const [failedJob] = await sql<Array<{ id: string }>>`
      SELECT id FROM export_jobs WHERE draft_id = ${draftId}
    `;
    const items = await sql<Array<{ id: string }>>`
      SELECT id FROM reconciliation_items WHERE export_job_id = ${failedJob!.id}
    `;
    expect(items.length).toBe(0);
  }, 20000);

  it('F_MOD_006_rework_01_canonical_export_seeds_job_and_reconciliation_items', async () => {
    await setupCompleteDraft();

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<
      Array<{ player_id: string; team_id: string; price_minor: number; resolution_sequence: number }>
    >();
    expect(body.length).toBe(2);
    const playerIds = body.map((r) => r.player_id).sort();
    expect(playerIds).toEqual([player1Id, player2Id].sort());

    const [job] = await sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM export_jobs WHERE draft_id = ${draftId}
    `;
    expect(job!.status).toBe('GENERATED');

    const items = await sql<Array<{ id: string }>>`
      SELECT id FROM reconciliation_items WHERE export_job_id = ${job!.id}
    `;
    expect(items.length).toBe(2);

    // Calling again does not duplicate reconciliation rows.
    await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const itemsAfter = await sql<Array<{ id: string }>>`
      SELECT id FROM reconciliation_items WHERE export_job_id = ${job!.id}
    `;
    expect(itemsAfter.length).toBe(2);
  }, 20000);

  it('F_MOD_006_rework_01_worksheet_and_canonical_export_share_one_seed', async () => {
    await setupCompleteDraft();

    // espn-worksheet runs first — should seed the job.
    const wsRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/espn-worksheet`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(wsRes.statusCode).toBe(200);

    const [jobAfterWorksheet] = await sql<Array<{ id: string }>>`
      SELECT id FROM export_jobs WHERE draft_id = ${draftId}
    `;
    expect(jobAfterWorksheet).toBeDefined();

    // canonical-export reuses it — no duplicate ExportJob row.
    await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const jobs = await sql<Array<{ id: string }>>`
      SELECT id FROM export_jobs WHERE draft_id = ${draftId}
    `;
    expect(jobs.length).toBe(1);
  }, 20000);

  // ─── Reconciliation ───────────────────────────────────────────────────────

  it('F_MOD_006_rework_01_reconciliation_lists_items_and_all_confirmed_flag', async () => {
    await setupCompleteDraft();
    await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/reconciliation`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; status: string }>; all_confirmed: boolean }>();
    expect(body.items.length).toBe(2);
    expect(body.all_confirmed).toBe(false);

    for (const item of body.items) {
      const confirmRes = await server.inject({
        method: 'POST',
        url: `/drafts/${draftId}/reconciliation/${item.id}/confirm`,
        headers: { authorization: `Bearer ${commToken}` },
      });
      expect(confirmRes.statusCode).toBe(200);
    }

    const res2 = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/reconciliation`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    const body2 = res2.json<{ items: Array<{ status: string }>; all_confirmed: boolean }>();
    expect(body2.all_confirmed).toBe(true);
    expect(body2.items.every((i) => i.status === 'CONFIRMED')).toBe(true);
  }, 20000);

  it('F_MOD_006_rework_01_confirm_rejects_non_commissioner', async () => {
    await setupCompleteDraft();
    await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/canonical-export`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const listRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/reconciliation`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const itemId = listRes.json<{ items: Array<{ id: string }> }>().items[0]!.id;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/reconciliation/${itemId}/confirm`,
      headers: { authorization: `Bearer ${team1Token}` },
    });
    expect(res.statusCode).toBe(403);

    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM reconciliation_items WHERE id = ${itemId}
    `;
    expect(row!.status).toBe('PENDING');
  }, 20000);

  // ─── Real SendGrid email delivery ────────────────────────────────────────

  it('F_MOD_006_rework_01_email_sends_to_teams_with_owner_email_and_commissioner', async () => {
    await setupCompleteDraft();

    await sql`UPDATE teams SET owner_email = 'owner1@example.com' WHERE id = ${team1Id}`;
    await sql`UPDATE leagues SET commissioner_email = 'commish@example.com' WHERE id = ${leagueId}`;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/report/email`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ accepted: boolean; recipients: number }>();
    expect(body.accepted).toBe(true);
    // team1 (owner_email set) + commissioner — team2 has no owner_email.
    expect(body.recipients).toBe(2);

    expect(receivedSends.map((s) => s.to).sort()).toEqual(
      ['commish@example.com', 'owner1@example.com'].sort(),
    );

    const rows = await sql<Array<{ team_id: string | null; recipient_email: string; status: string }>>`
      SELECT team_id, recipient_email, status FROM report_delivery_attempts WHERE draft_id = ${draftId}
      ORDER BY recipient_email
    `;
    // team1 (SENT), team2 (SKIPPED_EMAIL_DISABLED), commissioner (SENT) = 3 rows.
    expect(rows.length).toBe(3);
    const commissionerRow = rows.find((r) => r.recipient_email === 'commish@example.com')!;
    expect(commissionerRow.team_id).toBeNull();
    expect(commissionerRow.status).toBe('SENT');
    const owner1Row = rows.find((r) => r.recipient_email === 'owner1@example.com')!;
    expect(owner1Row.team_id).toBe(team1Id);
    expect(owner1Row.status).toBe('SENT');
  }, 20000);

  it('F_MOD_006_rework_01_email_failure_for_one_recipient_does_not_block_others', async () => {
    await setupCompleteDraft();

    // The fake SendGrid server returns 500 for any "to" address containing "fail".
    await sql`UPDATE teams SET owner_email = 'fail-owner@example.com' WHERE id = ${team1Id}`;
    await sql`UPDATE teams SET owner_email = 'owner2@example.com' WHERE id = ${team2Id}`;

    const res = await server.inject({
      method: 'POST',
      url: `/drafts/${draftId}/report/email`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ accepted: boolean; recipients: number }>();
    expect(body.accepted).toBe(true);
    expect(body.recipients).toBe(2);

    const rows = await sql<Array<{ recipient_email: string; status: string; error_detail: string | null }>>`
      SELECT recipient_email, status, error_detail FROM report_delivery_attempts WHERE draft_id = ${draftId}
      ORDER BY recipient_email
    `;
    const failedRow = rows.find((r) => r.recipient_email === 'fail-owner@example.com')!;
    expect(failedRow.status).toBe('FAILED');
    expect(failedRow.error_detail).toBeTruthy();
    const okRow = rows.find((r) => r.recipient_email === 'owner2@example.com')!;
    expect(okRow.status).toBe('SENT');

    // Report remains available regardless of email failure (EXTRACTED-038).
    const reportRes = await server.inject({
      method: 'GET',
      url: `/drafts/${draftId}/report`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    expect(reportRes.statusCode).toBe(200);
  }, 20000);

  it('F_MOD_006_rework_01_env_check_requires_sendgrid_from_email', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const envCheckPath = path.join(process.cwd(), 'server/src/config/env-check.cjs');
    const content = fs.readFileSync(envCheckPath, 'utf8');
    expect(content).toContain('SENDGRID_FROM_EMAIL');
    expect(content).toContain("REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV', 'SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL']");
  });
});
