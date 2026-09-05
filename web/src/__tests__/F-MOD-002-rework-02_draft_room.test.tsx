/**
 * F-MOD-002-rework-02: Draft Room UX fixes (UF-01-03).
 *
 * Follows the same mocking convention as F-MOD-017's DraftRoom tests — see
 * [[feedback-ui-test-mocking]]: `global.fetch` is mocked (no live server
 * needed for pure UI-behavior tests) and `global.WebSocket` is stubbed with a
 * minimal fake that lets a test push frames directly, since jsdom has no real
 * WS server to connect to (the true system boundary is the live draft-engine
 * WS server, already covered end-to-end by server/src/__tests__/
 * F-MOD-002_auction.test.ts).
 *
 * Covers UF-01-03 items 1 (client half: +$1 debounce), 3 (in-room Pause
 * action), 4 (Draft Room <-> War Room cross-navigation), and 5-6 (always-
 * visible starter/bench roster status).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { DraftRoom } from '../screens/draft-room/index.js';
import { WarRoom } from '../screens/war-room/index.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-owner';
const TEAM_ID = 't1';

const playersFixture = [
  { player_id: 'p1', dataset_entry_id: 'p1', name: 'Justin Jefferson', position: 'WR', nfl_team: 'MIN', aav_minor: 5000, tier: 1, projected_points: 300 },
  { player_id: 'p2', dataset_entry_id: 'p2', name: 'Ceedee Lamb', position: 'WR', nfl_team: 'DAL', aav_minor: 4800, tier: 1, projected_points: 290 },
];

const rosterGridFixture = [
  {
    team_id: 't1',
    team_name: 'Alpha',
    icon_url: null,
    remaining_budget_minor: 20000,
    max_legal_bid_minor: 20000,
    roster_filled_count: 1,
    control_mode: 'MANUAL',
    slots: [
      { position: 'QB', is_starter: true, filled: 1, total: 1, players: [{ name: 'Josh Allen', price_minor: 4200 }] },
      { position: 'RB', is_starter: true, filled: 0, total: 2, players: [] },
      { position: 'WR', is_starter: true, filled: 0, total: 2, players: [] },
      { position: 'BN', is_starter: false, filled: 0, total: 6, players: [] },
    ],
  },
  { team_id: 't2', team_name: 'Beta', icon_url: null, remaining_budget_minor: 20000, max_legal_bid_minor: 20000, roster_filled_count: 0, control_mode: 'MANUAL', slots: [] },
];

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetchMock(): void {
  fetchCalls.length = 0;
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    if (url.endsWith('/config')) {
      return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 100 } });
    }
    if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: rosterGridFixture });
    if (url.endsWith('/target-values')) return jsonResponse(200, { targets: [] });
    if (url.endsWith('/pause')) return jsonResponse(200, { draft_id: DRAFT_ID, status: 'PAUSED' });
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + url });
  }) as unknown as typeof fetch;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  // useAuctionSocket's `send` gates on `wsRef.current?.readyState === WebSocket.OPEN`
  // — with `global.WebSocket` stubbed to this class, that comparison resolves
  // against THESE statics, so they must mirror the real ready-state constants.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  push(msg: { type: string; payload?: Record<string, unknown> }): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

async function renderDraftRoom(role?: 'COMMISSIONER' | 'OWNER'): Promise<FakeWebSocket> {
  installFetchMock();
  render(
    <MemoryRouter initialEntries={[`/draft-room?draftId=${DRAFT_ID}`]}>
      <Routes>
        <Route
          path="/draft-room"
          element={<DraftRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} role={role} />}
        />
        <Route path="/commissioner" element={<p>Commissioner Console Marker</p>} />
        <Route path="/draft-complete" element={<p>Draft Complete Marker</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const ws = FakeWebSocket.instances[0]!;
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.();
  ws.push({
    type: 'STATE_SNAPSHOT',
    payload: {
      teams: rosterGridFixture.map((t) => ({ team_id: t.team_id, remaining_budget_minor: t.remaining_budget_minor, roster_filled_count: t.roster_filled_count, control_mode: 'MANUAL' })),
      current_auction: null,
      status: 'RUNNING',
      as_of_sequence: 1,
    },
  });
  await waitFor(() => expect(screen.getByTestId('connection-status')).toBeTruthy());
  return ws;
}

function nominateJustinJefferson(ws: FakeWebSocket): void {
  ws.push({
    type: 'NOMINATION_STARTED',
    payload: {
      player_auction_id: 'pa-1',
      opening_bid_minor: 100,
      nomination_deadline_ts: Date.now() + 60000,
      second_bid_deadline_ts: Date.now() + 60000,
      nominator_team_id: 't2',
      player_name: 'Justin Jefferson',
      position: 'WR',
      nfl_team: 'MIN',
      tier: 1,
      aav_minor: 5000,
      projected_points: 300,
    },
  });
}

describe('F-MOD-002-rework-02 plus-one debounce (UF-01-03 item 1)', () => {
  it('test_F_MOD_002_rework_02_plus_one_disables_immediately_on_click', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    const btn = screen.getByTestId('plus-one-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    // Only one BID_COMMAND sent despite a second rapid click while disabled.
    fireEvent.click(btn);
    const sentBidCommands = ws.sent.filter((s) => JSON.parse(s).type === 'BID_COMMAND');
    expect(sentBidCommands.length).toBe(1);
  });

  it('test_F_MOD_002_rework_02_plus_one_reenables_after_BID_ACCEPTED_applied', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    const btn = screen.getByTestId('plus-one-button') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);

    // Models the race called out in UF-01-03: another team's bid gets applied
    // while ours is in flight (leading_team_id stays 't2', a different team —
    // not the viewer — so the button's disabled state below can only be
    // explained by the debounce flag, not by "you're now leading").
    ws.push({
      type: 'BID_ACCEPTED',
      payload: {
        player_auction_id: 'pa-1',
        bid_amount_minor: 300,
        leading_team_id: 't2',
        auction_version: 2,
        rebid_deadline_ts: Date.now() + 60000,
        anti_snipe_extended: false,
      },
    });

    await waitFor(() => expect((screen.getByTestId('plus-one-button') as HTMLButtonElement).disabled).toBe(false));
  });

  it('test_F_MOD_002_rework_02_plus_one_reenables_after_BID_REJECTED_and_shows_dollar_formatted_reason', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    const btn = screen.getByTestId('plus-one-button') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);

    // Server now formats reason strings as dollars (F-MOD-002-rework-02
    // server-side fix) — the client renders it as-is, verbatim.
    ws.push({
      type: 'BID_REJECTED',
      payload: { player_auction_id: 'pa-1', code: 'BID_TOO_LOW', reason: 'Bid $2 must exceed current $2' },
    });

    await waitFor(() => expect((screen.getByTestId('plus-one-button') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('bid-error').textContent).toContain('$2');
    expect(screen.getByTestId('bid-error').textContent).not.toMatch(/\b200\b/);
  });
});

describe('F-MOD-002-rework-02 in-room Pause action (UF-01-03 item 3)', () => {
  it('test_F_MOD_002_rework_02_pause_action_visible_for_commissioner_role', async () => {
    await renderDraftRoom('COMMISSIONER');
    expect(screen.getByTestId('pause-draft-button')).toBeTruthy();
  });

  it('test_F_MOD_002_rework_02_pause_action_hidden_for_owner_role', async () => {
    await renderDraftRoom('OWNER');
    expect(screen.queryByTestId('pause-draft-button')).toBeNull();
  });

  it('test_F_MOD_002_rework_02_pause_action_calls_pause_endpoint_and_opens_commissioner_console', async () => {
    await renderDraftRoom('COMMISSIONER');
    fireEvent.click(screen.getByTestId('pause-draft-button'));

    await waitFor(() => expect(fetchCalls.some((c) => c.url.endsWith('/pause') && c.init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByText('Commissioner Console Marker')).toBeTruthy());
  });
});

describe('F-MOD-002-rework-02 Draft Room <-> War Room cross-navigation (UF-01-03 item 4)', () => {
  it('test_F_MOD_002_rework_02_draft_room_links_to_war_room', async () => {
    await renderDraftRoom();
    const link = screen.getByTestId('open-war-room-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/war-room?draftId=${DRAFT_ID}`);
    expect(link.target).toBe('_blank');
  });

  it('test_F_MOD_002_rework_02_war_room_links_back_to_draft_room', async () => {
    installFetchMock();
    render(
      <MemoryRouter initialEntries={[`/war-room?draftId=${DRAFT_ID}`]}>
        <Routes>
          <Route path="/war-room" element={<WarRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const link = screen.getByTestId('open-draft-room-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/draft-room?draftId=${DRAFT_ID}`);
    expect(link.target).toBe('_blank');
  });
});

describe('F-MOD-002-rework-02 always-visible own roster status (UF-01-03 items 5-6)', () => {
  it('test_F_MOD_002_rework_02_shows_filled_and_open_starter_slots_and_bench_count', async () => {
    await renderDraftRoom();
    await waitFor(() => expect(screen.getByTestId('my-roster')).toBeTruthy());

    // QB is filled (1/1), RB and WR are open (0/2 each), bench 0/6 — per fixture.
    expect(screen.getByTestId('roster-slot-QB').textContent).toContain('1/1');
    expect(screen.getByTestId('roster-slot-RB').textContent).toContain('0/2');
    expect(screen.getByTestId('roster-slot-WR').textContent).toContain('0/2');
    expect(screen.getByTestId('roster-slot-bench').textContent).toContain('0/6');
    // Bench itself must not appear among the starter slots list.
    expect(screen.queryByTestId('roster-slot-BN')).toBeNull();
  });

  it('test_F_MOD_002_rework_02_roster_status_updates_on_PLAYER_AWARDED_via_grid_refresh', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    // Server-side roster-grid now reflects RB filled 1/2 after an award —
    // the client re-fetches /roster-grid whenever recentAwards grows.
    const updatedGrid = rosterGridFixture.map((t) =>
      t.team_id === 't1'
        ? { ...t, slots: t.slots.map((s) => (s.position === 'RB' ? { ...s, filled: 1 } : s)) }
        : t,
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: updatedGrid });
      if (url.endsWith('/config')) return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 100 } });
      if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
      if (url.endsWith('/target-values')) return jsonResponse(200, { targets: [] });
      return jsonResponse(404, {});
    });

    ws.push({
      type: 'PLAYER_AWARDED',
      payload: {
        player_auction_id: 'pa-1', player_name: 'Justin Jefferson', winning_team_id: 't2',
        price_minor: 1200, roster_slot: 'WR', resolution_sequence: 1,
        accepted_bid_count: 1, unique_bidder_count: 1, aav_minor: 5000, remaining_budget_minor: 18800,
      },
    });

    await waitFor(() => expect(screen.getByTestId('roster-slot-RB').textContent).toContain('1/2'));
  });

  // ── F-MOD-002-rework-03: My Roster shows player name + price paid ──
  // UF-17-04: fill counts alone ("QB 1/1") don't say WHO was drafted or WHAT
  // they cost — the roster-grid now carries that per slot; the panel must
  // render it.

  it('test_F_MOD_002_rework_03_filled_slot_shows_player_name_and_price_paid', async () => {
    await renderDraftRoom();
    await waitFor(() => expect(screen.getByTestId('my-roster')).toBeTruthy());

    const qbSlot = screen.getByTestId('roster-slot-QB');
    expect(qbSlot.textContent).toContain('Josh Allen');
    expect(qbSlot.textContent).toContain('$42');
  });

  it('test_F_MOD_002_rework_03_open_slot_shows_no_player_or_price', async () => {
    await renderDraftRoom();
    await waitFor(() => expect(screen.getByTestId('my-roster')).toBeTruthy());

    // RB is 0/2 in the fixture — an unfilled slot must render no player identity.
    const rbSlot = screen.getByTestId('roster-slot-RB');
    expect(rbSlot.textContent).not.toContain('$');
  });

  it('test_F_MOD_002_rework_03_newly_filled_slot_shows_player_and_price_on_PLAYER_AWARDED_without_reload', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    const updatedGrid = rosterGridFixture.map((t) =>
      t.team_id === 't1'
        ? {
            ...t,
            slots: t.slots.map((s) =>
              s.position === 'RB'
                ? { ...s, filled: 1, players: [{ name: 'Justin Jefferson', price_minor: 1200 }] }
                : s,
            ),
          }
        : t,
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: updatedGrid });
      if (url.endsWith('/config')) return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 100 } });
      if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
      if (url.endsWith('/target-values')) return jsonResponse(200, { targets: [] });
      return jsonResponse(404, {});
    });

    ws.push({
      type: 'PLAYER_AWARDED',
      payload: {
        player_auction_id: 'pa-1', player_name: 'Justin Jefferson', winning_team_id: 't2',
        price_minor: 1200, roster_slot: 'WR', resolution_sequence: 1,
        accepted_bid_count: 1, unique_bidder_count: 1, aav_minor: 5000, remaining_budget_minor: 18800,
      },
    });

    await waitFor(() => expect(screen.getByTestId('roster-slot-RB').textContent).toContain('Justin Jefferson'));
    expect(screen.getByTestId('roster-slot-RB').textContent).toContain('$12');
  });
});
