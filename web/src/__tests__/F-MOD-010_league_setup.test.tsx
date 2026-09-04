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
    // Load with a league that already has a status message set — clearing an
    // already-empty field is correctly a no-op now that Save is dirty-gated.
    const { calls } = await renderAndLoad({
      'GET /leagues/league-1': { status: 200, body: { ...defaultLeague, status_message: 'Draft starts Sunday' } },
      'PUT /leagues/league-1': { status: 200, body: defaultLeague },
    });
    await waitFor(() => expect((screen.getByLabelText(/Status message/) as HTMLTextAreaElement).value).toBe('Draft starts Sunday'));
    fireEvent.change(screen.getByLabelText(/Status message/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save League Identity'));
    await waitFor(() => expect(screen.getByText('League updated')).toBeTruthy());
    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}` && c.method === 'PUT');
    expect((call!.body as { status_message: string | null }).status_message).toBeNull();
  });

  it('test_F_MOD_010_identity_save_button_disabled_until_dirty_and_after_save', async () => {
    await renderAndLoad({
      'PUT /leagues/league-1': { status: 200, body: { ...defaultLeague, name: 'Renamed League' } },
    });
    const saveButton = screen.getByText('Save League Identity') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Renamed League' } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByText('League updated')).toBeTruthy());
    expect(saveButton.disabled).toBe(true);
  });
});

describe('F-MOD-010 Roster Configuration', () => {
  it('test_F_MOD_010_roster_config_loads_saved_slots_as_dropdowns_no_starter_checkbox', async () => {
    await renderAndLoad({
      'GET /leagues/league-1/config/roster': {
        status: 200,
        body: {
          bench_slots: 7,
          slots: [
            { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
            { position: 'SUPERFLEX', priority: 2, is_starter: true, slot_count: 1 },
          ],
        },
      },
    });
    await waitFor(() => expect((screen.getByLabelText('Bench slots') as HTMLInputElement).value).toBe('7'));
    const positionSelects = screen.getAllByLabelText('Position') as HTMLSelectElement[];
    expect(positionSelects.map((s) => s.value)).toEqual(['QB', 'SUPERFLEX']);
    // No per-row Starter checkbox anymore — every row is a starter by definition.
    expect(screen.queryByText('Starter')).toBeNull();
    // Save is clean immediately after loading already-saved data.
    expect((screen.getByText('Save Roster Configuration') as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_010_roster_config_save_button_dirty_tracking', async () => {
    const { calls } = await renderAndLoad({
      'GET /leagues/league-1/config/roster': {
        status: 200,
        body: { bench_slots: 7, slots: [{ position: 'QB', priority: 1, is_starter: true, slot_count: 1 }] },
      },
      'PUT /leagues/league-1/config/roster': { status: 200, body: {} },
    });
    const saveButton = screen.getByText('Save Roster Configuration') as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    fireEvent.change(screen.getByLabelText('Bench slots'), { target: { value: '8' } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByText('Roster configuration saved')).toBeTruthy());
    expect(saveButton.disabled).toBe(true);

    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}/config/roster` && c.method === 'PUT');
    expect((call!.body as { bench_slots: number }).bench_slots).toBe(8);
  });
});

describe('F-MOD-010 Auction Configuration', () => {
  it('test_F_MOD_010_auction_config_loads_saved_values_instead_of_defaults', async () => {
    await renderAndLoad({
      'GET /leagues/league-1/config/auction': {
        status: 200,
        body: {
          initial_budget_minor: 25000,
          nomination_timer_ms: 60000,
          second_bid_timer_ms: 20000,
          rebid_timer_ms: 12000,
          anti_snipe_threshold_ms: 5000,
          anti_snipe_extension_ms: 10000,
        },
      },
    });
    await waitFor(() => expect((screen.getByLabelText('Starting budget ($)') as HTMLInputElement).value).toBe('250'));
    expect((screen.getByLabelText('Nomination timer (s)') as HTMLInputElement).value).toBe('60');
    // Reflects the saved value, not the component's hardcoded '200'/'30' defaults —
    // this is the persistence bug: without a GET, a save would look like it never took.
    expect((screen.getByText('Save Auction Configuration') as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_010_auction_config_save_button_dirty_tracking', async () => {
    const { calls } = await renderAndLoad({
      'PUT /leagues/league-1/config/auction': { status: 200, body: {} },
    });
    const saveButton = screen.getByText('Save Auction Configuration') as HTMLButtonElement;
    // No saved config yet (mocked GET falls through to the generic 404) —
    // stays enabled rather than comparing against nothing.
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByText('Auction configuration saved')).toBeTruthy());
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Starting budget ($)'), { target: { value: '300' } });
    expect(saveButton.disabled).toBe(false);

    const call = calls.find((c) => c.url === `/leagues/${LEAGUE_ID}/config/auction` && c.method === 'PUT');
    expect((call!.body as { initial_budget_minor: number }).initial_budget_minor).toBe(20000);
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
