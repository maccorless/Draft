/**
 * Commissioner Console scaffold — top-level navigation shell.
 * All named sections are present with routing configured.
 * Section content pages are empty placeholders for later modules.
 */
import React, { useState } from 'react';

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

export function CommissionerConsole(): React.ReactElement {
  const [activeSection, setActiveSection] =
    useState<ConsoleSection>('league-setup');

  return (
    <div className="commissioner-console">
      <header className="commissioner-console__header">
        <h1>Commissioner Console</h1>
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
        {/* Placeholder — each section is filled in by its respective module */}
        <div
          className="commissioner-console__placeholder"
          data-testid={`section-${activeSection}`}
        >
          {/* Section content provided by later modules */}
        </div>
      </main>
    </div>
  );
}
