/**
 * F-MOD-012: Commissioner Corrections, Rollback, and Whammy UI.
 *
 * Uses @testing-library/react (jsdom). `global.fetch` is mocked the same
 * way F-MOD-001's test does (no live server needed for pure UI-behavior
 * tests). The rollback re-apply assist's nomination step opens a one-shot
 * WebSocket (see Corrections.tsx's sendNominateOnBehalf) — jsdom has no
 * real WS server to connect to, so `global.WebSocket` is stubbed with a
 * minimal fake that records sent frames and exposes its onopen hook, which
 * is the true system boundary here (a live draft-engine WS server), per
 * the "mock only at true boundaries" guidance.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { Corrections } from '../screens/commissioner/Corrections.js';
import { CommissionerConsole } from '../screens/commissioner/index.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-commissioner';

const defaultTeams = [
  { team_id: 't1', team_name: 'Team One', remaining_budget_minor: 10000 },
  { team_id: 't2', team_name: 'Team Two', remaining_budget_minor: 8000 },
];

const defaultPicks = [
  { acquisition_id: 'a3', player_name: 'Player C', position: 'RB', price_minor: 500, resolution_sequence: 18, team_id: 't1', team_name: 'Team One' },
  { acquisition_id: 'a2', player_name: 'Player B', position: 'WR', price_minor: 300, resolution_sequence: 11, team_id: 't2', team_name: 'Team Two' },
  { acquisition_id: 'a1', player_name: 'Player A', position: 'QB', price_minor: 200, resolution_sequence: 10, team_id: 't1', team_name: 'Team One' },
];

const defaultPlayers = [
  { dataset_entry_id: 'p1', name: 'Player A', position: 'QB' },
  { dataset_entry_id: 'p2', name: 'Player B', position: 'WR' },
  { dataset_entry_id: 'p3', name: 'Player C', position: 'RB' },
];

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

function installFetchMock(overrides: Record<string, RouteOverride> = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
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
    if (url.endsWith('/roster-grid')) return jsonResponse(200, { teams: defaultTeams });
    if (url.endsWith('/activity')) return jsonResponse(200, { recent: defaultPicks });
    if (url.endsWith('/health')) return jsonResponse(200, { status: 'RUNNING' });
    if (url.endsWith('/players')) return jsonResponse(200, { players: defaultPlayers });
    if (url.endsWith('/pause') || url.endsWith('/resume')) return jsonResponse(200, {});
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not mocked: ' + key });
  }) as unknown as typeof fetch;
  return { calls };
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

async function renderAndLoad(overrides: Record<string, RouteOverride> = {}): Promise<{ calls: FetchCall[] }> {
  const mock = installFetchMock(overrides);
  render(<Corrections draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);
  await waitFor(() => expect(screen.getByTestId('correction-acquisition-select')).toBeTruthy());
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));
  return mock;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

// ── Console wiring ────────────────────────────────────────────────────────────

describe('F-MOD-012 CommissionerConsole wiring', () => {
  it('test_F_MOD_012_corrections_section_replaces_coming_soon', async () => {
    installFetchMock();
    render(
      <CommissionerConsole leagueId={LEAGUE_ID} token={TOKEN} draftId={DRAFT_ID} />,
    );
    fireEvent.click(screen.getByTestId('nav-corrections'));
    await waitFor(() => expect(screen.getByTestId('correction-form')).toBeTruthy());
    expect(screen.queryByText(/isn.t built yet/i)).toBeNull();
    expect(screen.getByTestId('whammy-form')).toBeTruthy();
  });
});

// ── Price correction ──────────────────────────────────────────────────────────

describe('F-MOD-012 Price Correction', () => {
  it('test_F_MOD_012_correction_form_shows_old_new_delta_and_remaining_before_submit', async () => {
    await renderAndLoad();
    fireEvent.change(screen.getByTestId('correction-acquisition-select'), { target: { value: 'a3' } });
    expect(screen.getByTestId('correction-old-price').textContent).toContain('$5');
    fireEvent.change(screen.getByTestId('correction-new-price-input'), { target: { value: '3' } });
    expect(screen.getByTestId('correction-new-price-value').textContent).toContain('$3');
    expect(screen.getByTestId('correction-delta').textContent).toContain('$2');
    expect(screen.getByTestId('correction-remaining').textContent).toContain('$102');
  });

  it('test_F_MOD_012_correction_submit_calls_endpoint_and_shows_result_on_200', async () => {
    const { calls } = await renderAndLoad({
      'POST /drafts/draft-1/corrections/price': {
        status: 200,
        body: { acquisition_id: 'a3', old_price_minor: 500, new_price_minor: 300, team_id: 't1', new_remaining_budget_minor: 10200 },
      },
    });
    fireEvent.change(screen.getByTestId('correction-acquisition-select'), { target: { value: 'a3' } });
    fireEvent.change(screen.getByTestId('correction-new-price-input'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('correction-submit'));

    await waitFor(() => expect(screen.getByTestId('correction-result')).toBeTruthy());
    expect(screen.getByTestId('correction-result').textContent).toContain('$5');
    expect(screen.getByTestId('correction-result').textContent).toContain('$3');
    expect(screen.getByTestId('correction-result').textContent).toContain('$102');

    const call = calls.find((c) => c.url === '/drafts/draft-1/corrections/price');
    expect(call).toBeTruthy();
    expect(call!.body).toEqual({ acquisition_id: 'a3', new_price_minor: 300 });
    expect(call!.headers['authorization']).toBe('Bearer tok-commissioner');
  });

  it('test_F_MOD_012_correction_409_shows_refusal_and_rollback_instead_opens_rollback_panel', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/corrections/price': {
        status: 409,
        body: { code: 'CORRECTION_ILLEGAL', message: 'Corrected price would make a later pick illegal' },
      },
    });
    fireEvent.change(screen.getByTestId('correction-acquisition-select'), { target: { value: 'a2' } });
    fireEvent.change(screen.getByTestId('correction-new-price-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('correction-submit'));

    await waitFor(() => expect(screen.getByTestId('correction-error')).toBeTruthy());
    expect(screen.getByTestId('correction-error').textContent).toContain('Corrected price would make a later pick illegal');

    fireEvent.click(screen.getByTestId('correction-rollback-instead'));
    await waitFor(() => expect(screen.getByTestId('rollback-preview')).toBeTruthy());
    // a2 is the 2nd item in the desc-ordered picks list -> count should target it
    expect(screen.getByTestId('rollback-preview-statement').textContent).toContain('#18 through #11');
  });

  it('test_F_MOD_012_wrong_winner_affordance_opens_rollback_panel_without_correcting', async () => {
    const { calls } = await renderAndLoad();
    fireEvent.change(screen.getByTestId('correction-acquisition-select'), { target: { value: 'a1' } });
    fireEvent.click(screen.getByTestId('correction-rollback-instead-direct'));

    await waitFor(() => expect(screen.getByTestId('rollback-preview')).toBeTruthy());
    expect(calls.find((c) => c.url === '/drafts/draft-1/corrections/price')).toBeUndefined();
  });
});

// ── Rollback ───────────────────────────────────────────────────────────────────

describe('F-MOD-012 Rollback', () => {
  it('test_F_MOD_012_rollback_preview_shows_cost_statement_and_per_pick_detail', async () => {
    await renderAndLoad();
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '2' } });

    expect(screen.getByTestId('rollback-preview-statement').textContent).toBe(
      'This will undo picks #18 through #11 (2 players). Those players return to the pool.',
    );
    const list = within(screen.getByTestId('rollback-preview-list'));
    expect(list.getByText(/Player C/)).toBeTruthy();
    expect(list.getByText(/Player B/)).toBeTruthy();
    expect(list.queryByText(/Player A/)).toBeNull();
  });

  it('test_F_MOD_012_rollback_pauses_draft_first_when_not_paused', async () => {
    const { calls } = await renderAndLoad({
      'POST /drafts/draft-1/rollback': {
        status: 200,
        body: { rolled_back: 1, picks_reversed: [{ acquisition_id: 'a3', player_name: 'Player C', team_id: 't1', price_minor: 500 }] },
      },
    });
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => expect(screen.getByTestId('rollback-reapply-list')).toBeTruthy());
    const pauseIdx = calls.findIndex((c) => c.url === '/drafts/draft-1/pause');
    const rollbackIdx = calls.findIndex((c) => c.url === '/drafts/draft-1/rollback');
    expect(pauseIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(pauseIdx);
  });

  it('test_F_MOD_012_rollback_does_not_pause_when_already_paused', async () => {
    const { calls } = await renderAndLoad({
      'GET /drafts/draft-1/health': { status: 200, body: { status: 'PAUSED' } },
      'POST /drafts/draft-1/rollback': {
        status: 200,
        body: { rolled_back: 1, picks_reversed: [{ acquisition_id: 'a3', player_name: 'Player C', team_id: 't1', price_minor: 500 }] },
      },
    });
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => expect(screen.getByTestId('rollback-reapply-list')).toBeTruthy());
    expect(calls.find((c) => c.url === '/drafts/draft-1/pause')).toBeUndefined();
  });

  it('test_F_MOD_012_rollback_200_shows_reapply_assist_oldest_first_with_first_editable', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/rollback': {
        status: 200,
        body: {
          rolled_back: 2,
          picks_reversed: [
            { acquisition_id: 'a3', player_name: 'Player C', team_id: 't1', price_minor: 500 },
            { acquisition_id: 'a2', player_name: 'Player B', team_id: 't2', price_minor: 300 },
          ],
        },
      },
    });
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => expect(screen.getByTestId('rollback-reapply-list')).toBeTruthy());
    // oldest-first: Player B (a2) came before Player C (a3) chronologically (lower resolution_sequence)
    const item0 = screen.getByTestId('rollback-reapply-item-0');
    expect(within(item0).getByTestId('reapply-team-select')).toBeTruthy();
    expect(within(item0).getByTestId('reapply-player-select')).toBeTruthy();
    expect((within(item0).getByTestId('reapply-price-input') as HTMLInputElement).value).toBe('3');

    const item1 = screen.getByTestId('rollback-reapply-item-1');
    expect(within(item1).getByText(/Player C/)).toBeTruthy();
    expect(within(item1).queryByTestId('reapply-team-select')).toBeNull();
  });

  it('test_F_MOD_012_rollback_409_shows_inline_error_no_side_effect', async () => {
    const { calls } = await renderAndLoad({
      'GET /drafts/draft-1/health': { status: 200, body: { status: 'PAUSED' } },
      'POST /drafts/draft-1/rollback': {
        status: 409,
        body: { code: 'NO_PICKS_TO_ROLLBACK', message: 'No active picks to roll back' },
      },
    });
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => expect(screen.getByTestId('rollback-error')).toBeTruthy());
    expect(screen.getByTestId('rollback-error').textContent).toContain('No active picks to roll back');
    expect(screen.queryByTestId('rollback-reapply-list')).toBeNull();
    expect(calls.find((c) => c.url === '/drafts/draft-1/pause')).toBeUndefined();
  });

  it('test_F_MOD_012_reapply_reward_sends_nomination_on_behalf_of_team_with_bearer_token', async () => {
    await renderAndLoad({
      'GET /drafts/draft-1/health': { status: 200, body: { status: 'PAUSED' } },
      'POST /drafts/draft-1/rollback': {
        status: 200,
        body: {
          rolled_back: 1,
          picks_reversed: [{ acquisition_id: 'a1', player_name: 'Player A', team_id: 't1', price_minor: 200 }],
        },
      },
    });
    fireEvent.change(screen.getByTestId('rollback-count-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('rollback-confirm'));
    await waitFor(() => expect(screen.getByTestId('rollback-reapply-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('rollback-reapply-reward-0'));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    FakeWebSocket.instances[0]!.onopen?.();

    await waitFor(() => expect(FakeWebSocket.instances[0]!.sent.length).toBe(2));
    const authFrame = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!);
    expect(authFrame).toEqual({ type: 'AUTHENTICATE', payload: { token: TOKEN, last_seen_sequence: -1 } });
    const nominateFrame = JSON.parse(FakeWebSocket.instances[0]!.sent[1]!);
    expect(nominateFrame).toEqual({
      type: 'NOMINATE_COMMAND',
      payload: { player_dataset_entry_id: 'p1', opening_bid_minor: 200, on_behalf_of_team_id: 't1' },
    });

    await waitFor(() => expect(screen.getByTestId('rollback-reapply-reward-0').textContent).toBe('Re-awarded'));
  });
});

// ── Whammy ─────────────────────────────────────────────────────────────────────

describe('F-MOD-012 Whammy', () => {
  it('test_F_MOD_012_whammy_immediate_apply_shows_confirmation_and_updates_budget', async () => {
    const { calls } = await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { team_id: 't1', amount_minor: -500, new_remaining_budget_minor: 9500 },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't1' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '-5' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Bad trade tax' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));

    await waitFor(() => expect(screen.getByTestId('whammy-applied')).toBeTruthy());
    expect(screen.getByTestId('whammy-applied').textContent).toContain('$95');

    const call = calls.find((c) => c.url === '/drafts/draft-1/whammy');
    expect(call!.body).toEqual({ team_id: 't1', amount_minor: -500, description: 'Bad trade tax' });
    expect(call!.headers['authorization']).toBe('Bearer tok-commissioner');
  });

  it('test_F_MOD_012_whammy_pending_approval_adds_to_pending_list', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: 1000 },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Lucky bonus' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));

    await waitFor(() => expect(screen.getByTestId('whammy-pending-list')).toBeTruthy());
    expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy();
    expect(screen.queryByTestId('whammy-applied')).toBeNull();
  });

  it('test_F_MOD_012_whammy_approve_removes_from_pending_and_shows_applied', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: 1000 },
      },
      'POST /drafts/draft-1/whammy/w1/approve': {
        status: 200,
        body: { team_id: 't2', amount_minor: 1000, new_remaining_budget_minor: 9000 },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Lucky bonus' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));
    await waitFor(() => expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('whammy-approve-w1'));

    await waitFor(() => expect(screen.queryByTestId('whammy-pending-item-w1')).toBeNull());
    expect(screen.getByTestId('whammy-applied').textContent).toContain('$90');
  });

  it('test_F_MOD_012_whammy_reject_removes_from_pending_and_shows_rejected', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: 1000 },
      },
      'POST /drafts/draft-1/whammy/w1/reject': {
        status: 200,
        body: { whammy_id: 'w1', status: 'REJECTED' },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Lucky bonus' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));
    await waitFor(() => expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('whammy-reject-w1'));

    await waitFor(() => expect(screen.queryByTestId('whammy-pending-item-w1')).toBeNull());
  });

  it('test_F_MOD_012_whammy_trigger_409_shows_message_and_does_not_add_to_pending', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 409,
        body: { code: 'WHAMMY_MAX_PER_TEAM_EXCEEDED', message: 'Team has reached the maximum of 1 whammy(s)' },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't1' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Another one' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));

    await waitFor(() => expect(screen.getByTestId('whammy-error')).toBeTruthy());
    expect(screen.getByTestId('whammy-error').textContent).toContain('Team has reached the maximum of 1 whammy(s)');
    expect(screen.queryByTestId('whammy-pending-list')).toBeNull();
  });

  it('test_F_MOD_012_whammy_not_pending_on_approve_shows_message_and_removes_entry', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: 1000 },
      },
      'POST /drafts/draft-1/whammy/w1/approve': {
        status: 409,
        body: { code: 'WHAMMY_NOT_PENDING', message: 'Whammy is not in PENDING_APPROVAL status' },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Lucky bonus' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));
    await waitFor(() => expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('whammy-approve-w1'));

    await waitFor(() => expect(screen.queryByTestId('whammy-pending-item-w1')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('Whammy is not in PENDING_APPROVAL status');
  });

  it('test_F_MOD_012_whammy_not_pending_on_reject_shows_message_and_removes_entry', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: 1000 },
      },
      'POST /drafts/draft-1/whammy/w1/reject': {
        status: 409,
        body: { code: 'WHAMMY_NOT_PENDING', message: 'Whammy is not in PENDING_APPROVAL status' },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Lucky bonus' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));
    await waitFor(() => expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('whammy-reject-w1'));

    await waitFor(() => expect(screen.queryByTestId('whammy-pending-item-w1')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('Whammy is not in PENDING_APPROVAL status');
  });

  it('test_F_MOD_012_whammy_roster_infeasible_on_approve_keeps_entry_pending_with_inline_error', async () => {
    await renderAndLoad({
      'POST /drafts/draft-1/whammy': {
        status: 200,
        body: { whammy_id: 'w1', status: 'PENDING_APPROVAL', team_id: 't2', amount_minor: -1000 },
      },
      'POST /drafts/draft-1/whammy/w1/approve': {
        status: 409,
        body: { code: 'WHAMMY_ROSTER_COMPLETION_INFEASIBLE', message: 'This whammy would now make it impossible for the team to legally complete their roster' },
      },
    });
    fireEvent.change(screen.getByTestId('whammy-team-select'), { target: { value: 't2' } });
    fireEvent.change(screen.getByTestId('whammy-amount-input'), { target: { value: '-10' } });
    fireEvent.change(screen.getByTestId('whammy-description-input'), { target: { value: 'Penalty' } });
    fireEvent.click(screen.getByTestId('whammy-submit'));
    await waitFor(() => expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('whammy-approve-w1'));

    await waitFor(() => expect(screen.getByTestId('whammy-pending-error-w1')).toBeTruthy());
    expect(screen.getByTestId('whammy-pending-item-w1')).toBeTruthy();
  });
});
