/**
 * F-MOD-000: Crash recovery — RUNNING drafts become PAUSED on server start
 *
 * Behavioral expectation: given one or more Draft rows have status=RUNNING
 * in Postgres at server start, when the server process starts (after env check,
 * before accepting connections), each such draft is updated to status=PAUSED
 * and a DRAFT_PAUSED DraftEvent is appended in the same transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] =
  process.env['JWT_SECRET'] ??
  'test-secret-for-vitest-at-least-32-chars-long!!';

describe('F-MOD-000 crash recovery', () => {
  let sql: ReturnType<typeof postgres>;
  let leagueId: string;
  let datasetId: string;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await sql.end();
  });

  it('test_F_MOD_000_running_drafts_paused_on_startup', async () => {
    // Create a test league and dataset first
    const siteHash =
      '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // fake hash
    const [league] = await sql<[{ id: string }]>`
      INSERT INTO leagues (name, site_password_hash, commissioner_password_hash, auth_epoch)
      VALUES ('Crash Recovery Test League', ${siteHash}, ${siteHash}, 0)
      RETURNING id
    `;
    leagueId = league.id;

    const [dataset] = await sql<[{ id: string }]>`
      INSERT INTO draft_datasets (league_id, status)
      VALUES (${leagueId}, 'FROZEN')
      RETURNING id
    `;
    datasetId = dataset.id;

    // Insert a RUNNING draft
    const [draft] = await sql<[{ id: string }]>`
      INSERT INTO drafts (league_id, dataset_id, status)
      VALUES (${leagueId}, ${datasetId}, 'RUNNING')
      RETURNING id
    `;
    const runningDraftId = draft.id;

    // Run crash recovery
    const { recoverRunningDrafts } = await import('../main.js');
    await recoverRunningDrafts();

    // Verify draft is now PAUSED
    const [updated] = await sql<[{ status: string }]>`
      SELECT status FROM drafts WHERE id = ${runningDraftId}
    `;
    expect(updated.status).toBe('PAUSED');

    // Verify a DRAFT_PAUSED event was appended
    const events = await sql<[{ event_type: string }]>`
      SELECT event_type FROM draft_events
      WHERE draft_id = ${runningDraftId} AND event_type = 'DRAFT_PAUSED'
    `;
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    await sql`DELETE FROM draft_events WHERE draft_id = ${runningDraftId}`;
    await sql`DELETE FROM drafts WHERE id = ${runningDraftId}`;
    await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
  });

  it('test_F_MOD_000_non_running_drafts_not_affected', async () => {
    const siteHash =
      '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const [league] = await sql<[{ id: string }]>`
      INSERT INTO leagues (name, site_password_hash, commissioner_password_hash, auth_epoch)
      VALUES ('Crash Recovery Test League 2', ${siteHash}, ${siteHash}, 0)
      RETURNING id
    `;

    const [dataset] = await sql<[{ id: string }]>`
      INSERT INTO draft_datasets (league_id, status)
      VALUES (${league.id}, 'FROZEN')
      RETURNING id
    `;

    // Insert a PAUSED draft (should NOT be changed)
    const [pausedDraft] = await sql<[{ id: string }]>`
      INSERT INTO drafts (league_id, dataset_id, status)
      VALUES (${league.id}, ${dataset.id}, 'PAUSED')
      RETURNING id
    `;

    const { recoverRunningDrafts } = await import('../main.js');
    await recoverRunningDrafts();

    const [check] = await sql<[{ status: string }]>`
      SELECT status FROM drafts WHERE id = ${pausedDraft.id}
    `;
    expect(check.status).toBe('PAUSED'); // Still PAUSED, not changed

    // Cleanup
    await sql`DELETE FROM drafts WHERE id = ${pausedDraft.id}`;
    await sql`DELETE FROM draft_datasets WHERE id = ${dataset.id}`;
    await sql`DELETE FROM leagues WHERE id = ${league.id}`;
  });
});
