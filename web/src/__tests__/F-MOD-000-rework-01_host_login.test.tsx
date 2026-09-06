/**
 * F-MOD-000-rework-01: Host role in league login. The backend's
 * POST /auth/league/:id already accepts role: "HOST" (server/src/auth/routes.ts);
 * the gap was purely frontend — LeagueLogin's role <select> only offered
 * COMMISSIONER/OWNER. Jsdom component test — mocks global.fetch (see
 * [[feedback-ui-test-mocking]] memory: real Fastify+Postgres isn't worth
 * spinning up for client rendering assertions).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { LeagueLogin, LogoutButton } from '../App.js';

const LEAGUE = { id: 'l1', name: 'Test Fantasy League 2026' };

describe('host role in league login', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('test_F-MOD-000-rework-01_league_login_offers_host_role_option', () => {
    render(<LeagueLogin leagues={[LEAGUE]} sitePass="pw" onAuth={vi.fn()} />);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('HOST');
  });

  it('test_F-MOD-000-rework-01_host_login_submits_role_host_and_calls_onAuth', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: 'host-jwt' }),
    });
    const onAuth = vi.fn();
    render(<LeagueLogin leagues={[LEAGUE]} sitePass="pw" onAuth={onAuth} />);

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'HOST' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hostpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'host-jwt', role: 'HOST', leagueId: 'l1' }),
      );
    });

    const call = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({ role: 'HOST', password: 'hostpass' });
  });

  it('test_F-MOD-000-rework-01_logout_button_shows_host_identity', () => {
    render(
      <LogoutButton
        auth={{ token: 't', role: 'HOST', leagueId: 'l1', leagueName: 'League One' }}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Host')).toBeTruthy();
  });
});
