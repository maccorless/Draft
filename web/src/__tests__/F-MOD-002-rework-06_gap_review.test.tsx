/**
 * F-MOD-002-rework-06: gap-review closeout (UF-17-08 subset).
 *
 * Covers: 403 fix is server-side (see server/src/__tests__/F-MOD-002_auction.test.ts),
 * plus the client-only wiring this rework adds:
 *   - Zone A: always-visible custom Owner Target Value
 *   - Anti-snipe extension indicator badge
 *   - Whammy display toast
 *   - Recent Bids ladder: bid_type + time-remaining
 *
 * Same mocking convention as F-MOD-002-rework-02 (see [[feedback-ui-test-mocking]]):
 * global.fetch mocked, global.WebSocket stubbed with a fake that lets tests push
 * frames directly — the true system boundary (live draft-engine WS server) is
 * already covered end-to-end by server/src/__tests__/F-MOD-002_auction.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { DraftRoom } from '../screens/draft-room/index.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-owner';
const TEAM_ID = 't1';

const playersFixture = [
  { player_id: 'p1', dataset_entry_id: 'p1', name: 'Justin Jefferson', position: 'WR', nfl_team: 'MIN', aav_minor: 5000, tier: 1, projected_points: 300 },
  { player_id: 'p2', dataset_entry_id: 'p2', name: 'Josh Allen', position: 'QB', nfl_team: 'BUF', aav_minor: 5500, tier: 1, projected_points: 380, bye_week: 12 },
];

const rosterGridFixture = [
  {
    team_id: 't1', team_name: 'Alpha', icon_url: null, remaining_budget_minor: 20000, max_legal_bid_minor: 20000,
    roster_filled_count: 1, control_mode: 'MANUAL',
    slots: [{ position: 'QB', is_starter: true, filled: 1, total: 1, players: [{ name: 'Josh Allen', price_minor: 4200 }] }],
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

function installFetchMock(): void {
  global.fetch = vi.fn((url: string) => {
    if (url.endsWith('/config')) {
      return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 100 } });
    }
    if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: rosterGridFixture });
    if (url.endsWith('/target-values')) return jsonResponse(200, { targets: [{ player_name: 'Justin Jefferson', target_value_minor: 4200 }] });
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

async function renderDraftRoom(): Promise<FakeWebSocket> {
  installFetchMock();
  render(
    <MemoryRouter initialEntries={[`/draft-room?draftId=${DRAFT_ID}`]}>
      <Routes>
        <Route
          path="/draft-room"
          element={<DraftRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} role="OWNER" />}
        />
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

describe('F-MOD-002-rework-06 Zone A custom Target Value', () => {
  it('test_F_MOD_002_rework_06_shows_custom_target_value_when_set', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());
    expect(screen.getByTestId('my-target-value').textContent).toContain('$42');
  });
});

describe('F-MOD-002-rework-06 My Roster bye week + projected points columns', () => {
  it('test_F_MOD_002_rework_06_filled_slot_shows_bye_week_and_projected_points', async () => {
    await renderDraftRoom();
    await waitFor(() => expect(screen.getByTestId('my-roster')).toBeTruthy());

    expect(screen.getByTestId('roster-slot-QB-player-0-bye').textContent).toBe('12');
    expect(screen.getByTestId('roster-slot-QB-player-0-points').textContent).toBe('380');
  });
});

describe('F-MOD-002-rework-06 anti-snipe extension indicator', () => {
  it('test_F_MOD_002_rework_06_shows_anti_snipe_badge_when_bid_extends_deadline', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    expect(screen.queryByTestId('anti-snipe-badge')).toBeNull();

    ws.push({
      type: 'BID_ACCEPTED',
      payload: {
        player_auction_id: 'pa-1',
        bid_amount_minor: 300,
        leading_team_id: 't2',
        auction_version: 2,
        rebid_deadline_ts: Date.now() + 60000,
        anti_snipe_extended: true,
      },
    });

    await waitFor(() => expect(screen.getByTestId('anti-snipe-badge')).toBeTruthy());
  });

  it('test_F_MOD_002_rework_06_no_badge_when_bid_does_not_extend_deadline', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

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

    await waitFor(() => expect(screen.getByTestId('current-bid').textContent).toContain('$3'));
    expect(screen.queryByTestId('anti-snipe-badge')).toBeNull();
  });
});

describe('F-MOD-002-rework-06 Whammy display', () => {
  it('test_F_MOD_002_rework_06_shows_whammy_toast_naming_team_and_effect', async () => {
    const ws = await renderDraftRoom();
    await waitFor(() => expect(screen.getByTestId('my-roster')).toBeTruthy());

    ws.push({
      type: 'WHAMMY_APPLIED',
      payload: { team_id: 't1', amount_minor: -500, description: 'Bad luck!', new_remaining_budget_minor: 19500 },
    });

    await waitFor(() => expect(screen.getByTestId('whammy-toast')).toBeTruthy());
    expect(screen.getByTestId('whammy-toast').textContent).toContain('Alpha');
    expect(screen.getByTestId('whammy-toast').textContent).toContain('Bad luck!');
  });
});

describe('F-MOD-002-rework-06 Recent Bids ladder: bid type + time remaining', () => {
  it('test_F_MOD_002_rework_06_ladder_shows_bid_type_indicator_only_for_absolute_jump', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    ws.push({
      type: 'BID_ACCEPTED',
      payload: {
        player_auction_id: 'pa-1',
        bid_amount_minor: 500,
        leading_team_id: 't2',
        auction_version: 2,
        rebid_deadline_ts: Date.now() + 60000,
        anti_snipe_extended: false,
        bid_type: 'ABSOLUTE',
        ms_remaining_at_receipt: 45000,
      },
    });

    await waitFor(() => expect(screen.getByTestId('bid-ladder-type')).toBeTruthy());
    expect(screen.getByTestId('bid-ladder-type').textContent).toBe('ABSOLUTE');
    expect(screen.getByTestId('bid-ladder-remaining').textContent).toContain('45s');
  });

  it('test_F_MOD_002_rework_06_ladder_hides_bid_type_for_plain_relative_bid_but_shows_time_remaining', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    ws.push({
      type: 'BID_ACCEPTED',
      payload: {
        player_auction_id: 'pa-1',
        bid_amount_minor: 200,
        leading_team_id: 't2',
        auction_version: 2,
        rebid_deadline_ts: Date.now() + 60000,
        anti_snipe_extended: false,
        bid_type: 'RELATIVE',
        ms_remaining_at_receipt: 30000,
      },
    });

    await waitFor(() => expect(screen.getByTestId('bid-ladder-remaining')).toBeTruthy());
    expect(screen.queryByTestId('bid-ladder-type')).toBeNull();
  });
});
