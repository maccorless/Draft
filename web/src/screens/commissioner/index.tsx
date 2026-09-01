/**
 * Commissioner Console — top-level navigation shell (MOD-000 scaffold, extended by MOD-001).
 *
 * MOD-001 adds:
 * - DatasetStatusIndicator: shows current dataset status (DRAFT/VALIDATED/FROZEN)
 * - "Create Draft" button gated on FROZEN status
 * - DatasetImport section with CSV upload dropzone and ImportResult display
 */
import React, { useState } from 'react';

import { DatasetImport } from './DatasetImport.js';
import { AmbiguityResolution } from './AmbiguityResolution.js';
import type { AmbiguousRow } from './AmbiguityResolution.js';

export type DatasetStatus = 'DRAFT' | 'VALIDATED' | 'FROZEN';

type ConsoleSection =
  | 'league-setup'
  | 'dataset-import'
  | 'draft-control'
  | 'corrections'
  | 'teams';

interface SectionConfig {
  id: ConsoleSection;
  label: string;
}

const SECTIONS: SectionConfig[] = [
  { id: 'league-setup', label: 'League Setup' },
  { id: 'dataset-import', label: 'Dataset Import' },
  { id: 'draft-control', label: 'Draft Control' },
  { id: 'corrections', label: 'Corrections & Rollback' },
  { id: 'teams', label: 'Teams' },
];

// ─── Dataset Status Indicator ────────────────────────────────────────────────

interface DatasetStatusIndicatorProps {
  status: DatasetStatus | null;
  onCreateDraft?: () => void;
}

export function DatasetStatusIndicator({
  status,
  onCreateDraft,
}: DatasetStatusIndicatorProps): React.ReactElement {
  const isFrozen = status === 'FROZEN';

  return (
    <div
      className="dataset-status"
      aria-label="Dataset status"
      data-testid="dataset-status"
    >
      <span className="dataset-status__label">Dataset:</span>{' '}
      {status ? (
        <strong
          className={`dataset-status__value dataset-status__value--${status.toLowerCase()}`}
          data-testid="dataset-status-value"
        >
          {status}
        </strong>
      ) : (
        <span className="dataset-status__value dataset-status__value--none" data-testid="dataset-status-value">
          None
        </span>
      )}
      <button
        className="dataset-status__create-draft"
        onClick={onCreateDraft}
        disabled={!isFrozen}
        aria-disabled={!isFrozen}
        data-testid="create-draft-button"
      >
        Create Draft
      </button>
    </div>
  );
}

// ─── Commissioner Console ─────────────────────────────────────────────────────

interface CommissionerConsoleProps {
  /** Injected props for MOD-001 functionality; optional so the scaffold still renders */
  leagueId?: string;
  datasetId?: string;
  datasetStatus?: DatasetStatus | null;
  token?: string;
  onCreateDraft?: () => void;
  ambiguousRows?: AmbiguousRow[];
  onResolveAmbiguity?: (resolutions: Record<number, string | 'skip'>) => void;
}

export function CommissionerConsole({
  leagueId,
  datasetId,
  datasetStatus = null,
  token,
  onCreateDraft,
  ambiguousRows,
  onResolveAmbiguity,
}: CommissionerConsoleProps = {}): React.ReactElement {
  const [activeSection, setActiveSection] =
    useState<ConsoleSection>('league-setup');

  return (
    <div className="commissioner-console">
      <header className="commissioner-console__header">
        <h1>Commissioner Console</h1>
        {/* Dataset status indicator is always visible — gates Create Draft */}
        <DatasetStatusIndicator
          status={datasetStatus ?? null}
          onCreateDraft={onCreateDraft}
        />
      </header>

      <nav
        className="commissioner-console__nav"
        aria-label="Commissioner sections"
      >
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            className={`commissioner-console__nav-item ${
              activeSection === section.id
                ? 'commissioner-console__nav-item--active'
                : ''
            }`}
            onClick={() => setActiveSection(section.id)}
            aria-current={activeSection === section.id ? 'page' : undefined}
            data-testid={`nav-${section.id}`}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <main
        className="commissioner-console__content"
        aria-label={`${SECTIONS.find((s) => s.id === activeSection)?.label} content`}
      >
        <div
          className="commissioner-console__placeholder"
          data-testid={`section-${activeSection}`}
        >
          {activeSection === 'dataset-import' && leagueId && datasetId && token && (
            <DatasetImport
              leagueId={leagueId}
              datasetId={datasetId}
              token={token}
            />
          )}

          {activeSection === 'dataset-import' &&
            ambiguousRows &&
            ambiguousRows.length > 0 &&
            onResolveAmbiguity && (
              <AmbiguityResolution
                ambiguousRows={ambiguousRows}
                onResolve={onResolveAmbiguity}
              />
            )}
        </div>
      </main>
    </div>
  );
}
