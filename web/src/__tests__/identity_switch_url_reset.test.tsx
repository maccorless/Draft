/**
 * A stale deep-link path left in the browser URL from a previous identity
 * (e.g. a commissioner leaves the tab on /commissioner, logs out, and an
 * owner logs back in via the dev picker in the same tab) must not carry
 * over — otherwise the new auth token gets routed into a screen its role
 * can't use, and that screen's own auth guard surfaces as a raw error
 * (e.g. CommissionerRoute's dataset bootstrap failing with 403 for an
 * OWNER token). Sign-in must always land on "/" so the role-based redirect
 * picks the right screen for the identity that just signed in.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { App } from '../App.js';

const LEAGUE = { id: 'l1', name: 'Test Fantasy League 2026' };
const TEAMS = [{ id: 't1', name: 'Alpha Wolves', draft_order: 1 }];

function routedFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/auth/site' && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ leagues: [LEAGUE] }) });
    }
    if (url === `/auth/league/${LEAGUE.id}/teams` && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ teams: TEAMS }) });
    }
    if (url === `/auth/league/${LEAGUE.id}` && method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ token: 'owner-jwt' }) });
    }
    if (url === `/leagues/${LEAGUE.id}/drafts`) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ drafts: [] }) });
    }
    if (url === `/leagues/${LEAGUE.id}`) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    // A commissioner-only endpoint (e.g. dataset bootstrap) must never be
    // hit by the owner identity this test signs in as.
    if (url === `/leagues/${LEAGUE.id}/datasets`) {
      return Promise.resolve({ ok: false, status: 403 });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

describe('identity switch resets the URL', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/commissioner');
    global.fetch = routedFetchMock();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('test_owner_signin_from_stale_commissioner_path_lands_on_lobby_not_commissioner_console', async () => {
    render(<App />);

    await waitFor(() => screen.getByRole('button', { name: 'Alpha Wolves' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Wolves' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/lobby');
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const hitDatasetEndpoint = fetchMock.mock.calls.some(([u]) => u === `/leagues/${LEAGUE.id}/datasets`);
    expect(hitDatasetEndpoint).toBe(false);
  });
});
