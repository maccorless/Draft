/**
 * Stale-session handling: a 404 from the league-scoped bootstrap calls in
 * CommissionerRoute/DraftGateway means the session's leagueId no longer
 * exists (e.g. a dev-seed reseed generated a fresh league) — rather than
 * dead-ending on a raw error, the app logs out so the user lands back on
 * sign-in and can pick up the current league immediately.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { CommissionerRoute, DraftGateway } from '../App.js';

const AUTH_COMMISSIONER = {
  token: 't',
  role: 'COMMISSIONER' as const,
  leagueId: 'stale-league',
  leagueName: 'Stale League',
};
const AUTH_OWNER = {
  token: 't',
  role: 'OWNER' as const,
  leagueId: 'stale-league',
  leagueName: 'Stale League',
  teamId: 'team-1',
  teamName: 'My Team',
};

describe('stale session handling', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('test_commissioner_route_logs_out_on_404_creating_dataset', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 });
    const onStaleSession = vi.fn();
    render(<CommissionerRoute auth={AUTH_COMMISSIONER} onStaleSession={onStaleSession} />);

    await waitFor(() => {
      expect(onStaleSession).toHaveBeenCalledTimes(1);
    });
  });

  it('test_draft_gateway_logs_out_on_404_loading_drafts', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 });
    const onStaleSession = vi.fn();
    render(<DraftGateway auth={AUTH_OWNER} onStaleSession={onStaleSession} />);

    await waitFor(() => {
      expect(onStaleSession).toHaveBeenCalledTimes(1);
    });
  });
});
