/**
 * F-MOD-013-rework-01: EspnTransferFlow component — team mapping, ambiguous
 * mapping gating entry order, per-player reconciliation confirm, and the
 * canonical export error surface.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { EspnTransferFlow } from '../screens/draft-complete/EspnTransferFlow.js';

const DRAFT_ID = 'draft-1';
const LEAGUE_ID = 'league-1';
const TOKEN = 'tok-commissioner';

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(overrides: Record<string, { status: number; body: unknown }> = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url}`;
    if (overrides[key]) return jsonResponse(overrides[key]!.status, overrides[key]!.body);

    if (url.endsWith('/espn-team-mappings')) {
      return jsonResponse(200, [
        { team_id: 't1', external_team_id: 'espn-1', external_team_name: 'Alpha (ESPN)', verified: true, candidates: [] },
      ]);
    }
    if (url.endsWith('/canonical-export')) {
      return jsonResponse(200, [
        { player_id: 'p1', player_name: 'Player A', position: 'QB', team_id: 't1', team_name: 'Alpha', price_minor: 2000, roster_slot: 'QB', resolution_sequence: 1 },
      ]);
    }
    if (url.endsWith('/reconciliation')) {
      return jsonResponse(200, { items: [{ id: 'r1', team_id: 't1', player_id: 'p1', status: 'PENDING', recommended_target_slot: 'QB' }] });
    }
    return jsonResponse(404, { code: 'NOT_FOUND' });
  }) as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('F-MOD-013-rework-01 EspnTransferFlow', () => {
  it('test_F_MOD_013_rw01_shows_entry_order_and_confirming_a_player_calls_confirm_endpoint', async () => {
    const { calls } = installFetchMock();
    render(<EspnTransferFlow draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);

    await waitFor(() => expect(screen.getByTestId('espn-team-order-t1')).toBeTruthy());
    expect(screen.getByText(/Player A/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/reconciliation/r1/confirm') && c.method === 'POST');
      expect(call).toBeTruthy();
    });
  });

  it('test_F_MOD_013_rw01_unresolved_mapping_flags_and_blocks_entry_order', async () => {
    installFetchMock({
      'GET /leagues/league-1/espn-team-mappings': {
        status: 200,
        body: [{ team_id: 't1', external_team_id: null, external_team_name: null, verified: false, candidates: ['Alpha ESPN Team'] }],
      },
    });
    render(<EspnTransferFlow draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);

    await waitFor(() => expect(screen.getByTestId('espn-mapping-t1')).toBeTruthy());
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('espn-team-order-t1')).toBeNull();
  });

  it('test_F_MOD_013_rw01_confirming_mapping_calls_put_endpoint', async () => {
    const { calls } = installFetchMock({
      'GET /leagues/league-1/espn-team-mappings': {
        status: 200,
        body: [{ team_id: 't1', external_team_id: null, external_team_name: null, verified: false, candidates: ['Alpha ESPN Team'] }],
      },
    });
    render(<EspnTransferFlow draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);

    await waitFor(() => expect(screen.getByTestId('espn-mapping-t1')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('ESPN team for t1'), { target: { value: 'Alpha ESPN Team' } });
    fireEvent.click(screen.getByText('Confirm mapping'));

    await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/espn-team-mappings/t1') && c.method === 'PUT');
      expect(call).toBeTruthy();
    });
  });

  it('test_F_MOD_013_rw01_canonical_export_error_surfaces_without_crashing', async () => {
    installFetchMock({
      'GET /drafts/draft-1/canonical-export': {
        status: 422,
        body: { code: 'ROSTER_INTEGRITY_VIOLATION', message: 'Roster integrity check failed' },
      },
    });
    render(<EspnTransferFlow draftId={DRAFT_ID} leagueId={LEAGUE_ID} token={TOKEN} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Roster integrity check failed');
  });
});
