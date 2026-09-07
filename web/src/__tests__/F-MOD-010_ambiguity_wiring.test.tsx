/**
 * F-MOD-010-rework-01 item 2: CommissionerRoute (App.tsx) previously never
 * supplied ambiguousRows/onResolveAmbiguity to CommissionerConsole, so the
 * already-built AmbiguityResolution component was unreachable. This tests
 * the wiring end to end: a CSV import returning ambiguous_rows surfaces the
 * panel, and resolving calls the new resolve endpoint.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CommissionerRoute } from '../App.js';

const AUTH = {
  token: 't',
  role: 'COMMISSIONER' as const,
  leagueId: 'league-amb',
  leagueName: 'Ambiguity League',
};

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

describe('F-MOD-010 ambiguity resolution wiring', () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body && typeof init.body === 'string' && init.body.startsWith('{')
        ? JSON.parse(init.body)
        : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/datasets') && method === 'POST') {
        return jsonResponse(200, { id: 'ds-1', status: 'DRAFT' });
      }
      if (url.endsWith('/drafts') && method === 'GET') {
        return jsonResponse(200, { drafts: [] });
      }
      if (url.includes('/import/csv') && method === 'POST') {
        return jsonResponse(200, {
          rows_imported: 0,
          errors: [],
          ambiguous_rows: [
            { row_number: 1, raw_name: 'Mike Williams', raw_position: 'WR', candidates: [
              { id: 'p1', name: 'Mike Williams', position: 'WR', nfl_team: 'LAC' },
              { id: 'p2', name: 'Mike Williams', position: 'WR', nfl_team: 'NYJ' },
            ] },
          ],
        });
      }
      if (url.includes('/ambiguities/resolve') && method === 'POST') {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, { code: 'NOT_FOUND' });
    }) as unknown as typeof fetch;
  });

  it('test_F_MOD_010_csv_import_ambiguous_rows_surface_and_resolve_calls_endpoint', async () => {
    render(<CommissionerRoute auth={AUTH} onStaleSession={vi.fn()} />);

    // Dataset Import section, upload a CSV via the file input.
    fireEvent.click(await screen.findByTestId('nav-dataset-import'));
    const fileInput = await screen.findByTestId('file-input');
    const file = new File(['name,position,nfl_team,aav_minor\nMike Williams,WR,LAC,2000'], 'players.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // AmbiguityResolution panel should now render.
    await waitFor(() => expect(screen.getByLabelText('Ambiguity Resolution')).toBeTruthy());
    expect(screen.getAllByText(/Mike Williams/).length).toBeGreaterThan(0);

    // Resolve: pick the first candidate, then confirm.
    fireEvent.click(screen.getByLabelText('Select Mike Williams (WR, LAC)'));
    fireEvent.click(screen.getByText('Confirm Resolutions'));

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes('/ambiguities/resolve'));
      expect(resolveCall).toBeTruthy();
    });
    const resolveCall = calls.find((c) => c.url.includes('/ambiguities/resolve'))!;
    expect((resolveCall.body as { resolutions: Record<string, string> }).resolutions).toEqual({ '1': 'p1' });

    // Panel clears once the row is resolved.
    await waitFor(() => expect(screen.queryByLabelText('Ambiguity Resolution')).toBeNull());
  });
});
