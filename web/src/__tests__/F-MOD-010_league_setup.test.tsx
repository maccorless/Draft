/**
 * F-MOD-010: Commissioner League Setup UI.
 *
 * Uses @testing-library/react (jsdom). `global.fetch` is mocked per the
 * established UI-test convention (F-MOD-001/F-MOD-012) — no live server
 * needed for pure UI-behavior tests.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { LeagueSetup } from '../screens/commissioner/LeagueSetup.js';
import { CommissionerConsole } from '../screens/commissioner/index.js';

const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-commissioner';

const defaultLeague = {
  id: LEAGUE_ID,
  name: 'Test League',
  logo_url: null,
  name_lock: false,
  scheduled_draft_start_at: null,
  status_message: null,
};

const defaultTeams = [
  { id: 't1', name: 'Team One', draft_order: 1, icon_url: null, nomination_audio_url: null, starting_budget_override_minor: null, name_lock: false },
  { id: 't2', name: 'Team Two', draft_order: 2, icon_url: null, nomination_audio_url: null, starting_budget_override_minor: null, name_lock: false },
];

const defaultReadiness = {
  items: [
    { key: 'team_count', label: 'Team count', status: 'FAIL', detail: '2 of 12 teams' },
    { key: 'roster_config', label: 'Roster configuration', status: 'PASS', detail: null },
  ],
  all_ready: false,
};

interface RouteOverride {
  status: number;
  body: unknown;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function installFetchMock(overrides: Record<string, RouteOverride> = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    const key = `${method} ${url}`;
    if (overrides[key]) {
      const { status, body: respBody } = overrides[key];
      return jsonResponse(status, respBody);
    }
    if (url === `/leagues/${LEAGUE_ID}` && method === 'GET') return jsonResponse(200, defaultLeague);
    if (url === `/leagues/${LEAGUE_ID}/teams`) return jsonResponse(200, { teams: defaultTeams });
    if (url === `/leagues/${LEAGUE_ID}/players`) return jsonResponse(200, { players: [] });
    if (url === `/leagues/${LEAGUE_ID}/readiness`) return jsonResponse(200, defaultReadiness);
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + key });
  }) as unknown as typeof fetch;
  return { calls };
}

async function renderAndLoad(overrides: Record<string, RouteOverride> = {}): Promise<{ calls: FetchCall[] }> {
  const mock = installFetchMock(overrides);
  render(<LeagueSetup leagueId={LEAGUE_ID} token={TOKEN} datasetId="ds-1" />);
  await waitFor(() => expect((screen.getByLabelText('League name') as HTMLInputElement).value).toBe('Test League'));
  return mock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('F-MOD-010 CommissionerConsole wiring', () => {
  it('test_F_MOD_010_league_setup_section_replaces_coming_soon', async () => {
    installFetchMock();
    render(<CommissionerConsole leagueId={LEAGUE_ID} token={TOKEN} />);
    fireEvent.click(screen.getByTestId('nav-league-setup'));
    await waitFor(() => expect(screen.getByLabelText('League name')).toBeTruthy());
    expect(screen.queryByText(/isn.t built yet/i)).toBeNull();
  });
});

describe('F-MOD-010 League Identity', () => {
  it('test_F_MOD_010_identity_form_loads_current_values_and_submits_update', async () => {
    const { calls } = await renderAndLoad({
      'PUT /leagues/league-1': { status: 200, body: { ...defaultLeague, name: 'Renamed League', name_lock: true } },
    });

    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Renamed League' } });
    fireEvent.click(screen.getByLabelText('Lock league name'));
    fireEvent.click(screen.getByText('Save League Identity'));

    await waitFor(() => expect(screen.getByText('League updated')).toBeTruthy());
    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}` && c.method === 'PUT');
    expect(call).toBeTruthy();
    expect((call!.body as { name: string }).name).toBe('Renamed League');
    expect((call!.body as { name_lock: boolean }).name_lock).toBe(true);
  });

  it('test_F_MOD_010_status_message_cleared_sends_null', async () => {
    const { calls } = await renderAndLoad({
      'PUT /leagues/league-1': { status: 200, body: defaultLeague },
    });
    fireEvent.change(screen.getByLabelText(/Status message/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save League Identity'));
    await waitFor(() => expect(screen.getByText('League updated')).toBeTruthy());
    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}` && c.method === 'PUT');
    expect((call!.body as { status_message: string | null }).status_message).toBeNull();
  });
});

describe('F-MOD-010 Password Generation', () => {
  it('test_F_MOD_010_generate_password_shows_plaintext_once', async () => {
    await renderAndLoad({
      'POST /leagues/league-1/passwords/generate': {
        status: 200,
        body: { scope: 'COMMISSIONER', password: 'freshly-generated' },
      },
    });
    fireEvent.click(screen.getByText('Generate'));
    await waitFor(() => expect(screen.getByTestId('generated-password')).toBeTruthy());
    expect(screen.getByTestId('generated-password').textContent).toContain('freshly-generated');
  });
});

describe('F-MOD-010 Team Roster', () => {
  it('test_F_MOD_010_team_budget_override_submits_on_blur', async () => {
    const { calls } = await renderAndLoad({
      'PUT /leagues/league-1/teams/t1': { status: 200, body: { ...defaultTeams[0], starting_budget_override_minor: 15000 } },
    });
    const input = screen.getByLabelText('Starting budget override for Team One');
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}/teams/t1` && c.method === 'PUT');
      expect(call).toBeTruthy();
    });
    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}/teams/t1`)!;
    expect((call.body as { starting_budget_override_minor: number }).starting_budget_override_minor).toBe(15000);
  });
});

describe('F-MOD-010 Readiness Checklist', () => {
  it('test_F_MOD_010_readiness_renders_pass_fail_rows', async () => {
    await renderAndLoad();
    await waitFor(() => expect(screen.getByText('Team count')).toBeTruthy());
    expect(screen.getByText('NOT READY')).toBeTruthy();
    expect(screen.getAllByText('FAIL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PASS').length).toBeGreaterThan(0);
  });
});
