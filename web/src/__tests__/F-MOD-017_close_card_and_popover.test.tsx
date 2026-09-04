/**
 * F-MOD-017: Auction Close Card and Player Detail Popover — frontend.
 *
 * `global.fetch` is mocked the same way F-MOD-001/F-MOD-012/F-MOD-013's tests
 * do (no live server needed for pure UI-behavior tests) — see
 * [[feedback-ui-test-mocking]]. Draft Room opens a live auction WebSocket;
 * jsdom has no real WS server to connect to, so `global.WebSocket` is stubbed
 * with a minimal fake that lets a test push frames at it directly — the true
 * system boundary here is the live draft-engine WS server.
 *
 * AuctionCloseCard and PlayerDetailPopover are also exercised directly
 * (no socket/router needed) for their own presentational contracts —
 * field mapping, conditional omission of not-yet-available fields, and the
 * semantic (button) dismiss controls.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { DraftRoom } from '../screens/draft-room/index.js';
import { AuctionCloseCard } from '../components/AuctionCloseCard.js';
import { PlayerDetailPopover } from '../components/PlayerDetailPopover.js';
import type { AwardEntry } from '../lib/useAuctionSocket.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-owner';
const TEAM_ID = 't1';

const playersFixture = [
  {
    player_id: 'p1',
    dataset_entry_id: 'p1',
    name: 'Justin Jefferson',
    position: 'WR',
    nfl_team: 'MIN',
    aav_minor: 5000,
    tier: 1,
    projected_points: 300,
    injury_status: 'Q',
    injury_detail: 'Ankle',
    injury_updated_at: new Date(Date.now() - 22 * 60000).toISOString(),
    bye_week: 7,
    prior_season_stats: { receptions: 100, yards: 1400 },
    aav_sources: [
      { source: 'CSV', aav_minor: 5000 },
      { source: 'FANTASYPROS', aav_minor: 5200 },
    ],
  },
  { player_id: 'p2', dataset_entry_id: 'p2', name: 'Ceedee Lamb', position: 'WR', nfl_team: 'DAL', aav_minor: 4800, tier: 1, projected_points: 290 },
  { player_id: 'p3', dataset_entry_id: 'p3', name: 'Tyreek Hill', position: 'WR', nfl_team: 'MIA', aav_minor: 4700, tier: 1, projected_points: 280 },
];

const rosterGridFixture = [
  { team_id: 't1', team_name: 'Alpha', icon_url: null, remaining_budget_minor: 20000, max_legal_bid_minor: 20000, roster_filled_count: 0, control_mode: 'MANUAL', slots: [] },
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

function installFetchMock(targets: Array<{ dataset_player_id: string; target_value_minor: number; player_name: string }> = []): void {
  global.fetch = vi.fn((url: string) => {
    if (url.endsWith('/config')) {
      return jsonResponse(200, { roster: null, roster_slots: [], auction: { initial_budget_minor: 20000, min_bid_minor: 100 } });
    }
    if (url.endsWith('/players')) return jsonResponse(200, { players: playersFixture });
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: rosterGridFixture });
    if (url.endsWith('/target-values')) return jsonResponse(200, { targets });
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + url });
  }) as unknown as typeof fetch;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
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

async function renderDraftRoom(targets: Array<{ dataset_player_id: string; target_value_minor: number; player_name: string }> = []): Promise<FakeWebSocket> {
  installFetchMock(targets);
  render(
    <MemoryRouter initialEntries={[`/draft-room?draftId=${DRAFT_ID}`]}>
      <Routes>
        <Route path="/draft-room" element={<DraftRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
        <Route path="/draft-complete" element={<p>Draft Complete Marker</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const ws = FakeWebSocket.instances[0]!;
  ws.onopen?.();
  ws.push({ type: 'STATE_SNAPSHOT', payload: { teams: rosterGridFixture.map((t) => ({ team_id: t.team_id, remaining_budget_minor: t.remaining_budget_minor, roster_filled_count: 0, control_mode: 'MANUAL' })), current_auction: null, status: 'RUNNING', as_of_sequence: 1 } });
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

// ── Integration: DraftRoom wiring ──────────────────────────────────────────

describe('F-MOD-017 DraftRoom close card wiring', () => {
  it('test_F_MOD_017_close_card_renders_on_player_awarded_with_required_fields', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    ws.push({
      type: 'PLAYER_AWARDED',
      payload: {
        player_auction_id: 'pa-1',
        player_name: 'Justin Jefferson',
        winning_team_id: 't2',
        price_minor: 1200,
        roster_slot: 'WR',
        resolution_sequence: 1,
        accepted_bid_count: 11,
        unique_bidder_count: 2,
        aav_minor: 5000,
        remaining_budget_minor: 18800,
      },
    });

    await waitFor(() => expect(screen.getByTestId('auction-close-card')).toBeTruthy());
    const card = screen.getByTestId('auction-close-card');
    expect(card.textContent).toContain('Justin Jefferson');
    expect(card.textContent).toContain('Beta');
    expect(card.textContent).toContain('$12'); // price_minor 1200 -> $12
    expect(card.textContent).toContain('under AAV'); // 1200 - 5000 = under
    expect(card.textContent).toContain('11');
    expect(card.textContent).toContain('bids');
    expect(card.textContent).toContain('2');
    expect(card.textContent).toContain('bidders');
    expect(card.textContent).toContain('$188'); // remaining_budget_minor 18800 -> $188
  });

  it('test_F_MOD_017_close_card_does_not_block_nomination_ui_underneath', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    ws.push({
      type: 'PLAYER_AWARDED',
      payload: {
        player_auction_id: 'pa-1', player_name: 'Justin Jefferson', winning_team_id: 't2',
        price_minor: 1200, roster_slot: 'WR', resolution_sequence: 1,
        accepted_bid_count: 11, unique_bidder_count: 2, aav_minor: 5000, remaining_budget_minor: 18800,
      },
    });
    ws.push({ type: 'NOMINATION_TURN_CHANGED', payload: { current_nominator_team_id: 't1', nomination_deadline_ts: Date.now() + 9000 } });

    await waitFor(() => expect(screen.getByTestId('auction-close-card')).toBeTruthy());
    // The card is a non-blocking overlay — nomination UI for the new
    // nominator's turn renders underneath it, unaffected.
    expect(screen.getByText('Your turn to nominate')).toBeTruthy();
  });

  it('test_F_MOD_017_close_card_dismiss_is_a_semantic_button_and_removes_card', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    ws.push({
      type: 'PLAYER_AWARDED',
      payload: {
        player_auction_id: 'pa-1', player_name: 'Justin Jefferson', winning_team_id: 't2',
        price_minor: 1200, roster_slot: 'WR', resolution_sequence: 1,
        accepted_bid_count: 11, unique_bidder_count: 2, aav_minor: 5000, remaining_budget_minor: 18800,
      },
    });

    await waitFor(() => expect(screen.getByTestId('auction-close-card')).toBeTruthy());
    const dismissBtn = screen.getByTestId('close-card-dismiss');
    expect(dismissBtn.tagName).toBe('BUTTON');
    fireEvent.click(dismissBtn);
    expect(screen.queryByTestId('auction-close-card')).toBeNull();
  });
});

describe('F-MOD-017 DraftRoom player detail popover wiring', () => {
  it('test_F_MOD_017_popover_opens_on_name_click_and_shows_available_fields', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    fireEvent.click(screen.getByTestId('active-player-name'));

    await waitFor(() => expect(screen.getByTestId('player-detail-popover')).toBeTruthy());
    const popover = screen.getByTestId('player-detail-popover');
    expect(popover.textContent).toContain('Justin Jefferson');
    expect(popover.textContent).toContain('Tier 1');
    expect(popover.textContent).toContain('$50'); // aav_minor 5000
    expect(popover.textContent).toContain('300.0'); // projected_points
    expect(popover.textContent).toContain('7'); // bye week
    expect(screen.getByTestId('popover-injury').textContent).toContain('Q — Ankle');
    expect(screen.getByTestId('popover-injury').textContent).toContain('ago');
    expect(screen.getByTestId('popover-aav-sources').textContent).toContain('FANTASYPROS');
    expect(screen.getByTestId('popover-prior-stats').textContent).toContain('receptions');
    // Comparable = same position + tier, not yet drafted, excluding the active player.
    const comparables = screen.getByTestId('popover-comparables');
    expect(comparables.textContent).toContain('Ceedee Lamb');
    expect(comparables.textContent).toContain('Tyreek Hill');
    expect(comparables.textContent).not.toContain('Justin Jefferson');
    // No custom target was set for this owner/player — the row is omitted entirely.
    expect(screen.queryByTestId('popover-target')).toBeNull();
  });

  it('test_F_MOD_017_popover_shows_target_only_when_set', async () => {
    const ws = await renderDraftRoom([{ dataset_player_id: 'p1', target_value_minor: 4500, player_name: 'Justin Jefferson' }]);
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    fireEvent.click(screen.getByTestId('active-player-name'));

    await waitFor(() => expect(screen.getByTestId('popover-target')).toBeTruthy());
    expect(screen.getByTestId('popover-target').textContent).toContain('$45');
  });

  it('test_F_MOD_017_popover_dismiss_is_semantic_button_and_preserves_bid_controls_and_custom_amount', async () => {
    const ws = await renderDraftRoom();
    nominateJustinJefferson(ws);
    await waitFor(() => expect(screen.getByTestId('active-player-name')).toBeTruthy());

    fireEvent.change(screen.getByTestId('custom-bid-input'), { target: { value: '42' } });
    fireEvent.click(screen.getByTestId('active-player-name'));
    await waitFor(() => expect(screen.getByTestId('player-detail-popover')).toBeTruthy());

    const closeBtn = screen.getByTestId('popover-close');
    expect(closeBtn.tagName).toBe('BUTTON');
    fireEvent.click(closeBtn);

    expect(screen.queryByTestId('player-detail-popover')).toBeNull();
    expect(screen.getByLabelText('Bid controls')).toBeTruthy();
    expect((screen.getByTestId('custom-bid-input') as HTMLInputElement).value).toBe('42');
  });
});

// ── Unit: AuctionCloseCard ──────────────────────────────────────────────────

describe('F-MOD-017 AuctionCloseCard', () => {
  const award: AwardEntry = {
    player_auction_id: 'pa-1',
    player_name: 'Justin Jefferson',
    winning_team_id: 't2',
    price_minor: 6000,
    roster_slot: 'WR',
    resolution_sequence: 1,
    accepted_bid_count: 3,
    unique_bidder_count: 2,
    aav_minor: 5000,
    remaining_budget_minor: 14000,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_F_MOD_017_close_card_shows_over_aav_when_price_exceeds_aav', () => {
    render(<AuctionCloseCard award={award} winningTeamName="Beta" onDismiss={vi.fn()} />);
    expect(screen.getByTestId('auction-close-card').textContent).toContain('over AAV');
  });

  it('test_F_MOD_017_close_card_auto_dismisses_after_display_window', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<AuctionCloseCard award={award} winningTeamName="Beta" onDismiss={onDismiss} displayMs={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ── Unit: PlayerDetailPopover ────────────────────────────────────────────────

describe('F-MOD-017 PlayerDetailPopover', () => {
  it('test_F_MOD_017_popover_omits_not_yet_available_sections_without_broken_placeholders', () => {
    render(
      <PlayerDetailPopover
        player={{ name: 'Bare Player', position: 'RB', nfl_team: 'KC', tier: 2, aav_minor: 1000, projected_points: null }}
        targetValueMinor={null}
        comparables={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('popover-injury')).toBeNull();
    expect(screen.queryByTestId('popover-aav-sources')).toBeNull();
    expect(screen.queryByTestId('popover-prior-stats')).toBeNull();
    expect(screen.queryByTestId('popover-target')).toBeNull();
    expect(screen.getByText('No comparable players remaining.')).toBeTruthy();
  });
});
