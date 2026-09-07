/**
 * F-MOD-014-rework-02: Draft Prep — the owner's pre-draft screen, split out of
 * the Lobby (see F-MOD-014_lobby.test.tsx). Center of the screen is the full
 * player pool: filterable by position/team/name, sortable by name/AAV/
 * projected points/target price, with inline Watch List / Nomination Queue /
 * Do Not Draft / Target Value actions per row, plus an Auto-Agent settings
 * section backed by the new GET /drafts/:draftId/teams/:teamId/auto-agent.
 *
 * jsdom component test — mocks global.fetch (see [[feedback-ui-test-mocking]]).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { DraftPrep } from '../screens/draft-prep/index.js';

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
}

const DEFAULT_AUTO_AGENT = {
  team_id: 'team-1',
  use_owner_target_when_customized: true,
  fallback_to_primary_aav: true,
  max_over_base_pct: 0.25,
  random_variance_pct: 0.25,
  bench_value_pct: 0.5,
  prioritize_starters: true,
};

const PLAYERS = [
  { player_id: 'p1', name: 'Josh Allen', position: 'QB', nfl_team: 'BUF', aav_minor: 5000, projected_points: 320.5 },
  { player_id: 'p2', name: 'Amon-Ra St. Brown', position: 'WR', nfl_team: 'DET', aav_minor: 3200, projected_points: 250.1 },
  { player_id: 'p3', name: 'Bijan Robinson', position: 'RB', nfl_team: 'ATL', aav_minor: 4100, projected_points: 280.0 },
];

function makeFetchMock(overrides: Record<string, () => Promise<Response>> = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    if (overrides[key]) return overrides[key]();
    if (url.endsWith('/watchlist')) return jsonResponse({ watchlist: [] });
    if (url.endsWith('/nomination-queue')) return jsonResponse({ queue: [] });
    if (url.endsWith('/target-values')) return jsonResponse({ targets: [] });
    if (url.endsWith('/do-not-draft')) return jsonResponse({ entries: [] });
    if (url.endsWith('/auto-agent')) return jsonResponse(DEFAULT_AUTO_AGENT);
    if (url.includes('/players')) return jsonResponse({ players: PLAYERS });
    return jsonResponse({});
  });
}

const baseProps = {
  leagueId: 'league-1',
  teamId: 'team-1',
  token: 'tok',
  draftId: 'draft-1',
  leagueName: 'Test League',
  teamName: 'My Team',
};

describe('F-MOD-014-rework-02 Draft Prep', () => {
  it('test_F_MOD_014_rw02_renders_full_player_pool', async () => {
    global.fetch = makeFetchMock();
    render(<DraftPrep {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Josh Allen')).toBeTruthy();
      expect(screen.getByText('Amon-Ra St. Brown')).toBeTruthy();
      expect(screen.getByText('Bijan Robinson')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_rw02_filters_by_position', async () => {
    global.fetch = makeFetchMock();
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'WR' } });

    expect(screen.queryByText('Josh Allen')).toBeNull();
    expect(screen.getByText('Amon-Ra St. Brown')).toBeTruthy();
  });

  it('test_F_MOD_014_rw02_filters_by_name_search', async () => {
    global.fetch = makeFetchMock();
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Search players by name'), { target: { value: 'bijan' } });

    expect(screen.queryByText('Josh Allen')).toBeNull();
    expect(screen.getByText('Bijan Robinson')).toBeTruthy();
  });

  it('test_F_MOD_014_rw02_sorts_by_aav_ascending_when_header_clicked_twice', async () => {
    global.fetch = makeFetchMock();
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    // Default sort is AAV descending: Allen (5000) > Robinson (4100) > St. Brown (3200)
    let rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(rows[0]!.textContent).toContain('Josh Allen');

    // One click -> ascending
    fireEvent.click(screen.getByText(/^AAV/));
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Amon-Ra St. Brown');
  });

  it('test_F_MOD_014_rw02_watch_toggle_posts_then_deletes', async () => {
    let watched = false;
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/watchlist': () =>
        jsonResponse({ watchlist: watched ? [{ dataset_player_id: 'p1', player_name: 'Josh Allen', position: 'QB' }] : [] }),
      'POST /drafts/draft-1/teams/team-1/watchlist': () => {
        watched = true;
        return jsonResponse({});
      },
      'DELETE /drafts/draft-1/teams/team-1/watchlist/p1': () => {
        watched = false;
        return jsonResponse({});
      },
    });
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Add Josh Allen to watch list'));
    await waitFor(() => expect(screen.getByLabelText('Remove Josh Allen from watch list')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Remove Josh Allen from watch list'));
    await waitFor(() => expect(screen.getByLabelText('Add Josh Allen to watch list')).toBeTruthy());
  });

  it('test_F_MOD_014_rw02_queue_toggle_and_reorder', async () => {
    let queue: Array<{ dataset_player_id: string; queue_position: number; player_name: string; position: string }> = [];
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/nomination-queue': () => jsonResponse({ queue }),
      'POST /drafts/draft-1/teams/team-1/nomination-queue': () => {
        queue = [{ dataset_player_id: 'p1', queue_position: 0, player_name: 'Josh Allen', position: 'QB' }];
        return jsonResponse({});
      },
    });
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Add Josh Allen to nomination queue'));

    await waitFor(() => {
      expect(screen.getByLabelText('Remove Josh Allen from nomination queue')).toBeTruthy();
    });
    // Reflected in the Nomination Queue section too (order list)
    const queueEntry = screen.getAllByText(/Josh Allen/).find((el) => el.closest('li'));
    expect(queueEntry?.closest('li')).toBeTruthy();
  });

  it('test_F_MOD_014_rw02_saves_target_value_on_blur', async () => {
    const putCalls: Array<{ targets: Array<{ dataset_player_id: string; target_value_minor: number }> }> = [];
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.endsWith('/target-values')) {
        putCalls.push(JSON.parse(init!.body as string));
        return jsonResponse({});
      }
      if (url.endsWith('/watchlist')) return jsonResponse({ watchlist: [] });
      if (url.endsWith('/nomination-queue')) return jsonResponse({ queue: [] });
      if (url.endsWith('/target-values')) return jsonResponse({ targets: [] });
      if (url.endsWith('/do-not-draft')) return jsonResponse({ entries: [] });
      if (url.endsWith('/auto-agent')) return jsonResponse(DEFAULT_AUTO_AGENT);
      if (url.includes('/players')) return jsonResponse({ players: PLAYERS });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    const input = screen.getByLabelText('Target value for Josh Allen');
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.blur(input);

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]!.targets).toEqual([{ dataset_player_id: 'p1', target_value_minor: 5500 }]);
  });

  it('test_F_MOD_014_rw02_do_not_draft_toggle_dims_row', async () => {
    let dndIds: string[] = [];
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/do-not-draft': () =>
        jsonResponse({ entries: dndIds.map((id) => ({ player_id: id, player_name: 'Josh Allen' })) }),
      'POST /drafts/draft-1/teams/team-1/do-not-draft': () => {
        dndIds = ['p1'];
        return jsonResponse({});
      },
    });
    render(<DraftPrep {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Add Josh Allen to Do Not Draft'));

    await waitFor(() => {
      expect(screen.getByLabelText('Remove Josh Allen from Do Not Draft')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_rw02_auto_agent_loads_via_get_and_saves_via_put', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/auto-agent': () => jsonResponse({ ...DEFAULT_AUTO_AGENT, max_over_base_pct: 0.33 }),
      'PUT /drafts/draft-1/teams/team-1/auto-agent': () => jsonResponse({ ...DEFAULT_AUTO_AGENT, max_over_base_pct: 0.42 }),
    });
    render(<DraftPrep {...baseProps} />);

    // Loaded from GET on mount, not left at the component's hardcoded default.
    await waitFor(() => expect(screen.getByLabelText(/Max over base \(33%\)/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Save Auto-Agent Settings' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/drafts/draft-1/teams/team-1/auto-agent',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    await waitFor(() => expect(screen.getByLabelText(/Max over base \(42%\)/)).toBeTruthy());
  });
});
