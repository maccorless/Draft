/**
 * Dataset import screen (MOD-001 + MOD-007).
 *
 * Commissioner selects an adapter source (CSV, Excel, ESPN PDF, FantasyPros),
 * then uploads a file or submits API options. All source-specific UI is
 * keyboard-accessible (RX-A11Y-001).
 */
import React, { useRef, useState } from 'react';

interface ImportError {
  row: number;
  message: string;
}

interface ImportResult {
  rows_imported: number;
  source?: string;
  errors: ImportError[];
}

interface DatasetImportProps {
  leagueId: string;
  datasetId: string;
  token: string;
  /** Called when import completes (success or partial) */
  onImportComplete?: (result: ImportResult) => void;
}

type AdapterSource = 'CSV' | 'EXCEL' | 'ESPN_PDF' | 'FANTASYPROS';
type ScoringFormat = 'STD' | 'HALF_PPR' | 'PPR';
type UploadState = 'idle' | 'uploading' | 'done' | 'error';

const FILE_SOURCES: AdapterSource[] = ['CSV', 'EXCEL', 'ESPN_PDF'];

const SOURCE_LABELS: Record<AdapterSource, string> = {
  CSV: 'CSV',
  EXCEL: 'Excel (.xlsx)',
  ESPN_PDF: 'ESPN PDF',
  FANTASYPROS: 'FantasyPros',
};

const SOURCE_ENDPOINTS: Record<AdapterSource, string> = {
  CSV: 'csv',
  EXCEL: 'excel',
  ESPN_PDF: 'espn-pdf',
  FANTASYPROS: 'fantasypros',
};

const SOURCE_ACCEPT: Record<AdapterSource, string> = {
  CSV: '.csv,text/csv',
  EXCEL: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ESPN_PDF: '.pdf,application/pdf',
  FANTASYPROS: '',
};

export function DatasetImport({
  leagueId,
  datasetId,
  token,
  onImportComplete,
}: DatasetImportProps): React.ReactElement {
  const [source, setSource] = useState<AdapterSource>('CSV');
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>('PPR');
  const inputRef = useRef<HTMLInputElement>(null);

  const isFileBased = FILE_SOURCES.includes(source);
  const baseUrl = `/leagues/${leagueId}/datasets/${datasetId}/import`;

  async function uploadFile(file: File): Promise<void> {
    setUploadState('uploading');
    setImportResult(null);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${baseUrl}/${SOURCE_ENDPOINTS[source]}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error((err as { message?: string }).message ?? response.statusText);
      }
      const result = (await response.json()) as ImportResult;
      setImportResult(result);
      setUploadState('done');
      onImportComplete?.(result);
    } catch (err) {
      setUploadError(String(err));
      setUploadState('error');
    }
  }

  async function submitFantasyPros(): Promise<void> {
    setUploadState('uploading');
    setImportResult(null);
    setUploadError(null);

    try {
      const response = await fetch(`${baseUrl}/${SOURCE_ENDPOINTS['FANTASYPROS']}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scoring_format: scoringFormat }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error((err as { message?: string }).message ?? response.statusText);
      }
      const result = (await response.json()) as ImportResult;
      setImportResult(result);
      setUploadState('done');
      onImportComplete?.(result);
    } catch (err) {
      setUploadError(String(err));
      setUploadState('error');
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void uploadFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    e.target.value = '';
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (source === 'FANTASYPROS') {
      void submitFantasyPros();
    } else {
      inputRef.current?.click();
    }
  }

  return (
    <section className="dataset-import" aria-label="Dataset Import">
      <h2 className="dataset-import__heading">Import Player Data</h2>

      {/* Adapter source selector */}
      <form onSubmit={handleSubmit} aria-label="Import options">
        <fieldset className="dataset-import__source-fieldset">
          <legend className="dataset-import__source-legend">Data source</legend>
          <div className="dataset-import__source-options" role="group" aria-label="Adapter source">
            {(Object.keys(SOURCE_LABELS) as AdapterSource[]).map((src) => (
              <label
                key={src}
                className={`dataset-import__source-option${source === src ? ' dataset-import__source-option--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="adapter-source"
                  value={src}
                  checked={source === src}
                  onChange={() => {
                    setSource(src);
                    setImportResult(null);
                    setUploadError(null);
                    setUploadState('idle');
                  }}
                  aria-label={SOURCE_LABELS[src]}
                  data-testid={`source-option-${src.toLowerCase()}`}
                />
                {SOURCE_LABELS[src]}
              </label>
            ))}
          </div>
        </fieldset>

        {/* File upload area (CSV, Excel, ESPN PDF) */}
        {isFileBased && (
          <div
            className={`dataset-import__dropzone${isDragOver ? ' dataset-import__dropzone--active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${SOURCE_LABELS[source]} upload area. Click or drag and drop a file to import players.`}
            data-testid="file-upload-area"
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
          >
            {uploadState === 'uploading' ? (
              <p className="dataset-import__progress" aria-live="polite" aria-busy="true">
                Uploading and parsing {SOURCE_LABELS[source]}…
              </p>
            ) : (
              <p>Drop a {SOURCE_LABELS[source]} file here, or click to select</p>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={SOURCE_ACCEPT[source]}
              aria-label={`${SOURCE_LABELS[source]} file input`}
              className="dataset-import__file-input"
              data-testid="file-input"
              onChange={handleFileChange}
            />
          </div>
        )}

        {/* FantasyPros options */}
        {source === 'FANTASYPROS' && (
          <div className="dataset-import__fantasypros-options" data-testid="fantasypros-options">
            <label className="dataset-import__scoring-label" htmlFor="scoring-format">
              Scoring format
            </label>
            <select
              id="scoring-format"
              className="dataset-import__scoring-select"
              value={scoringFormat}
              onChange={(e) => setScoringFormat(e.target.value as ScoringFormat)}
              aria-label="Scoring format"
              data-testid="scoring-format-select"
            >
              <option value="STD">Standard (STD)</option>
              <option value="HALF_PPR">Half PPR</option>
              <option value="PPR">PPR</option>
            </select>
            <button
              type="submit"
              className="dataset-import__fantasypros-btn"
              disabled={uploadState === 'uploading'}
              aria-label="Import from FantasyPros"
              data-testid="fantasypros-submit"
            >
              {uploadState === 'uploading' ? 'Importing…' : 'Import from FantasyPros'}
            </button>
          </div>
        )}
      </form>

      {/* Error state */}
      {uploadState === 'error' && uploadError && (
        <div className="dataset-import__upload-error" role="alert">
          <strong>Import failed:</strong> {uploadError}
        </div>
      )}

      {/* Import result */}
      {importResult && (
        <div
          className="dataset-import__result"
          aria-label="Import result"
          data-testid="import-result"
        >
          <p className="dataset-import__result-count">
            <strong>{importResult.rows_imported}</strong>{' '}
            {importResult.rows_imported === 1 ? 'row' : 'rows'} imported
            {importResult.source ? ` from ${importResult.source}` : ''}
          </p>

          {importResult.errors.length > 0 && (
            <section aria-label="Import errors">
              <h3 className="dataset-import__errors-heading">
                Errors ({importResult.errors.length})
              </h3>
              <ul className="dataset-import__error-list">
                {importResult.errors.map((err, i) => (
                  <li key={i} className="dataset-import__error-item">
                    <span className="dataset-import__error-row">Row {err.row}:</span>{' '}
                    {err.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
