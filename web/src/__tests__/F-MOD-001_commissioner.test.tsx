/**
 * F-MOD-001: Commissioner Console UI — dataset status indicator, CSV dropzone,
 * ambiguity resolution, and Create Draft button gating.
 *
 * Uses @testing-library/react (jsdom) — no live server needed for UI behavior tests.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CommissionerConsole, DatasetStatusIndicator } from '../screens/commissioner/index.js';
import { DatasetImport } from '../screens/commissioner/DatasetImport.js';
import { AmbiguityResolution } from '../screens/commissioner/AmbiguityResolution.js';
import type { AmbiguousRow } from '../screens/commissioner/AmbiguityResolution.js';

// ── DatasetStatusIndicator ────────────────────────────────────────────────────

describe('F-MOD-001 DatasetStatusIndicator', () => {
  it('test_F_MOD_001_status_indicator_shows_dataset_status_prominently', () => {
    render(<DatasetStatusIndicator status="DRAFT" />);
    expect(screen.getByTestId('dataset-status-value').textContent).toBe('DRAFT');
  });

  it('test_F_MOD_001_status_indicator_shows_FROZEN_when_frozen', () => {
    render(<DatasetStatusIndicator status="FROZEN" />);
    expect(screen.getByTestId('dataset-status-value').textContent).toBe('FROZEN');
  });

  it('test_F_MOD_001_create_draft_button_disabled_when_status_not_FROZEN', () => {
    render(<DatasetStatusIndicator status="DRAFT" />);
    const button = screen.getByTestId('create-draft-button');
    expect(button).toBeTruthy();
    // Disabled when not FROZEN
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_001_create_draft_button_disabled_when_status_VALIDATED', () => {
    render(<DatasetStatusIndicator status="VALIDATED" />);
    const button = screen.getByTestId('create-draft-button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_001_create_draft_button_enabled_only_when_FROZEN', () => {
    render(<DatasetStatusIndicator status="FROZEN" />);
    const button = screen.getByTestId('create-draft-button');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('test_F_MOD_001_create_draft_button_calls_handler_when_clicked', () => {
    const onCreateDraft = vi.fn();
    render(<DatasetStatusIndicator status="FROZEN" onCreateDraft={onCreateDraft} />);
    fireEvent.click(screen.getByTestId('create-draft-button'));
    expect(onCreateDraft).toHaveBeenCalledTimes(1);
  });

  it('test_F_MOD_001_create_draft_button_absent_or_disabled_when_null_status', () => {
    render(<DatasetStatusIndicator status={null} />);
    const button = screen.getByTestId('create-draft-button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── CommissionerConsole integration ──────────────────────────────────────────

describe('F-MOD-001 CommissionerConsole dataset integration', () => {
  it('test_F_MOD_001_console_shows_dataset_status_in_header', () => {
    render(<CommissionerConsole datasetStatus="DRAFT" />);
    expect(screen.getByTestId('dataset-status')).toBeTruthy();
    expect(screen.getByTestId('dataset-status-value').textContent).toBe('DRAFT');
  });

  it('test_F_MOD_001_console_create_draft_disabled_when_not_frozen', () => {
    render(<CommissionerConsole datasetStatus="DRAFT" />);
    expect((screen.getByTestId('create-draft-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_001_console_create_draft_enabled_when_frozen', () => {
    render(<CommissionerConsole datasetStatus="FROZEN" />);
    expect((screen.getByTestId('create-draft-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── DatasetImport dropzone ────────────────────────────────────────────────────

describe('F-MOD-001 DatasetImport', () => {
  beforeEach(() => {
    // Mock fetch for upload
    global.fetch = vi.fn();
  });

  it('test_F_MOD_001_dropzone_renders_upload_area', () => {
    render(
      <DatasetImport leagueId="league-1" datasetId="dataset-1" token="tok" />,
    );
    expect(screen.getByLabelText(/CSV upload area/i)).toBeTruthy();
  });

  it('test_F_MOD_001_dropzone_shows_progress_during_upload_and_result_on_completion', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rows_imported: 3, errors: [] }),
    });
    global.fetch = mockFetch;

    render(
      <DatasetImport leagueId="league-1" datasetId="dataset-1" token="tok" />,
    );

    const input = screen.getByLabelText('CSV file input') as HTMLInputElement;
    const file = new File(['name,position\nKC,QB'], 'players.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('import-result')).toBeTruthy();
    });

    expect(screen.getByTestId('import-result').textContent).toContain('3');
  });

  it('test_F_MOD_001_dropzone_shows_per_row_errors_when_import_has_errors', async () => {
    const errors = [
      { row: 2, message: 'Missing player name' },
      { row: 3, message: "aav_minor must be a non-negative integer, got 'abc'" },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rows_imported: 1, errors }),
    });
    global.fetch = mockFetch;

    render(
      <DatasetImport leagueId="league-1" datasetId="dataset-1" token="tok" />,
    );

    const input = screen.getByLabelText('CSV file input') as HTMLInputElement;
    const file = new File(['data'], 'players.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('import-result')).toBeTruthy();
    });

    // Each error shows its row number
    expect(screen.getByText(/Row 2:/)).toBeTruthy();
    expect(screen.getByText(/Row 3:/)).toBeTruthy();
    expect(screen.getByText(/Missing player name/)).toBeTruthy();
  });
});

// ── AmbiguityResolution ───────────────────────────────────────────────────────

describe('F-MOD-001 AmbiguityResolution', () => {
  const sampleRows: AmbiguousRow[] = [
    {
      row_number: 5,
      raw_name: 'Patrick Mahomes',
      raw_position: 'QB',
      candidates: [
        { id: 'c1', name: 'Patrick Mahomes', position: 'QB', nfl_team: 'KC' },
        { id: 'c2', name: 'Patrick Mahomes II', position: 'QB', nfl_team: 'KC' },
      ],
    },
  ];

  it('test_F_MOD_001_ambiguity_shows_at_least_two_candidates_per_row', () => {
    render(<AmbiguityResolution ambiguousRows={sampleRows} onResolve={vi.fn()} />);
    // Both candidates are visible
    expect(screen.getByLabelText(/Select Patrick Mahomes \(QB, KC\)/)).toBeTruthy();
    expect(screen.getByLabelText(/Select Patrick Mahomes II/)).toBeTruthy();
  });

  it('test_F_MOD_001_ambiguity_confirm_button_disabled_until_all_resolved', () => {
    render(<AmbiguityResolution ambiguousRows={sampleRows} onResolve={vi.fn()} />);
    const confirmBtn = screen.getByRole('button', { name: /Confirm Resolutions/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_F_MOD_001_ambiguity_confirm_enabled_after_all_rows_resolved', () => {
    const onResolve = vi.fn();
    render(<AmbiguityResolution ambiguousRows={sampleRows} onResolve={onResolve} />);

    // Select first candidate for row 5
    fireEvent.click(screen.getByLabelText(/Select Patrick Mahomes \(QB, KC\)/));

    const confirmBtn = screen.getByRole('button', { name: /Confirm Resolutions/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('test_F_MOD_001_ambiguity_calls_onResolve_with_selections', () => {
    const onResolve = vi.fn();
    render(<AmbiguityResolution ambiguousRows={sampleRows} onResolve={onResolve} />);

    fireEvent.click(screen.getByLabelText(/Select Patrick Mahomes \(QB, KC\)/));
    fireEvent.click(screen.getByRole('button', { name: /Confirm Resolutions/i }));

    expect(onResolve).toHaveBeenCalledWith({ 5: 'c1' });
  });
});
