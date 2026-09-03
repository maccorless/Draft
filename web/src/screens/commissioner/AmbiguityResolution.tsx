/**
 * Ambiguity resolution UI — side-by-side display of player match candidates
 * for CSV rows that could not be auto-resolved to a unique player.
 * Commissioner confirms or overrides each match before import is committed.
 */
import React, { useState } from 'react';
import './ambiguity-resolution.css';

export interface PlayerCandidate {
  id: string;
  name: string;
  position: string;
  nfl_team: string;
}

export interface AmbiguousRow {
  row_number: number;
  raw_name: string;
  raw_position: string;
  candidates: PlayerCandidate[];
}

interface AmbiguityResolutionProps {
  ambiguousRows: AmbiguousRow[];
  onResolve: (resolutions: Record<number, string | 'skip'>) => void;
}

export function AmbiguityResolution({
  ambiguousRows,
  onResolve,
}: AmbiguityResolutionProps): React.ReactElement {
  // Map row_number → selected candidate id or 'skip'
  const [selections, setSelections] = useState<Record<number, string | 'skip'>>({});

  function select(rowNumber: number, candidateId: string | 'skip'): void {
    setSelections((prev) => ({ ...prev, [rowNumber]: candidateId }));
  }

  const allResolved = ambiguousRows.every((r) => selections[r.row_number] !== undefined);

  function handleConfirm(): void {
    onResolve(selections);
  }

  return (
    <section className="ambiguity-resolution" aria-label="Ambiguity Resolution">
      <h2 className="ambiguity-resolution__heading">Resolve Ambiguous Players</h2>
      <p className="ambiguity-resolution__description">
        The following rows matched multiple players. Select the correct player or
        skip each row.
      </p>

      {ambiguousRows.map((row) => (
        <article
          key={row.row_number}
          className="ambiguity-resolution__row"
          aria-label={`Row ${row.row_number}: ${row.raw_name}`}
        >
          <header className="ambiguity-resolution__row-header">
            <span className="ambiguity-resolution__row-number">
              Row {row.row_number}:
            </span>{' '}
            <strong>{row.raw_name}</strong> ({row.raw_position})
          </header>

          <div
            className="ambiguity-resolution__candidates"
            role="radiogroup"
            aria-label={`Candidates for row ${row.row_number}`}
          >
            {row.candidates.map((candidate) => (
              <label
                key={candidate.id}
                className={`ambiguity-resolution__candidate${
                  selections[row.row_number] === candidate.id
                    ? ' ambiguity-resolution__candidate--selected'
                    : ''
                }`}
              >
                <input
                  type="radio"
                  name={`row-${row.row_number}`}
                  value={candidate.id}
                  checked={selections[row.row_number] === candidate.id}
                  onChange={() => select(row.row_number, candidate.id)}
                  aria-label={`Select ${candidate.name} (${candidate.position}, ${candidate.nfl_team})`}
                />
                <span className="ambiguity-resolution__candidate-name">
                  {candidate.name}
                </span>
                <span className="ambiguity-resolution__candidate-pos">
                  {candidate.position}
                </span>
                <span className="ambiguity-resolution__candidate-team">
                  {candidate.nfl_team}
                </span>
              </label>
            ))}

            {/* Skip option */}
            <label
              className={`ambiguity-resolution__candidate ambiguity-resolution__candidate--skip${
                selections[row.row_number] === 'skip'
                  ? ' ambiguity-resolution__candidate--selected'
                  : ''
              }`}
            >
              <input
                type="radio"
                name={`row-${row.row_number}`}
                value="skip"
                checked={selections[row.row_number] === 'skip'}
                onChange={() => select(row.row_number, 'skip')}
                aria-label={`Skip row ${row.row_number}`}
              />
              <span>Skip this row</span>
            </label>
          </div>
        </article>
      ))}

      <button
        className="ambiguity-resolution__confirm"
        onClick={handleConfirm}
        disabled={!allResolved}
        aria-disabled={!allResolved}
      >
        Confirm Resolutions
      </button>
    </section>
  );
}
