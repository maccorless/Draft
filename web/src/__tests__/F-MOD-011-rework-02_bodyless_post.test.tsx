/**
 * F-MOD-011-rework-02 (UF-17-03): `authedJson()` in
 * `web/src/screens/commissioner/DraftControl.tsx` must only attach
 * `content-type: application/json` when an actual JSON body is being sent.
 * Sending that header on a bodyless POST makes Fastify's default JSON body
 * parser reject the request (`FST_ERR_CTP_EMPTY_JSON_BODY`, HTTP 400) — this
 * was reproduced live for Start Now (and applies identically to Pause and
 * Resume, which share the same helper).
 *
 * Unlike this module's other `.tsx` tests (which mock `global.fetch` per
 * feedback_ui_test_mocking.md — pure UI-behavior tests don't need a live
 * server), the feedback explicitly calls out that a mocked fetch is exactly
 * what let this bug slip through: a canned mock response doesn't reproduce
 * Fastify's real body-parsing behavior. So this file deliberately does NOT
 * mock `global.fetch` — it starts the real Fastify + Postgres server (same
 * `buildServer()` used by `server/src/__tests__/F-MOD-011_draft_control.test.ts`)
 * and calls `authedJson()` against it with an absolute URL, over the real
 * network stack.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';

import { authedJson } from '../screens/commissioner/DraftControl.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

describe.skipIf(SKIP_DB)('F-MOD-011-rework-02 bodyless POST via authedJson against a real server', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let baseUrl = '';

  let leagueId = '';
  let datasetId = '';
  let draftId = '';
  let commToken = '';

  function makeToken(payload: object): string {
    return server.jwt.sign(payload);
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../../../server/src/main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 15000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  async function setupCreatedDraft(): Promise<void> {
    const tag = Date.now();
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F011R2-${tag}`, site_password: 's', commissioner_password: 'c' },
    });
    leagueId = leagueRes.json<{ id: string }>().id;
    commToken = makeToken({ league_id: leagueId, role: 'COMMISSIONER', auth_epoch: 1 });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/roster`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        bench_slots: 0,
        slots: [
          { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
          { position: 'BN', priority: 99, is_starter: false, slot_count: 6 },
        ],
      },
    });

    await server.inject({
      method: 'PUT',
      url: `/leagues/${leagueId}/config/auction`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: {
        initial_budget_minor: 20000,
        nomination_timer_ms: 60000,
        second_bid_timer_ms: 60000,
        rebid_timer_ms: 60000,
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
    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

    const draftRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/drafts`,
      headers: { authorization: `Bearer ${commToken}` },
      payload: { dataset_id: datasetId },
    });
    draftId = draftRes.json<{ id: string }>().id;
  }

  afterEach(async () => {
    if (!draftId) return;
    await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
      SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
    )`;
    await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    draftId = '';
  });

  it('test_F_MOD_011_rework_02_start_now_bodyless_post_succeeds_against_real_server', async () => {
    await setupCreatedDraft();

    // No `body` passed — exactly how DraftControl's startDraft() calls it.
    // Pre-fix, this would 400 with FST_ERR_CTP_EMPTY_JSON_BODY.
    await authedJson(`${baseUrl}/drafts/${draftId}/start`, commToken, { method: 'POST' });

    const [row] = await sql<[{ status: string }]>`SELECT status FROM drafts WHERE id = ${draftId}`;
    expect(row!.status).toBe('RUNNING');
  }, 10000);

  it('test_F_MOD_011_rework_02_pause_and_resume_bodyless_post_succeed_against_real_server', async () => {
    await setupCreatedDraft();
    await authedJson(`${baseUrl}/drafts/${draftId}/start`, commToken, { method: 'POST' });

    await authedJson(`${baseUrl}/drafts/${draftId}/pause`, commToken, { method: 'POST' });
    const [paused] = await sql<[{ status: string }]>`SELECT status FROM drafts WHERE id = ${draftId}`;
    expect(paused!.status).toBe('PAUSED');

    await authedJson(`${baseUrl}/drafts/${draftId}/resume`, commToken, { method: 'POST' });
    const [resumed] = await sql<[{ status: string }]>`SELECT status FROM drafts WHERE id = ${draftId}`;
    expect(resumed!.status).toBe('RUNNING');
  }, 10000);

  it('test_F_MOD_011_rework_02_authed_json_still_sends_content_type_when_body_present', async () => {
    await setupCreatedDraft();
    await authedJson(`${baseUrl}/drafts/${draftId}/start`, commToken, { method: 'POST' });

    // Sanity check the opposite branch: an endpoint that DOES require a JSON
    // body (timer extend, with no open auction to extend) must reach the
    // route's own business-logic rejection (409 CONFLICT), not a Fastify
    // body-parse failure (400) — proving content-type WAS sent and the body
    // WAS parsed as JSON when `init.body` is present. This is the fix's
    // "still works when a body IS given" counterpart to the bodyless tests.
    let thrownStatus: string | null = null;
    try {
      await authedJson(`${baseUrl}/drafts/${draftId}/timers/extend`, commToken, {
        method: 'POST',
        body: JSON.stringify({ seconds: 30 }),
      });
    } catch (err) {
      thrownStatus = (err as Error).message;
    }
    expect(thrownStatus).toBe('409');
  }, 10000);
});
