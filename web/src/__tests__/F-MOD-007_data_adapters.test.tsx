/**
 * F-MOD-007: DatasetImport UI — adapter-source selector with 4 options,
 * file upload for file-based sources, scoring-format dropdown for FantasyPros.
 * All controls keyboard-accessible (RX-A11Y-001).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DatasetImport } from '../screens/commissioner/DatasetImport.js';

const DEFAULT_PROPS = {
  leagueId: 'league-1',
  datasetId: 'dataset-1',
  token: 'test-token',
};

describe('F-MOD-007 DatasetImport adapter selector', () => {
  it('test_F_MOD_007_ui_shows_exactly_four_source_options', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(4);
    // Verify all four adapter sources are present
    const labels = options.map((o) => (o as HTMLInputElement).value);
    expect(labels).toContain('CSV');
    expect(labels).toContain('EXCEL');
    expect(labels).toContain('ESPN_PDF');
    expect(labels).toContain('FANTASYPROS');
  });

  it('test_F_MOD_007_ui_file_upload_visible_for_csv_source', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    // CSV is default — file upload area should be visible
    expect(screen.getByTestId('file-upload-area')).toBeTruthy();
    expect(screen.queryByTestId('fantasypros-options')).toBeNull();
  });

  it('test_F_MOD_007_ui_file_upload_visible_for_excel_source', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByTestId('source-option-excel'));
    expect(screen.getByTestId('file-upload-area')).toBeTruthy();
    expect(screen.queryByTestId('fantasypros-options')).toBeNull();
  });

  it('test_F_MOD_007_ui_file_upload_visible_for_espn_pdf_source', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByTestId('source-option-espn_pdf'));
    expect(screen.getByTestId('file-upload-area')).toBeTruthy();
    expect(screen.queryByTestId('fantasypros-options')).toBeNull();
  });

  it('test_F_MOD_007_ui_fantasypros_dropdown_visible_when_fantasypros_selected', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByTestId('source-option-fantasypros'));
    // File upload area should be hidden, FantasyPros options visible
    expect(screen.queryByTestId('file-upload-area')).toBeNull();
    expect(screen.getByTestId('fantasypros-options')).toBeTruthy();
    // Scoring format select with STD, HALF_PPR, PPR options
    const select = screen.getByTestId('scoring-format-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('STD');
    expect(optionValues).toContain('HALF_PPR');
    expect(optionValues).toContain('PPR');
  });

  it('test_F_MOD_007_ui_source_options_keyboard_accessible', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    const radios = screen.getAllByRole('radio');
    // All radios must be keyboard-reachable (no tabIndex=-1, form control)
    for (const radio of radios) {
      expect((radio as HTMLInputElement).tabIndex).not.toBe(-1);
      // Each radio has an aria-label
      expect((radio as HTMLInputElement).getAttribute('aria-label')).not.toBeNull();
    }
  });

  it('test_F_MOD_007_ui_file_input_keyboard_accessible_via_dropzone', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    const dropzone = screen.getByTestId('file-upload-area');
    // Dropzone has tabIndex=0 for keyboard focus
    expect(Number(dropzone.getAttribute('tabindex'))).toBe(0);
    // Enter key triggers click
    expect(dropzone.getAttribute('role')).toBe('button');
  });

  it('test_F_MOD_007_ui_fantasypros_select_keyboard_accessible', () => {
    render(<DatasetImport {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByTestId('source-option-fantasypros'));
    const select = screen.getByTestId('scoring-format-select');
    // Select is a native form control — keyboard accessible by default
    expect(select.tagName).toBe('SELECT');
    // Has aria-label
    expect(select.getAttribute('aria-label')).toBeTruthy();
  });
});
