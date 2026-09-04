/**
 * Dev identity picker (temp, localhost-only) — click Commissioner or any
 * seeded team to sign in instantly. Placeholder for future magic-link auth
 * (PRD §4.4).
 *
 * jsdom component test — mocks global.fetch (see [[feedback-ui-test-mocking]]
 * memory: real Fastify+Postgres isn't worth spinning up for client rendering
 * assertions; backend behavior stays covered by real-DB tests elsewhere).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { DevIdentityPicker } from '../App.js';

const LEAGUE = { id: 'l1', name: 'Test Fantasy League 2026' };
const TEAMS = [
  { id: 't2', name: 'Beta Bears', draft_order: 2 },
  { id: 't1', name: 'Alpha Wolves', draft_order: 1 },
];

/** Queues the two fetches every render triggers: /auth/site then /auth/league/:id/teams. */
function queueBootstrapFetches(fetchMock: ReturnType<typeof vi.fn>, leagues: typeof LEAGUE[] = [LEAGUE]): void {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ leagues }),
  });
  if (leagues.length > 0) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ teams: TEAMS }),
    });
  }
}

describe('dev identity picker', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('test_dev_picker_renders_commissioner_and_teams_sorted_by_draft_order', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    queueBootstrapFetches(fetchMock);
    render(<DevIdentityPicker onAuth={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Commissioner' })).toBeTruthy();
    });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Alpha Wolves')).toBeLessThan(buttons.indexOf('Beta Bears'));
  });

  it('test_dev_picker_commissioner_click_signs_in_as_commissioner', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    queueBootstrapFetches(fetchMock);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: 'commish-jwt' }),
    });
    const onAuth = vi.fn();
    render(<DevIdentityPicker onAuth={onAuth} />);

    await waitFor(() => screen.getByRole('button', { name: 'Commissioner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commissioner' }));

    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'commish-jwt', role: 'COMMISSIONER', leagueId: 'l1' }),
      );
    });
  });

  it('test_dev_picker_team_click_signs_in_as_that_owner', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    queueBootstrapFetches(fetchMock);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: 'owner-jwt' }),
    });
    const onAuth = vi.fn();
    render(<DevIdentityPicker onAuth={onAuth} />);

    await waitFor(() => screen.getByRole('button', { name: 'Alpha Wolves' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Wolves' }));

    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'owner-jwt',
          role: 'OWNER',
          leagueId: 'l1',
          teamId: 't1',
          teamName: 'Alpha Wolves',
        }),
      );
    });
    // Confirm the request body actually carried this team's id, not a stale one.
    const lastCall = fetchMock.mock.calls[2] as [string, { body: string }];
    expect(JSON.parse(lastCall[1].body)).toEqual({ role: 'OWNER', team_id: 't1', password: 'team123!' });
  });

  it('test_dev_picker_shows_error_when_no_leagues_seeded', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    queueBootstrapFetches(fetchMock, []);
    render(<DevIdentityPicker onAuth={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/no leagues found/i)).toBeTruthy();
    });
  });

  it('test_dev_picker_shows_error_on_failed_signin', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    queueBootstrapFetches(fetchMock);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    render(<DevIdentityPicker onAuth={vi.fn()} />);

    await waitFor(() => screen.getByRole('button', { name: 'Commissioner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commissioner' }));

    await waitFor(() => {
      expect(screen.getByText(/sign-in failed/i)).toBeTruthy();
    });
  });
});
