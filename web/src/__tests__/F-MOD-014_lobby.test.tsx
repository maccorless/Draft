/**
 * F-MOD-014: Pre-Draft Lobby — readiness/status messaging, prep-tool tabs
 * (Watch List / Nomination Queue / Target Values / Auto-Agent / Do Not Draft),
 * and the mounted team media control.
 *
 * jsdom component test — mocks global.fetch (see [[feedback-ui-test-mocking]]).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { Lobby } from '../screens/lobby/index.js';

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
}

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
    if (url.includes('/players')) return jsonResponse({ players: [] });
    return jsonResponse({});
  });
}

const baseProps = {
  leagueName: 'Test League',
  teamName: 'My Team',
  scheduledAt: null,
  draftStatus: 'CREATED' as const,
  leagueId: 'league-1',
  teamId: 'team-1',
  token: 'tok',
  draftId: 'draft-1',
};

describe('F-MOD-014 Lobby', () => {
  beforeEach(() => {
    global.fetch = makeFetchMock();
  });

  it('test_F_MOD_014_lobby_status_message_renders_when_present', async () => {
    render(<Lobby {...baseProps} statusMessage="Draft starts at 7pm sharp" />);
    await waitFor(() => {
      expect(screen.getByTestId('status-message').textContent).toBe('Draft starts at 7pm sharp');
    });
  });

  it('test_F_MOD_014_lobby_status_message_renders_nothing_when_absent', () => {
    render(<Lobby {...baseProps} statusMessage={null} />);
    expect(screen.queryByTestId('status-message')).toBeNull();
  });

  it('test_F_MOD_014_lobby_status_message_renders_nothing_when_undefined', () => {
    // Forward-compat: MOD-010's status_message field doesn't exist in the API
    // yet, so callers may omit the prop entirely (baseProps has no such key).
    render(<Lobby {...baseProps} />);
    expect(screen.queryByTestId('status-message')).toBeNull();
  });

  it('test_F_MOD_014_lobby_watchlist_tab_loads_and_renders_items', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/watchlist': () =>
        jsonResponse({ watchlist: [{ dataset_player_id: 'p1', player_name: 'Josh Allen', position: 'QB' }] }),
    });
    render(<Lobby {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Josh Allen')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_lobby_watchlist_remove_calls_delete_endpoint', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/watchlist': () =>
        jsonResponse({ watchlist: [{ dataset_player_id: 'p1', player_name: 'Josh Allen', position: 'QB' }] }),
    });
    render(<Lobby {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Josh Allen')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Remove Josh Allen from watch list'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/drafts/draft-1/teams/team-1/watchlist/p1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('test_F_MOD_014_lobby_queue_tab_renders_items_in_queue_position_order', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/nomination-queue': () =>
        jsonResponse({
          queue: [
            { dataset_player_id: 'p2', queue_position: 0, player_name: 'Second Pick', position: 'RB' },
            { dataset_player_id: 'p1', queue_position: 1, player_name: 'First Pick', position: 'QB' },
          ],
        }),
    });
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Nomination Queue' }));

    await waitFor(() => {
      const items = screen.getAllByText(/Pick/);
      expect(items[0]!.textContent).toContain('Second Pick');
      expect(items[1]!.textContent).toContain('First Pick');
    });
  });

  it('test_F_MOD_014_lobby_queue_reorder_calls_put_with_ordered_player_ids', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/nomination-queue': () =>
        jsonResponse({
          queue: [
            { dataset_player_id: 'p1', queue_position: 0, player_name: 'First', position: 'QB' },
            { dataset_player_id: 'p2', queue_position: 1, player_name: 'Second', position: 'RB' },
          ],
        }),
    });
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Nomination Queue' }));
    await waitFor(() => expect(screen.getByText(/First/)).toBeTruthy());

    fireEvent.click(screen.getAllByLabelText('Move down')[0]!);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/drafts/draft-1/teams/team-1/nomination-queue',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ ordered_player_ids: ['p2', 'p1'] }),
        }),
      );
    });
  });

  it('test_F_MOD_014_lobby_targets_tab_renders_get_response', async () => {
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/target-values': () =>
        jsonResponse({ targets: [{ dataset_player_id: 'p1', target_value_minor: 4500, player_name: 'Target Guy', position: 'WR' }] }),
    });
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Target Values' }));

    await waitFor(() => {
      expect(screen.getByText('Target Guy')).toBeTruthy();
      expect(screen.getByText('$45')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_lobby_auto_agent_submit_calls_put_and_round_trips_value', async () => {
    global.fetch = makeFetchMock({
      'PUT /drafts/draft-1/teams/team-1/auto-agent': () =>
        jsonResponse({
          team_id: 'team-1',
          use_owner_target_when_customized: true,
          fallback_to_primary_aav: true,
          max_over_base_pct: 0.42,
          random_variance_pct: 0.25,
          bench_value_pct: 0.5,
          prioritize_starters: true,
        }),
    });
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Auto-Agent' }));

    const slider = await screen.findByLabelText(/Max over base/);
    fireEvent.change(slider, { target: { value: '0.42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/drafts/draft-1/teams/team-1/auto-agent',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            use_owner_target_when_customized: true,
            fallback_to_primary_aav: true,
            max_over_base_pct: 0.42,
            random_variance_pct: 0.25,
            bench_value_pct: 0.5,
            prioritize_starters: true,
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Max over base \(42%\)/)).toBeTruthy();
    });
  });

  it('test_F_MOD_014_lobby_do_not_draft_tab_empty_state_not_an_error', async () => {
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Do Not Draft' }));

    await waitFor(() => {
      expect(screen.getByText('No players on your Do Not Draft list.')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_lobby_do_not_draft_add_calls_post_and_refreshes', async () => {
    let added = false;
    global.fetch = makeFetchMock({
      'GET /drafts/draft-1/teams/team-1/do-not-draft': () =>
        jsonResponse({ entries: added ? [{ player_id: 'p1', player_name: 'Avoid Me' }] : [] }),
      'POST /drafts/draft-1/teams/team-1/do-not-draft': () => {
        added = true;
        return jsonResponse({ player_id: 'p1', player_name: 'Avoid Me' });
      },
      'GET /leagues/league-1/players': () =>
        jsonResponse({ players: [{ player_id: 'p1', dataset_entry_id: 'p1', name: 'Avoid Me', position: 'QB' }] }),
    });
    render(<Lobby {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Do Not Draft' }));

    const select = await screen.findByLabelText('Add to Do Not Draft');
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Do Not Draft' }));

    await waitFor(() => {
      expect(screen.getByText('Avoid Me')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_lobby_omits_prep_tools_when_no_draft_created', () => {
    render(<Lobby {...baseProps} draftId={null} />);
    expect(
      screen.getByText('Prep tools become available once the draft has been created.'),
    ).toBeTruthy();
  });

  it('test_F_MOD_014_lobby_mounts_team_media_upload_control', () => {
    render(<Lobby {...baseProps} />);
    expect(screen.getByLabelText('Team presentation media')).toBeTruthy();
  });
});
