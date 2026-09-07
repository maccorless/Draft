/**
 * F-MOD-014-rework-01 gap-review item 4: DraftGateway previously only ever
 * put an owner into Draft Room via the automatic RUNNING/PAUSED redirect —
 * there was no manual entry point while a draft exists but hasn't started
 * (CREATED). This tests the added "Enter Draft Room" link.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { DraftGateway } from '../App.js';

const AUTH = {
  token: 't',
  role: 'OWNER' as const,
  leagueId: 'league-1',
  leagueName: 'Test League',
  teamId: 'team-1',
  teamName: 'My Team',
};

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

describe('F-MOD-014 Enter Draft Room link', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('test_F_MOD_014_enter_draft_room_link_present_for_created_draft', async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/drafts') && !url.includes('teams')) return jsonResponse({ drafts: [{ id: 'draft-1', status: 'CREATED' }] });
      if (url.endsWith('/leagues/league-1')) return jsonResponse({ status_message: null, scheduled_draft_start_at: null });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<DraftGateway auth={AUTH} onStaleSession={vi.fn()} />);

    const link = await waitFor(() => screen.getByText('Enter Draft Room') as HTMLAnchorElement);
    expect(link.getAttribute('href')).toBe('/draft-room?draftId=draft-1');
    expect(screen.getByText('Open War Room ↗')).toBeTruthy();

    const prepLink = screen.getByText('Draft Prep') as HTMLAnchorElement;
    expect(prepLink.getAttribute('href')).toBe('/draft-prep?draftId=draft-1');
  });

  it('test_F_MOD_014_enter_draft_room_link_absent_when_no_active_draft', async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/drafts') && !url.includes('teams')) return jsonResponse({ drafts: [] });
      if (url.endsWith('/leagues/league-1')) return jsonResponse({ status_message: null, scheduled_draft_start_at: null });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<DraftGateway auth={AUTH} onStaleSession={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Test League')).toBeTruthy());
    expect(screen.queryByText('Enter Draft Room')).toBeNull();
    expect(screen.queryByText('Open War Room ↗')).toBeNull();
    expect(screen.queryByText('Draft Prep')).toBeNull();
  });
});
