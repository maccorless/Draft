/**
 * F-MOD-000: Lobby screen renders correctly
 *
 * Behavioral expectation: given an authenticated owner whose draft has not
 * started, when the Lobby screen loads, it displays the league name,
 * scheduled draft start time (or status messages), and the owner's team name.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Lobby } from '../screens/lobby/index.js';

describe('F-MOD-000 Lobby screen', () => {
  it('test_F_MOD_000_lobby_shows_league_name', () => {
    render(
      <Lobby
        leagueName="Test Fantasy League"
        teamName="Alpha Wolves"
        scheduledAt={null}
        draftStatus="CREATED"
      />,
    );
    expect(screen.getByText('Test Fantasy League')).toBeTruthy();
  });

  it('test_F_MOD_000_lobby_shows_team_name', () => {
    render(
      <Lobby
        leagueName="Test Fantasy League"
        teamName="Alpha Wolves"
        scheduledAt={null}
        draftStatus="CREATED"
      />,
    );
    expect(screen.getByText('Alpha Wolves')).toBeTruthy();
  });

  it('test_F_MOD_000_lobby_shows_not_yet_scheduled_when_no_time', () => {
    render(
      <Lobby
        leagueName="League"
        teamName="Team"
        scheduledAt={null}
        draftStatus="CREATED"
      />,
    );
    expect(screen.getByTestId('scheduled-time').textContent).toBe(
      'Not yet scheduled',
    );
  });

  it('test_F_MOD_000_lobby_shows_waiting_when_scheduled_time_passed', () => {
    // Scheduled time is in the past
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    render(
      <Lobby
        leagueName="League"
        teamName="Team"
        scheduledAt={pastTime}
        draftStatus="CREATED"
      />,
    );
    expect(screen.getByTestId('scheduled-time').textContent).toBe(
      'Waiting for commissioner to start',
    );
  });

  it('test_F_MOD_000_lobby_shows_formatted_time_when_in_future', () => {
    // Future scheduled time
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    render(
      <Lobby
        leagueName="League"
        teamName="Team"
        scheduledAt={futureTime}
        draftStatus="CREATED"
      />,
    );
    const timeText = screen.getByTestId('scheduled-time').textContent ?? '';
    // Should NOT be 'Not yet scheduled' or 'Waiting...'
    expect(timeText).not.toBe('Not yet scheduled');
    expect(timeText).not.toBe('Waiting for commissioner to start');
    expect(timeText.length).toBeGreaterThan(0);
  });

  it('test_F_MOD_000_lobby_renders_without_js_errors', () => {
    // All three render scenarios must not throw
    expect(() =>
      render(
        <Lobby
          leagueName="League"
          teamName="Team"
          scheduledAt={null}
          draftStatus="CREATED"
        />,
      ),
    ).not.toThrow();
  });
});
