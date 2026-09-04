/**
 * F-MOD-017: Auction Close Card and Player Detail Popover — API layer.
 *
 * Only the server-side change this feature requires is covered here: the
 * `PLAYER_AWARDED` broadcast/event payload gaining `accepted_bid_count`,
 * `unique_bidder_count`, `aav_minor`, and `remaining_budget_minor`, computed
 * server-side rather than derived from the client's capped 10-entry bid
 * ladder (PRD.md §29). The popover itself reads existing endpoints
 * (`GET /leagues/:id/players`, `GET /drafts/:id/teams/:teamId/target-values`)
 * that MOD-002/MOD-008/MOD-016 already cover — not re-tested here.
 *
 * Tests run against a real database and real HTTP/WebSocket server. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import postgres from 'postgres';
import { stopAwardTimer } from '../auction/engine.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';

const SKIP_DB = !process.env['DATABASE_URL'];

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

function waitForMessage(
  ws: WebSocket,
  predicate?: (msg: { type: string; payload?: Record<string, unknown> }) => boolean,
  timeoutMs = 5000,
): Promise<{ type: string; payload?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as { type: string; payload?: Record<string, unknown> };
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe.skipIf(SKIP_DB)('F-MOD-017 close card payload', () => {
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

  async function setupDraft(): Promise<void> {
    const tag = Date.now();
    const leagueRes = await server.inject({
      method: 'POST',
      url: '/leagues',
      payload: { name: `F017-Test-${tag}`, site_password: 's', commissioner_password: 'c' },
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
      INSERT INTO players (name, position, nfl_team) VALUES (${`F017-P1-${tag}`}, 'QB', 'BUF') RETURNING id
    `;
    playerIds = [p1!.id];

    await sql`
      INSERT INTO player_aav_sources (dataset_id, player_id, aav_minor, tier, source)
      VALUES (${datasetId}, ${p1!.id}, 5000, 1, 'CSV')
    `;
    player1EntryId = p1!.id;

    await sql`UPDATE draft_datasets SET status = 'FROZEN', frozen_at = NOW() WHERE id = ${datasetId}`;

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
  }

  afterEach(async () => {
    if (!draftId) return;
    if (draftId) stopAwardTimer(draftId);
    await sql`UPDATE drafts SET status = 'PAUSED' WHERE id = ${draftId} AND status = 'RUNNING'`;
    await sql`DELETE FROM roster_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM budget_ledger_entries WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM acquisitions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM bid_attempts WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_events WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM draft_team_states WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM player_auctions WHERE draft_id = ${draftId}`;
    await sql`DELETE FROM drafts WHERE id = ${draftId}`;
    if (playerIds.length > 0) {
      await sql`DELETE FROM player_aav_sources WHERE player_id = ANY(${playerIds})`;
    }
    await sql`DELETE FROM draft_datasets WHERE id = ${datasetId}`;
    if (playerIds.length > 0) {
      await sql`DELETE FROM players WHERE id = ANY(${playerIds})`;
    }
    await sql`DELETE FROM roster_slot_definitions WHERE config_id IN (
      SELECT id FROM roster_configurations WHERE league_id = ${leagueId}
    )`;
    await sql`DELETE FROM roster_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM auction_configurations WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM teams WHERE league_id = ${leagueId}`;
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    draftId = '';
    playerIds = [];
  });

  async function nominate(ws: WebSocket, playerEntryId: string, openingBid = 100): Promise<string> {
    const [nom] = await Promise.all([
      waitForMessage(ws, (m) => m.type === 'NOMINATION_STARTED'),
      Promise.resolve().then(() =>
        ws.send(JSON.stringify({
          type: 'NOMINATE_COMMAND',
          payload: { player_dataset_entry_id: playerEntryId, opening_bid_minor: openingBid },
        })),
      ),
    ]);
    return String(nom.payload?.['player_auction_id'] ?? '');
  }

  async function bidAbsolute(sender: WebSocket, listener: WebSocket, auctionId: string, amountMinor: number): Promise<void> {
    await Promise.all([
      waitForMessage(listener, (m) => m.type === 'BID_ACCEPTED' && Number(m.payload?.['bid_amount_minor']) === amountMinor),
      Promise.resolve().then(() =>
        sender.send(JSON.stringify({
          type: 'BID_COMMAND',
          payload: { player_auction_id: auctionId, bid_amount_minor: amountMinor, bid_type: 'ABSOLUTE' },
        })),
      ),
    ]);
  }

  it('test_F_MOD_017_player_awarded_payload_includes_close_card_fields_on_direct_award', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const auctionId = await nominate(ws1, player1EntryId, 100);

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    const award = await waitForMessage(ws1, (m) => m.type === 'PLAYER_AWARDED');

    expect(award.payload?.['winning_team_id']).toBe(team1Id);
    expect(award.payload?.['price_minor']).toBe(100);
    expect(award.payload?.['accepted_bid_count']).toBe(0); // opening bid is not a bid_attempts row
    expect(award.payload?.['unique_bidder_count']).toBe(0);
    expect(award.payload?.['aav_minor']).toBe(5000);
    expect(award.payload?.['remaining_budget_minor']).toBe(19900); // 20000 - 100

    // Drain the post-award NOMINATION_TURN_CHANGED so cleanup doesn't race it.
    await waitForMessage(ws1, (m) => m.type === 'NOMINATION_TURN_CHANGED');

    ws1.close();
    ws2.close();
  }, 15000);

  it('test_F_MOD_017_player_awarded_bid_counts_reflect_more_than_10_bids_not_client_ladder', async () => {
    await setupDraft();
    const ws1 = await connectAndAuth(serverPort, draftId, team1Token);
    const ws2 = await connectAndAuth(serverPort, draftId, team2Token);

    const auctionId = await nominate(ws1, player1EntryId, 100);

    // 11 accepted competing bids (> the client's 10-entry bidLadder cap),
    // alternating bidders so unique_bidder_count (2) must differ from
    // accepted_bid_count (11) — proves both are independently correct.
    const amounts = [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];
    for (let i = 0; i < amounts.length; i++) {
      const sender = i % 2 === 0 ? ws2 : ws1;
      await bidAbsolute(sender, ws1, auctionId, amounts[i]!);
    }

    await sql`UPDATE player_auctions SET rebid_deadline = NOW() - INTERVAL '1 second' WHERE id = ${auctionId}`;

    const award = await waitForMessage(ws1, (m) => m.type === 'PLAYER_AWARDED');

    expect(award.payload?.['accepted_bid_count']).toBe(11);
    expect(award.payload?.['unique_bidder_count']).toBe(2);
    expect(award.payload?.['winning_team_id']).toBe(team2Id); // last bidder (index 10, even) was ws2/team2
    expect(award.payload?.['price_minor']).toBe(1200);
    expect(award.payload?.['aav_minor']).toBe(5000);
    expect(award.payload?.['remaining_budget_minor']).toBe(20000 - 1200);

    await waitForMessage(ws1, (m) => m.type === 'NOMINATION_TURN_CHANGED');

    ws1.close();
    ws2.close();
  }, 15000);
});
