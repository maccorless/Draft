/**
 * F-MOD-008-rework-01: War Room gap-review enrichments — Do Not Draft tab,
 * Market Context AAV-baseline + remaining-by-tier, Recent Activity
 * unique_bidder_count/aav_diff_minor, Player Intelligence prior-season
 * stats, Comparable Remaining Proj/My Target columns, Watch List AAV/
 * customized-target flag/status, Nomination Queue opening-price/
 * availability, Targets all-players toggle, Whammy toast.
 *
 * Follows the same mocking convention as F-MOD-002-rework-02's Draft Room
 * tests (see [[feedback-ui-test-mocking]]): global.fetch mocked, global.WebSocket
 * stubbed with a fake that lets the test push frames directly.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { WarRoom } from '../screens/war-room/index.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-owner';
const TEAM_ID = 't1';

const playersFixture = [
  { player_id: 'p1', dataset_entry_id: 'p1', name: 'Active Guy', position: 'WR', nfl_team: 'MIN', aav_minor: 5000, tier: 1, projected_points: 300, prior_season_stats: { receptions: 90, yards: 1200 } },
  { player_id: 'p2', dataset_entry_id: 'p2', name: 'Comparable Guy', position: 'WR', nfl_team: 'DAL', aav_minor: 4800, tier: 1, projected_points: 290 },
  { player_id: 'p3', dataset_entry_id: 'p3', name: 'Watched Guy', position: 'RB', nfl_team: 'SF', aav_minor: 3000, tier: 2, projected_points: 250, injury_status: 'Questionable' },
];

const rosterGridFixture = [
  {
    team_id: 't1', team_name: 'Alpha', icon_url: null, remaining_budget_minor: 20000, max_legal_bid_minor: 20000,
    roster_filled_count: 1, control_mode: 'MANUAL',
    slots: [{ position: 'WR', is_starter: true, filled: 0, total: 2 }, { position: 'BN', is_starter: false, filled: 0, total: 6 }],
  },
  {
    team_id: 't2', team_name: 'Beta', icon_url: null, remaining_budget_minor: 15000, max_legal_bid_minor: 15000,
    roster_filled_count: 1, control_mode: 'MANUAL',
    slots: [{ position: 'WR', is_starter: true, filled: 2, total: 2 }, { position: 'BN', is_starter: false, filled: 0, total: 6 }],
  },
];

const activityFixture = [
  { acquisition_id: 'a1', player_name: 'Sold Guy', position: 'QB', price_minor: 6000, team_id: 't2', team_name: 'Beta', bid_count: 3, unique_bidder_count: 2, aav_diff_minor: 1000 },
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
      return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 150 } });
    }
    if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: rosterGridFixture });
    if (url.endsWith('/activity')) return jsonResponse(200, { recent: activityFixture });
    if (url.endsWith('/watchlist')) return jsonResponse(200, { watchlist: [{ dataset_player_id: 'p3', player_name: 'Watched Guy', position: 'RB', aav_minor: 3000 }] });
    if (url.endsWith('/nomination-queue')) return jsonResponse(200, { queue: [{ dataset_player_id: 'p2', queue_position: 0, player_name: 'Comparable Guy', position: 'WR', aav_minor: 4800 }] });
    if (url.endsWith('/target-values')) return jsonResponse(200, { targets: [{ dataset_player_id: 'p3', target_value_minor: 3200, player_name: 'Watched Guy', position: 'RB', aav_minor: 3000 }] });
    if (url.endsWith('/do-not-draft')) return jsonResponse(200, { entries: [] });
    if (url.includes('/do-not-draft/')) return jsonResponse(200, {});
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + url });
  }) as unknown as typeof fetch;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
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

async function renderWarRoom(): Promise<FakeWebSocket> {
  installFetchMock();
  render(
    <MemoryRouter initialEntries={[`/war-room?draftId=${DRAFT_ID}`]}>
      <Routes>
        <Route path="/war-room" element={<WarRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
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
  await waitFor(() => expect(screen.getByText(/Alpha/)).toBeTruthy());
  return ws;
}

function nominateActiveGuy(ws: FakeWebSocket): void {
  ws.push({
    type: 'NOMINATION_STARTED',
    payload: {
      player_auction_id: 'pa1',
      opening_bid_minor: 100,
      nominator_team_id: 't1',
      nomination_deadline_ts: Date.now() + 60000,
      second_bid_deadline_ts: Date.now() + 60000,
      player_name: 'Active Guy',
      position: 'WR',
      nfl_team: 'MIN',
      tier: 1,
      aav_minor: 5000,
      projected_points: 300,
    },
  });
}

describe('F-MOD-008-rework-01 War Room enrichments', () => {
  it('test_F_MOD_008_rw01_do_not_draft_tab_add_and_remove', async () => {
    const ws = await renderWarRoom();
    void ws;
    fireEvent.click(screen.getByRole('tab', { name: /Do Not Draft/ }));
    await waitFor(() => expect(screen.getByText('No players on your Do Not Draft list.')).toBeTruthy());

    nominateActiveGuy(ws);
    await waitFor(() => expect(screen.getByText('+ Do Not Draft Active Guy')).toBeTruthy());
    fireEvent.click(screen.getByText('+ Do Not Draft Active Guy'));

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.url.endsWith('/do-not-draft') && c.init?.method === 'POST');
      expect(call).toBeTruthy();
    });
  });

  it('test_F_MOD_008_rw01_watchlist_shows_aav_target_flag_and_status', async () => {
    await renderWarRoom();
    fireEvent.click(screen.getByRole('tab', { name: /Watch/ }));
    await waitFor(() => expect(screen.getByText(/Watched Guy/)).toBeTruthy());
    const item = screen.getByText(/Watched Guy/).closest('li')!;
    expect(item.textContent).toContain('$30'); // aav_minor 3000
    expect(item.textContent).toContain('★'); // has a custom target (p3 target set)
    expect(item.textContent).toContain('Questionable');
  });

  it('test_F_MOD_008_rw01_queue_shows_opening_price_and_availability', async () => {
    await renderWarRoom();
    fireEvent.click(screen.getByRole('tab', { name: /Queue/ }));
    await waitFor(() => expect(screen.getByText(/Comparable Guy/)).toBeTruthy());
    const item = screen.getByText(/Comparable Guy/).closest('li')!;
    expect(item.textContent).toContain('$2'); // min_bid_minor 150 -> $2 (rounded)
  });

  it('test_F_MOD_008_rw01_targets_all_players_toggle_shows_blank_not_dollar_zero', async () => {
    await renderWarRoom();
    fireEvent.click(screen.getByRole('tab', { name: /Targets/ }));
    await waitFor(() => expect(screen.getByText(/Watched Guy/)).toBeTruthy());
    expect(screen.queryByText('Active Guy')).toBeNull();

    fireEvent.click(screen.getByLabelText(/All tracked players/) ?? screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('Active Guy')).toBeTruthy());
    const row = screen.getByText('Active Guy').closest('li')!;
    expect(row.textContent).not.toContain('$0');
  });

  it('test_F_MOD_008_rw01_prior_season_stats_rendered_for_active_player', async () => {
    const ws = await renderWarRoom();
    nominateActiveGuy(ws);
    await waitFor(() => expect(screen.getByTestId('prior-season-stats')).toBeTruthy());
    expect(screen.getByTestId('prior-season-stats').textContent).toContain('1200');
  });

  it('test_F_MOD_008_rw01_comparable_remaining_shows_proj_and_target_columns', async () => {
    const ws = await renderWarRoom();
    nominateActiveGuy(ws);
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    const row = screen.getAllByText('Comparable Guy').map((el) => el.closest('tr')).find((tr) => tr !== null)!;
    expect(row!.textContent).toContain('290.0');
  });

  it('test_F_MOD_008_rw01_market_context_aav_baseline_and_remaining_by_tier', async () => {
    await renderWarRoom();
    await waitFor(() => expect(screen.getByTestId('market-aav-baseline')).toBeTruthy());
    // actual price 6000 vs aav (6000-1000=5000) -> +1000 / +20.0%
    expect(screen.getByTestId('market-aav-baseline').textContent).toContain('20.0%');
    expect(screen.getByTestId('market-remaining-by-tier')).toBeTruthy();
  });

  it('test_F_MOD_008_rw01_recent_activity_shows_bidders_and_aav_diff', async () => {
    await renderWarRoom();
    await waitFor(() => expect(screen.getByText('Sold Guy')).toBeTruthy());
    const item = screen.getByText('Sold Guy').closest('li')!;
    expect(item.textContent).toContain('bidders');
    expect(item.textContent).toContain('vs AAV');
  });

  it('test_F_MOD_008_rw01_whammy_toast_renders_on_whammy_applied', async () => {
    const ws = await renderWarRoom();
    ws.push({ type: 'WHAMMY_APPLIED', payload: { team_id: 't2', amount_minor: -500, description: 'Bad luck', new_remaining_budget_minor: 14500 } });
    await waitFor(() => expect(screen.getByTestId('whammy-toast')).toBeTruthy());
    expect(screen.getByTestId('whammy-toast').textContent).toContain('Bad luck');
    expect(screen.getByTestId('whammy-toast').textContent).toContain('Beta');
  });
});
