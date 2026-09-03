/**
 * Commissioner Console — top-level navigation shell (MOD-000 scaffold, extended by MOD-001).
 *
 * MOD-001 adds:
 * - DatasetStatusIndicator: shows current dataset status (DRAFT/VALIDATED/FROZEN)
 * - "Create Draft" button gated on FROZEN status
 * - DatasetImport section with CSV upload dropzone and ImportResult display
 */
import React, { useState } from 'react';
import {
  Gear,
  UploadSimple,
  Gavel,
  ArrowCounterClockwise,
  UsersThree,
  CircleNotch,
  CheckCircle,
  Snowflake,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

import { DatasetImport } from './DatasetImport.js';
import { AmbiguityResolution } from './AmbiguityResolution.js';
import type { AmbiguousRow } from './AmbiguityResolution.js';
import './commissioner-console.css';

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
  icon: Icon;
}

const SECTIONS: SectionConfig[] = [
  { id: 'league-setup', label: 'League Setup', icon: Gear },
  { id: 'dataset-import', label: 'Dataset Import', icon: UploadSimple },
  { id: 'draft-control', label: 'Draft Control', icon: Gavel },
  { id: 'corrections', label: 'Corrections & Rollback', icon: ArrowCounterClockwise },
  { id: 'teams', label: 'Teams', icon: UsersThree },
];

// ─── Dataset Status Indicator ────────────────────────────────────────────────

interface DatasetStatusIndicatorProps {
  status: DatasetStatus | null;
  onCreateDraft?: () => void;
}

const STATUS_ICON: Record<DatasetStatus, Icon> = {
  DRAFT: CircleNotch,
  VALIDATED: CheckCircle,
  FROZEN: Snowflake,
};

export function DatasetStatusIndicator({
  status,
  onCreateDraft,
}: DatasetStatusIndicatorProps): React.ReactElement {
  const isFrozen = status === 'FROZEN';
  const StatusIcon = status ? STATUS_ICON[status] : null;

  return (
    <div className="dataset-status" aria-label="Dataset status" data-testid="dataset-status">
      <span
        className={`dataset-status__pill dataset-status__pill--${(status ?? 'none').toLowerCase()}`}
        data-testid="dataset-status-value"
      >
        {StatusIcon && <StatusIcon size={14} weight="bold" />}
        {status ?? 'None'}
      </span>
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

// ─── Empty section placeholder ───────────────────────────────────────────────

function ComingSoon({ label }: { label: string }): React.ReactElement {
  return (
    <div className="coming-soon">
      <h3 className="coming-soon__heading">{label}</h3>
      <p className="coming-soon__body">This section isn&apos;t built yet.</p>
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

  const activeLabel = SECTIONS.find((s) => s.id === activeSection)?.label ?? '';

  return (
    <div className="commissioner-console">
      <header className="commissioner-console__header">
        <div className="commissioner-console__header-inner">
          <h1 className="commissioner-console__title">Commissioner Console</h1>
          <DatasetStatusIndicator status={datasetStatus} onCreateDraft={onCreateDraft} />
        </div>

        <nav className="commissioner-console__nav" aria-label="Commissioner sections">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                className={`commissioner-console__nav-item${
                  isActive ? ' commissioner-console__nav-item--active' : ''
                }`}
                onClick={() => setActiveSection(section.id)}
                aria-current={isActive ? 'page' : undefined}
                data-testid={`nav-${section.id}`}
              >
                <Icon size={18} weight={isActive ? 'bold' : 'regular'} />
                {section.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="commissioner-console__content" aria-label={`${activeLabel} content`}>
        <div className="commissioner-console__panel" data-testid={`section-${activeSection}`}>
          {activeSection === 'league-setup' && <ComingSoon label="League Setup" />}

          {activeSection === 'dataset-import' && (
            <>
              {leagueId && datasetId && token ? (
                <DatasetImport leagueId={leagueId} datasetId={datasetId} token={token} />
              ) : (
                <ComingSoon label="Dataset Import" />
              )}

              {ambiguousRows && ambiguousRows.length > 0 && onResolveAmbiguity && (
                <AmbiguityResolution
                  ambiguousRows={ambiguousRows}
                  onResolve={onResolveAmbiguity}
                />
              )}
            </>
          )}

          {activeSection === 'draft-control' && <ComingSoon label="Draft Control" />}
          {activeSection === 'corrections' && <ComingSoon label="Corrections & Rollback" />}
          {activeSection === 'teams' && <ComingSoon label="Teams" />}
        </div>
      </main>
    </div>
  );
}
