/**
 * Draft Complete screen — shown after DRAFT_COMPLETE broadcast or on page load
 * for a COMPLETE draft.
 *
 * Per F-MOD-006 behavioral expectations:
 * - Team owner: sees final standings, each team's roster with prices, remaining budget.
 * - Commissioner: gets "Export worksheet" and "Send summary email" buttons.
 * - No ad hoc player data beyond DraftSummaryReport.
 * - Buttons are keyboard-accessible semantic <button> elements with aria-label.
 *
 * Per screen-information-architecture.md §8 (Draft Complete screen).
 */
import React, { useState } from 'react';

// ─── Types (mirrors MOD-006-api-schema.yaml) ───────────────────────────────────

export interface AcquisitionEntry {
  player_name: string;
  position: string;
  price_minor: number;
  roster_slot: string;
}

export interface TeamEntry {
  team_id: string;
  team_name: string;
  final_budget_minor: number;
  acquisitions: AcquisitionEntry[];
}

export interface DraftSummaryReport {
  draft_id: string;
  completed_at: string;
  teams: TeamEntry[];
}

export interface DraftCompleteProps {
  draftId: string;
  report: DraftSummaryReport;
  isCommissioner: boolean;
  /** Called when user clicks Export Worksheet; receives the blob URL */
  onExportWorksheet?: () => void;
  /** Called when user clicks Send Summary Email; receives recipients count */
  onEmailReport?: () => Promise<{ recipients: number }>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DraftComplete({
  draftId,
  report,
  isCommissioner,
  onExportWorksheet,
  onEmailReport,
}: DraftCompleteProps): React.ReactElement {
  const [emailStatus, setEmailStatus] = useState<
    { state: 'idle' } | { state: 'sending' } | { state: 'sent'; recipients: number } | { state: 'error'; message: string }
  >({ state: 'idle' });

  const handleExportWorksheet = () => {
    // Trigger file download by navigating to the endpoint
    if (onExportWorksheet) {
      onExportWorksheet();
    } else {
      window.location.href = `/drafts/${draftId}/espn-worksheet`;
    }
  };

  const handleEmailReport = async () => {
    setEmailStatus({ state: 'sending' });
    try {
      const result = onEmailReport
        ? await onEmailReport()
        : await fetch(`/drafts/${draftId}/report/email`, { method: 'POST' }).then((r) => r.json() as Promise<{ recipients: number }>);
      setEmailStatus({ state: 'sent', recipients: result.recipients });
    } catch {
      setEmailStatus({ state: 'error', message: 'Email dispatch failed' });
    }
  };

  const completedAt = new Date(report.completed_at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <main className="draft-complete">
      <header className="draft-complete__header">
        <h1 className="draft-complete__title">Draft Complete</h1>
        <p className="draft-complete__completed-at">Completed: {completedAt}</p>
      </header>

      {/* Commissioner actions */}
      {isCommissioner && (
        <section
          className="draft-complete__actions"
          aria-label="Commissioner actions"
        >
          <button
            type="button"
            className="draft-complete__btn draft-complete__btn--export"
            aria-label="Export ESPN roster worksheet"
            onClick={handleExportWorksheet}
          >
            Export worksheet
          </button>

          <button
            type="button"
            className="draft-complete__btn draft-complete__btn--email"
            aria-label="Send draft summary email to all team owners"
            onClick={() => { void handleEmailReport(); }}
            disabled={emailStatus.state === 'sending' || emailStatus.state === 'sent'}
          >
            {emailStatus.state === 'sending'
              ? 'Sending…'
              : emailStatus.state === 'sent'
              ? 'Email sent'
              : 'Send summary email'}
          </button>

          {emailStatus.state === 'sent' && (
            <p className="draft-complete__email-confirm" role="status" aria-live="polite">
              Summary email sent to {emailStatus.recipients} team{emailStatus.recipients !== 1 ? 's' : ''}.
            </p>
          )}
          {emailStatus.state === 'error' && (
            <p className="draft-complete__email-error" role="alert">
              {emailStatus.message}
            </p>
          )}
        </section>
      )}

      {/* Final standings — all teams */}
      <section className="draft-complete__standings" aria-label="Final standings">
        <h2 className="draft-complete__standings-title">Final Standings</h2>

        {report.teams.map((team) => (
          <article
            key={team.team_id}
            className="draft-complete__team"
            aria-label={`${team.team_name} roster`}
          >
            <header className="draft-complete__team-header">
              <h3 className="draft-complete__team-name">{team.team_name}</h3>
              <p className="draft-complete__budget">
                Budget remaining: ${(team.final_budget_minor / 100).toFixed(0)}
              </p>
            </header>

            <table className="draft-complete__roster" aria-label={`${team.team_name} roster`}>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Position</th>
                  <th scope="col">Slot</th>
                  <th scope="col">Price</th>
                </tr>
              </thead>
              <tbody>
                {team.acquisitions.map((acq, idx) => (
                  <tr key={idx}>
                    <td>{acq.player_name}</td>
                    <td>{acq.position}</td>
                    <td>{acq.roster_slot}</td>
                    <td>${(acq.price_minor / 100).toFixed(0)}</td>
                  </tr>
                ))}
                {team.acquisitions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="draft-complete__no-picks">
                      No picks
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </article>
        ))}
      </section>
    </main>
  );
}
