/**
 * Logout control — fixed corner button present on every authenticated
 * screen, letting the user switch identities (e.g. Commissioner -> a
 * different team) without leaving the tab.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { LogoutButton } from '../App.js';

describe('logout button', () => {
  it('test_logout_button_shows_commissioner_identity', () => {
    render(
      <LogoutButton
        auth={{ token: 't', role: 'COMMISSIONER', leagueId: 'l1', leagueName: 'League One' }}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Commissioner')).toBeTruthy();
  });

  it('test_logout_button_shows_owner_team_name', () => {
    render(
      <LogoutButton
        auth={{
          token: 't',
          role: 'OWNER',
          leagueId: 'l1',
          leagueName: 'League One',
          teamId: 't1',
          teamName: 'Alpha Wolves',
        }}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Owner · Alpha Wolves')).toBeTruthy();
  });

  it('test_logout_button_click_calls_onLogout', () => {
    const onLogout = vi.fn();
    render(
      <LogoutButton
        auth={{ token: 't', role: 'COMMISSIONER', leagueId: 'l1', leagueName: 'League One' }}
        onLogout={onLogout}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
