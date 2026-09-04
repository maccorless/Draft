/**
 * F-MOD-013: Draft Summary Report routing.
 *
 * global.fetch is mocked the same way F-MOD-001/F-MOD-012's tests do (no live
 * server needed for pure UI-behavior tests) — see [[feedback-ui-test-mocking]].
 * Draft Room / War Room also open a live auction WebSocket; jsdom has no real
 * WS server to connect to, so global.WebSocket is stubbed with a minimal fake
 * that lets a test push a DRAFT_COMPLETE (or STATE_SNAPSHOT) frame at it —
 * the true system boundary here is the live draft-engine WS server.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { App } from '../App.js';
import { DraftRoom } from '../screens/draft-room/index.js';
import { WarRoom } from '../screens/war-room/index.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-owner';
const TEAM_ID = 't1';

const completeReport = {
  draft_id: DRAFT_ID,
  completed_at: new Date().toISOString(),
  teams: [
    {
      team_id: TEAM_ID,
      team_name: 'Alpha',
      final_budget_minor: 48000,
      acquisitions: [{ player_name: 'Player A', position: 'QB', price_minor: 2000, roster_slot: 'QB' }],
      projected_starter_points: 20,
      roster_depth_score: { value: 8, calculation_version: 'v1' },
      aav_efficiency_pct: 28.57,
    },
    {
      team_id: 't2',
      team_name: 'Beta',
      final_budget_minor: 48500,
      acquisitions: [{ player_name: 'Player B', position: 'QB', price_minor: 1500, roster_slot: 'QB' }],
      projected_starter_points: 15,
      roster_depth_score: { value: 0, calculation_version: 'v1' },
      aav_efficiency_pct: -7.14,
    },
  ],
  league_totals: { spend_minor: 3500, aav_minor: 3900 },
};

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  push(msg: { type: string; payload?: Record<string, unknown> }): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

/** A stand-in for the real /draft-complete route (App.tsx wires DraftCompleteRoute
 * there) — what's under test here is that DraftRoom/WarRoom navigate to that path
 * with the right draftId, not what the report screen itself renders. */
function DraftCompleteMarker(): React.ReactElement {
  return <p>Draft Complete Marker</p>;
}

describe('F-MOD-013 draft-complete navigation and routing', () => {
  it('F_MOD_013_draft_room_navigates_to_draft_complete_on_broadcast', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.endsWith('/config')) return jsonResponse(200, { roster: null, roster_slots: [], auction: null });
      if (url.endsWith('/players')) return jsonResponse(200, { players: [] });
      if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: [] });
      if (url.includes('/report')) return jsonResponse(200, completeReport);
      return jsonResponse(404, { code: 'NOT_FOUND' });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={[`/draft-room?draftId=${DRAFT_ID}`]}>
        <Routes>
          <Route path="/draft-room" element={<DraftRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
          <Route path="/draft-complete" element={<DraftCompleteMarker />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.onopen?.();
    ws.push({ type: 'STATE_SNAPSHOT', payload: { teams: [], current_auction: null, status: 'RUNNING', as_of_sequence: 1 } });

    // Live DRAFT_COMPLETE broadcast while the client is already on Draft Room.
    ws.push({ type: 'DRAFT_COMPLETE', payload: { draft_id: DRAFT_ID } });

    await waitFor(() => expect(screen.getByText('Draft Complete Marker')).toBeTruthy());
  });

  it('F_MOD_013_war_room_navigates_to_draft_complete_on_broadcast', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.endsWith('/config')) return jsonResponse(200, { roster_slots: [] });
      if (url.endsWith('/players')) return jsonResponse(200, { players: [] });
      if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: [] });
      if (url.endsWith('/activity')) return jsonResponse(200, { recent: [] });
      if (url.includes('/report')) return jsonResponse(200, completeReport);
      return jsonResponse(404, { code: 'NOT_FOUND' });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={[`/war-room?draftId=${DRAFT_ID}`]}>
        <Routes>
          <Route path="/war-room" element={<WarRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
          <Route path="/draft-complete" element={<DraftCompleteMarker />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.onopen?.();
    ws.push({ type: 'STATE_SNAPSHOT', payload: { teams: [], current_auction: null, status: 'RUNNING', as_of_sequence: 1 } });
    ws.push({ type: 'DRAFT_COMPLETE', payload: { draft_id: DRAFT_ID } });

    await waitFor(() => expect(screen.getByText('Draft Complete Marker')).toBeTruthy());
  });

  it('F_MOD_013_draft_room_reconnect_snapshot_already_complete_routes_away', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.endsWith('/config')) return jsonResponse(200, { roster: null, roster_slots: [], auction: null });
      if (url.endsWith('/players')) return jsonResponse(200, { players: [] });
      if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: [] });
      if (url.includes('/report')) return jsonResponse(200, completeReport);
      return jsonResponse(404, { code: 'NOT_FOUND' });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={[`/draft-room?draftId=${DRAFT_ID}`]}>
        <Routes>
          <Route path="/draft-room" element={<DraftRoom draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} teamId={TEAM_ID} />} />
          <Route path="/draft-complete" element={<DraftCompleteMarker />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.onopen?.();
    // A client reconnecting after completion receives draftStatus: 'COMPLETE'
    // directly in its snapshot — no separate DRAFT_COMPLETE broadcast needed.
    ws.push({ type: 'STATE_SNAPSHOT', payload: { teams: [], current_auction: null, status: 'COMPLETE', as_of_sequence: 9 } });

    await waitFor(() => expect(screen.getByText('Draft Complete Marker')).toBeTruthy());
  });

  it('F_MOD_013_fresh_session_against_complete_draft_routes_to_draft_complete_not_lobby', async () => {
    sessionStorage.setItem(
      'draft.auth',
      JSON.stringify({
        token: TOKEN,
        role: 'OWNER',
        leagueId: LEAGUE_ID,
        leagueName: 'Test League',
        teamId: TEAM_ID,
        teamName: 'Alpha',
      }),
    );

    global.fetch = vi.fn((url: string) => {
      if (url.endsWith(`/leagues/${LEAGUE_ID}/drafts`)) {
        return jsonResponse(200, { drafts: [{ id: DRAFT_ID, status: 'COMPLETE' }] });
      }
      if (url.includes('/report')) return jsonResponse(200, completeReport);
      return jsonResponse(404, { code: 'NOT_FOUND' });
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(screen.getByText('Draft Complete')).toBeTruthy());
    // Never landed on the Pre-Draft Lobby along the way.
    expect(screen.queryByText('Not yet scheduled')).toBeNull();

    sessionStorage.clear();
  });
});
