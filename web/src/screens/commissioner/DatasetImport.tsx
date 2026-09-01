/**
 * Dataset import screen — CSV upload dropzone with progress indicator
 * and ImportResult display. Part of the Commissioner Console (MOD-001).
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

type UploadState = 'idle' | 'uploading' | 'done' | 'error';

export function DatasetImport({
  leagueId,
  datasetId,
  token,
  onImportComplete,
}: DatasetImportProps): React.ReactElement {
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFile(file: File): Promise<void> {
    setUploadState('uploading');
    setImportResult(null);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(
        `/leagues/${leagueId}/datasets/${datasetId}/import/csv`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: formData,
        },
      );

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
    // Reset input so the same file can be re-selected after an error
    e.target.value = '';
  }

  return (
    <section className="dataset-import" aria-label="Dataset Import">
      <h2 className="dataset-import__heading">Import Player Data (CSV)</h2>

      {/* Dropzone */}
      <div
        className={`dataset-import__dropzone${isDragOver ? ' dataset-import__dropzone--active' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="CSV upload area. Click or drag and drop a CSV file to import players."
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        {uploadState === 'uploading' ? (
          <p className="dataset-import__progress" aria-live="polite" aria-busy="true">
            Uploading and parsing CSV…
          </p>
        ) : (
          <p>Drop a CSV file here, or click to select</p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file input"
          className="dataset-import__file-input"
          onChange={handleFileChange}
        />
      </div>

      {/* Error state */}
      {uploadState === 'error' && uploadError && (
        <div className="dataset-import__upload-error" role="alert">
          <strong>Upload failed:</strong> {uploadError}
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
          </p>

          {importResult.errors.length > 0 && (
            <section aria-label="Import errors">
              <h3 className="dataset-import__errors-heading">
                Errors ({importResult.errors.length})
              </h3>
              <ul className="dataset-import__error-list">
                {importResult.errors.map((err, i) => (
                  <li key={i} className="dataset-import__error-item">
                    <span className="dataset-import__error-row">
                      Row {err.row}:
                    </span>{' '}
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
