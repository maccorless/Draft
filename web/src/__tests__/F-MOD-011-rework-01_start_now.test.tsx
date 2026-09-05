/**
 * F-MOD-011-rework-01 (UF-17-01): "Start Now" control on the Commissioner
 * Draft Control panel.
 *
 * Uses @testing-library/react (jsdom). `global.fetch` is mocked the same way
 * F-MOD-001's and F-MOD-012's tests do (see
 * feedback_ui_test_mocking.md — pure UI-behavior tests don't need a live
 * Fastify+Postgres server; the endpoint itself, POST /drafts/:id/start, is
 * already covered by MOD-002's own suite). DraftControl also opens a live
 * auction WebSocket via useAuctionSocket — jsdom has no real WS server to
 * connect to, so `global.WebSocket` is stubbed with a minimal fake, the true
 * system boundary here, per the "mock only at true boundaries" guidance.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { DraftControl } from '../screens/commissioner/DraftControl.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-commissioner';

interface RouteOverride {
  status: number;
  body: unknown;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

/**
 * A mutable `state.status` backs the /health route so that, like the real
 * server, calling POST /start actually flips the status the next /health
 * poll reports back — rather than a fetch mock frozen at render time.
 */
function installFetchMock(
  overrides: Record<string, RouteOverride> = {},
  initialStatus = 'CREATED',
): { calls: FetchCall[]; state: { status: string } } {
  const calls: FetchCall[] = [];
  const state = { status: initialStatus };
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });

    const key = `${method} ${url}`;
    if (overrides[key]) {
      const { status, body: respBody } = overrides[key];
      return jsonResponse(status, respBody);
    }
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: [] });
    if (url.endsWith('/audit-log')) return jsonResponse(200, { entries: [] });
    if (url.endsWith('/players')) return jsonResponse(200, { players: [] });
    if (url.endsWith('/health')) {
      return jsonResponse(200, {
        status: state.status,
        round_or_cycle: null,
        auctions_completed: 0,
        current_player_auction_id: null,
        current_deadline_at: null,
        connected_team_count: 0,
        auto_agent_team_count: 0,
        reconnecting_team_count: 0,
        warnings: [],
      });
    }
    if (url.endsWith('/start')) {
      state.status = 'RUNNING';
      return jsonResponse(200, {});
    }
    if (url.endsWith('/pause') || url.endsWith('/resume')) return jsonResponse(200, {});
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + key });
  }) as unknown as typeof fetch;
  return { calls, state };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

async function renderAndLoad(
  overrides: Record<string, RouteOverride> = {},
  healthStatus = 'CREATED',
): Promise<{ calls: FetchCall[]; state: { status: string } }> {
  const mock = installFetchMock(overrides, healthStatus);
  render(<DraftControl draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);
  await waitFor(() => expect(screen.getByTestId('health-status')).toBeTruthy());
  return mock;
}

describe('F-MOD-011-rework-01 Start Now control', () => {
  it('test_F_MOD_011_rework_01_start_now_visible_and_enabled_when_status_created', async () => {
    await renderAndLoad({}, 'CREATED');
    const button = screen.getByTestId('start-now-button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);
  });

  it('test_F_MOD_011_rework_01_start_now_hidden_when_status_not_created', async () => {
    await renderAndLoad({}, 'RUNNING');
    expect(screen.queryByTestId('start-now-button')).toBeNull();
  });

  it('test_F_MOD_011_rework_01_start_now_calls_start_endpoint_and_refreshes_to_running', async () => {
    const { calls } = await renderAndLoad({}, 'CREATED');
    fireEvent.click(screen.getByTestId('start-now-button'));

    await waitFor(() => expect(calls.find((c) => c.url === `/drafts/${DRAFT_ID}/start`)).toBeTruthy());
    const call = calls.find((c) => c.url === `/drafts/${DRAFT_ID}/start`)!;
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer tok-commissioner');

    // The mock's /start route flips its backing state.status to RUNNING (like
    // the real server does); the component's post-start refreshHealth() call
    // then picks that up on its next /health poll.
    await waitFor(() => expect(screen.getByTestId('health-status').textContent).toBe('RUNNING'));
    expect(screen.queryByTestId('start-now-button')).toBeNull();
  });

  it('test_F_MOD_011_rework_01_start_now_clicking_when_not_created_is_a_no_op', async () => {
    const { calls } = await renderAndLoad({}, 'RUNNING');
    expect(screen.queryByTestId('start-now-button')).toBeNull();
    // Nothing to click, but confirm no start request was ever issued as a
    // side effect of rendering the (not-CREATED) Draft Control section.
    expect(calls.find((c) => c.url === `/drafts/${DRAFT_ID}/start`)).toBeUndefined();
  });
});
