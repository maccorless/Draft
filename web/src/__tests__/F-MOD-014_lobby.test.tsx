/**
 * F-MOD-014: Pre-Draft Lobby — a lightweight landing screen (readiness/status
 * messaging, team presentation media). Prep tools (Watch List, Nomination
 * Queue, Target Values, Auto-Agent, Do Not Draft, and the full player pool)
 * moved to the separate Draft Prep screen — see
 * F-MOD-014-rework-02_draft_prep.test.tsx. Primary navigation buttons
 * ("Draft Prep" / "Enter Draft Room" / "Open War Room") are rendered by the
 * caller (App.tsx's DraftGateway) — see F-MOD-014_enter_draft_room_link.test.tsx.
 *
 * jsdom component test — mocks global.fetch (see [[feedback-ui-test-mocking]]).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { Lobby } from '../screens/lobby/index.js';

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
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
    global.fetch = vi.fn(() => jsonResponse({ teams: [] })) as unknown as typeof fetch;
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

  it('test_F_MOD_014_lobby_mounts_team_media_upload_control', () => {
    render(<Lobby {...baseProps} />);
    expect(screen.getByLabelText('Team presentation media')).toBeTruthy();
  });
});
