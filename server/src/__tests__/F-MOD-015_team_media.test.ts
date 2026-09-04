/**
 * F-MOD-015: Team presentation media (icon + nomination MP3)
 *
 * Tests run against a real database and real HTTP/WebSocket server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';
import { stopAwardTimer } from '../auction/engine.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

interface MultipartFilePart {
  fieldName: string;
  content: Buffer | string;
  filename: string;
  mime: string;
}

function multipartBody(parts: MultipartFilePart[]): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary015';
  const segments: Buffer[] = [];
  for (const part of parts) {
    segments.push(
      Buffer.from(
        [
          `--${boundary}`,
          `Content-Disposition: form-data; name="${part.fieldName}"; filename="${part.filename}"`,
          `Content-Type: ${part.mime}`,
          '',
          '',
        ].join('\r\n'),
      ),
    );
    segments.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    segments.push(Buffer.from('\r\n'));
  }
  segments.push(Buffer.from(`--${boundary}--`));
  return { body: Buffer.concat(segments), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function connectAndAuth(port: number, draftId: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/drafts/${draftId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token } }));
    });
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'STATE_SNAPSHOT') resolve();
      else reject(new Error(`Expected STATE_SNAPSHOT, got ${msg.type}`));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connectAndAuth timed out')), 5000);
  });
  return ws;
}

function waitForMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  return new Promise((resolve, reject) => {
    const received: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const timer = setTimeout(() => reject(new Error('waitForMessages timed out')), timeoutMs);
    const onMessage = (data: Buffer | string) => {
      received.push(JSON.parse(data.toString()));
      if (received.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(received);
      }
    };
    ws.on('message', onMessage);
  });
}

describe.skipIf(SKIP_DB)('F-MOD-015 team presentation media', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let serverPort: number;

  let leagueId = '';
  let team1Id = '';
  let team2Id = '';
  let datasetId = '';
  let draftId = '';
  let commToken = '';
  let team1Token = '';
  let team2Token = '';
  let playerIds: string[] = [];
  let player1EntryId = '';

  function makeToken(payload: object): string {
    return server.jwt.sign(payload);
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const { buildServer } = await import('../main.js');
    server = await buildServer();
    await server.listen({ port: 0 });
    const addr = server.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
  }, 15000);

  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  async function setupLeagueAndTeams(): Promise<void> {
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F015 Test ${Date.now()}`, site_password: 's', commissioner_password: 'c' },
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
      payload: { name: 'Beta', team_password: 'beta', draft_order: 2 },
    });
    team2Id = t2.json<{ id: string }>().id;

    const [e1] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team1Id}`;
    const [e2] = await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${team2Id}`;
    team1Token = makeToken({ league_id: leagueId, team_id: team1Id, role: 'OWNER', auth_epoch: e1!.auth_epoch });
    team2Token = makeToken({ league_id: leagueId, team_id: team2Id, role: 'OWNER', auth_epoch: e2!.auth_epoch });
  }

  async function setupFullDraft(): Promise<void> {
    await setupLeagueAndTeams();

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

    const [p1] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F015-Josh-Allen', 'QB', 'BUF') RETURNING id
    `;
    const [p2] = await sql<[{ id: string }]>`
      INSERT INTO players (name, position, nfl_team) VALUES ('F015-Justin-Herbert', 'QB', 'LAC') RETURNING id
    `;
    playerIds = [p1!.id, p2!.id];
    await sql`INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source) VALUES (${datasetId}, ${p1!.id}, 5000, 'CSV')`;
    await sql`INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, source) VALUES (${datasetId}, ${p2!.id}, 4500, 'CSV')`;
    player1EntryId = p1!.id;

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
    if (!leagueId) return;
    if (draftId) stopAwardTimer(draftId);
    if (draftId) {
      await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId} AND status = 'RUNNING'`;
      await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
      await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    }
    if (playerIds.length > 0) {
      await sql`DELETE FROM player_aav_sources WHERE player_id = ANY(${playerIds})`;
      await sql`DELETE FROM players WHERE id = ANY(${playerIds})`;
    }
    if (datasetId) await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
      SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
    )`;
    await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    leagueId = '';
    team1Id = '';
    team2Id = '';
    datasetId = '';
    draftId = '';
    playerIds = [];
  });

  // ── Upload ────────────────────────────────────────────────────────────────

  it('test_F_MOD_015_owner_uploads_icon_sets_icon_url_and_reflects_in_team_reads', async () => {
    await setupLeagueAndTeams();
    const { body, contentType } = multipartBody([
      { fieldName: 'icon', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), filename: 'icon.png', mime: 'image/png' },
    ]);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': contentType },
      body,
    });
    expect(res.statusCode).toBe(200);
    const uploaded = res.json<{ team_id: string; icon_url: string | null }>();
    expect(uploaded.icon_url).toMatch(/^\/media\/team-media\//);

    const teamsRes = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const teams = teamsRes.json<{ teams: Array<{ id: string; icon_url: string | null }> }>().teams;
    expect(teams.find((t) => t.id === team1Id)?.icon_url).toBe(uploaded.icon_url);
  });

  it('test_F_MOD_015_owner_uploads_mp3_sets_nomination_audio_url_stored_as_is', async () => {
    await setupLeagueAndTeams();
    const longMp3 = Buffer.alloc(2048, 0xff); // stand-in "longer than 5s" source file
    const { body, contentType } = multipartBody([
      { fieldName: 'nomination_audio', content: longMp3, filename: 'fight-song.mp3', mime: 'audio/mpeg' },
    ]);

    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': contentType },
      body,
    });
    expect(res.statusCode).toBe(200);
    const uploaded = res.json<{ nomination_audio_url: string | null }>();
    expect(uploaded.nomination_audio_url).toMatch(/^\/media\/team-media\/.*\.mp3$/);

    // Stored as-is (not trimmed) — the static route returns exactly what was uploaded.
    const filename = uploaded.nomination_audio_url!.split('/').pop();
    const fileRes = await server.inject({ method: 'GET', url: `/media/team-media/${filename}` });
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.rawPayload.length).toBe(longMp3.length);
  });

  it('test_F_MOD_015_non_owner_non_commissioner_upload_is_rejected_and_column_unchanged', async () => {
    await setupLeagueAndTeams();
    const { body, contentType } = multipartBody([
      { fieldName: 'icon', content: 'x', filename: 'icon.png', mime: 'image/png' },
    ]);

    // team2Token is a different team's owner — not team1's owner, not commissioner
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team2Token}`, 'content-type': contentType },
      body,
    });
    expect([401, 403]).toContain(res.statusCode);

    const [row] = await sql<[{ icon_url: string | null }]>`SELECT icon_url FROM teams WHERE id = ${team1Id}`;
    expect(row!.icon_url).toBeNull();
  });

  it('test_F_MOD_015_reupload_of_same_media_type_replaces_existing_url', async () => {
    await setupLeagueAndTeams();
    const first = multipartBody([{ fieldName: 'icon', content: 'a', filename: 'a.png', mime: 'image/png' }]);
    const firstRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': first.contentType },
      body: first.body,
    });
    const firstUrl = firstRes.json<{ icon_url: string }>().icon_url;

    const second = multipartBody([{ fieldName: 'icon', content: 'b', filename: 'b.png', mime: 'image/png' }]);
    const secondRes = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': second.contentType },
      body: second.body,
    });
    const secondUrl = secondRes.json<{ icon_url: string }>().icon_url;

    expect(secondUrl).not.toBe(firstUrl);
    const [row] = await sql<[{ icon_url: string }]>`SELECT icon_url FROM teams WHERE id = ${team1Id}`;
    expect(row!.icon_url).toBe(secondUrl);
  });

  it('test_F_MOD_015_commissioner_can_upload_media_for_any_team', async () => {
    await setupLeagueAndTeams();
    const { body, contentType } = multipartBody([{ fieldName: 'icon', content: 'x', filename: 'x.png', mime: 'image/png' }]);
    const res = await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${commToken}`, 'content-type': contentType },
      body,
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  it('test_F_MOD_015_delete_clears_specified_media_and_reflects_in_team_reads', async () => {
    await setupLeagueAndTeams();
    const upload = multipartBody([
      { fieldName: 'icon', content: 'a', filename: 'a.png', mime: 'image/png' },
      { fieldName: 'nomination_audio', content: 'b', filename: 'b.mp3', mime: 'audio/mpeg' },
    ]);
    await server.inject({
      method: 'POST',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': upload.contentType },
      body: upload.body,
    });

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/leagues/${leagueId}/teams/${team1Id}/media`,
      headers: { authorization: `Bearer ${team1Token}`, 'content-type': 'application/json' },
      payload: { media: ['icon'] },
    });
    expect(delRes.statusCode).toBe(200);
    const deleted = delRes.json<{ icon_url: string | null; nomination_audio_url: string | null }>();
    expect(deleted.icon_url).toBeNull();
    expect(deleted.nomination_audio_url).not.toBeNull();

    const teamsRes = await server.inject({
      method: 'GET',
      url: `/leagues/${leagueId}/teams`,
      headers: { authorization: `Bearer ${commToken}` },
    });
    const teams = teamsRes.json<{ teams: Array<{ id: string; icon_url: string | null; nomination_audio_url: string | null }> }>().teams;
    const team1 = teams.find((t) => t.id === team1Id);
    expect(team1?.icon_url).toBeNull();
    expect(team1?.nomination_audio_url).not.toBeNull();
  });

  // ── Nomination audio broadcast ───────────────────────────────────────────────

  it('test_F_MOD_015_first_nomination_with_audio_set_broadcasts_TEAM_NOMINATION_AUDIO_and_marks_played', async () => {
    await setupFullDraft();
    await sql`UPDATE teams SET nomination_audio_url = '/media/team-media/team1-audio.mp3' WHERE id = ${team1Id}`;
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const [messages] = await Promise.all([
      waitForMessages(ws1, 2, 4000),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 500 },
        })),
      ),
    ]);

    const nominationStarted = messages.find((m) => m.type === 'NOMINATION_STARTED');
    const audioMsg = messages.find((m) => m.type === 'TEAM_NOMINATION_AUDIO');
    expect(nominationStarted).toBeDefined();
    expect(audioMsg).toBeDefined();
    expect(audioMsg!.payload?.['team_id']).toBe(team1Id);
    expect(audioMsg!.payload?.['audio_url']).toBe('/media/team-media/team1-audio.mp3');
    expect(audioMsg!.payload?.['duration_cap_ms']).toBe(5000);

    const [row] = await sql<[{ nomination_audio_played: boolean }]>`
      SELECT nomination_audio_played FROM draft_team_states WHERE draft_id = ${draftId} AND team_id = ${team1Id}
    `;
    expect(row!.nomination_audio_played).toBe(true);
    ws1.close();
  });

  it('test_F_MOD_015_second_nomination_by_same_team_does_not_replay_audio', async () => {
    await setupFullDraft();
    await sql`UPDATE teams SET nomination_audio_url = '/media/team-media/team1-audio.mp3' WHERE id = ${team1Id}`;
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });
    await sql`UPDATE draft_team_states SET nomination_audio_played = true WHERE draft_id = ${draftId} AND team_id = ${team1Id}`;

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const [messages] = await Promise.all([
      waitForMessages(ws1, 1, 4000).then(async (msgs) => {
        // Give a second event a chance to arrive if the (buggy) code were to send one.
        await new Promise((r) => setTimeout(r, 250));
        return msgs;
      }),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 500 },
        })),
      ),
    ]);

    expect(messages.some((m) => m.type === 'TEAM_NOMINATION_AUDIO')).toBe(false);
    ws1.close();
  });

  it('test_F_MOD_015_nomination_with_no_audio_url_never_broadcasts_audio', async () => {
    await setupFullDraft();
    await server.inject({ method: 'POST', url: `/drafts/${draftId}/start`, headers: { authorization: `Bearer ${commToken}` } });

    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const messages = await Promise.all([
      waitForMessages(ws1, 1, 4000).then(async (msgs) => {
        await new Promise((r) => setTimeout(r, 250));
        return msgs;
      }),
      Promise.resolve().then(() =>
        ws1.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: player1EntryId, opening_bid_minor: 500 },
        })),
      ),
    ]).then(([msgs]) => msgs);

    expect(messages.some((m) => m.type === 'TEAM_NOMINATION_AUDIO')).toBe(false);
    ws1.close();
  });
});
