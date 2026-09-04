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
 * Per F-MOD-013 (PRD §36.1-36.4, screen-information-architecture.md §18):
 * - Owner view (requesting team's own full pick list + metrics) and League
 *   summary view (all teams side by side + league-wide spend vs AAV) — both
 *   visible and downloadable by every owner, not commissioner-gated.
 *
 * Per screen-information-architecture.md §8/§18 (Draft Complete screen).
 */
import React, { useState } from 'react';

// ─── Types (mirrors server/src/draft/reports.ts / MOD-006-api-schema.yaml) ─────

export interface AcquisitionEntry {
  player_name: string;
  position: string;
  price_minor: number;
  roster_slot: string;
}

export interface RosterDepthScore {
  value: number;
  calculation_version: string;
}

export interface TeamEntry {
  team_id: string;
  team_name: string;
  final_budget_minor: number;
  acquisitions: AcquisitionEntry[];
  projected_starter_points: number;
  roster_depth_score: RosterDepthScore;
  aav_efficiency_pct: number;
}

export interface LeagueTotals {
  spend_minor: number;
  aav_minor: number;
}

export interface DraftSummaryReport {
  draft_id: string;
  completed_at: string;
  teams: TeamEntry[];
  league_totals: LeagueTotals;
}

export interface DraftCompleteProps {
  draftId: string;
  report: DraftSummaryReport;
  isCommissioner: boolean;
  /** The signed-in owner's team, if any (null for a commissioner or spectator). */
  currentTeamId?: string | null;
  /** Called when user clicks Export Worksheet; receives the blob URL */
  onExportWorksheet?: () => void;
  /** Called when user clicks Send Summary Email; receives recipients count */
  onEmailReport?: () => Promise<{ recipients: number }>;
}

type ViewMode = 'owner' | 'league';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Client-side CSV download — the true system boundary here (a real download
 * dialog) can't be exercised in jsdom tests, which stub URL.createObjectURL.
 */
function triggerDownload(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ownerViewCsv(team: TeamEntry): string {
  const lines = ['Player,Position,Slot,Price'];
  for (const acq of team.acquisitions) {
    lines.push([csvEscape(acq.player_name), csvEscape(acq.position), csvEscape(acq.roster_slot), String(acq.price_minor)].join(','));
  }
  const totalSpend = team.acquisitions.reduce((sum, a) => sum + a.price_minor, 0);
  lines.push('');
  lines.push(`Total spend,${totalSpend}`);
  lines.push(`Remaining budget,${team.final_budget_minor}`);
  lines.push(`Projected starter points,${team.projected_starter_points}`);
  lines.push(`Roster depth score (${team.roster_depth_score.calculation_version}),${team.roster_depth_score.value}`);
  lines.push(`AAV efficiency,${team.aav_efficiency_pct}%`);
  return lines.join('\n');
}

function leagueSummaryCsv(report: DraftSummaryReport): string {
  const lines = ['Team,Remaining Budget,Picks,Projected Starter Points,Roster Depth Score,AAV Efficiency %'];
  for (const team of report.teams) {
    lines.push(
      [
        csvEscape(team.team_name),
        String(team.final_budget_minor),
        String(team.acquisitions.length),
        String(team.projected_starter_points),
        String(team.roster_depth_score.value),
        String(team.aav_efficiency_pct),
      ].join(','),
    );
  }
  lines.push('');
  lines.push(`League spend,${report.league_totals.spend_minor}`);
  lines.push(`League AAV,${report.league_totals.aav_minor}`);
  return lines.join('\n');
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DraftComplete({
  draftId,
  report,
  isCommissioner,
  currentTeamId,
  onExportWorksheet,
  onEmailReport,
}: DraftCompleteProps): React.ReactElement {
  const myTeam = currentTeamId ? report.teams.find((t) => t.team_id === currentTeamId) ?? null : null;
  const [view, setView] = useState<ViewMode>(myTeam ? 'owner' : 'league');

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

      {/* Owner view / League summary view tabs — visible to every owner (PRD §36.4) */}
      <nav className="draft-complete__tabs" aria-label="Report view">
        <button
          type="button"
          className={`draft-complete__tab${view === 'owner' ? ' draft-complete__tab--active' : ''}`}
          aria-pressed={view === 'owner'}
          disabled={!myTeam}
          onClick={() => setView('owner')}
        >
          My Team
        </button>
        <button
          type="button"
          className={`draft-complete__tab${view === 'league' ? ' draft-complete__tab--active' : ''}`}
          aria-pressed={view === 'league'}
          onClick={() => setView('league')}
        >
          League Summary
        </button>
      </nav>

      {view === 'owner' && myTeam && (
        <section className="draft-complete__owner-view" aria-label="Owner view">
          <div className="draft-complete__owner-view-header">
            <h2>{myTeam.team_name} — Full Pick List</h2>
            <button
              type="button"
              aria-label="Download my team report"
              onClick={() => triggerDownload(`draft-${draftId}-${myTeam.team_id}-owner.csv`, ownerViewCsv(myTeam))}
            >
              Download
            </button>
          </div>

          <dl className="draft-complete__owner-summary">
            <div>
              <dt>Total spend</dt>
              <dd>{formatMoney(myTeam.acquisitions.reduce((sum, a) => sum + a.price_minor, 0))}</dd>
            </div>
            <div>
              <dt>Remaining budget</dt>
              <dd>{formatMoney(myTeam.final_budget_minor)}</dd>
            </div>
            <div>
              <dt>Projected starter points</dt>
              <dd>{myTeam.projected_starter_points}</dd>
            </div>
            <div>
              <dt>Roster depth score ({myTeam.roster_depth_score.calculation_version})</dt>
              <dd>{myTeam.roster_depth_score.value}</dd>
            </div>
            <div>
              <dt>AAV efficiency</dt>
              <dd>{formatPct(myTeam.aav_efficiency_pct)}</dd>
            </div>
          </dl>

          <table className="draft-complete__roster" aria-label={`${myTeam.team_name} full pick list`}>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Position</th>
                <th scope="col">Slot</th>
                <th scope="col">Price</th>
              </tr>
            </thead>
            <tbody>
              {myTeam.acquisitions.map((acq, idx) => (
                <tr key={idx}>
                  <td>{acq.player_name}</td>
                  <td>{acq.position}</td>
                  <td>{acq.roster_slot}</td>
                  <td>{formatMoney(acq.price_minor)}</td>
                </tr>
              ))}
              {myTeam.acquisitions.length === 0 && (
                <tr>
                  <td colSpan={4} className="draft-complete__no-picks">No picks</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {view === 'league' && (
        <section className="draft-complete__standings" aria-label="League summary">
          <div className="draft-complete__owner-view-header">
            <h2 className="draft-complete__standings-title">League Summary</h2>
            <button
              type="button"
              aria-label="Download league summary"
              onClick={() => triggerDownload(`draft-${draftId}-league-summary.csv`, leagueSummaryCsv(report))}
            >
              Download
            </button>
          </div>

          <table className="draft-complete__league-table" aria-label="All teams side by side">
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col">Remaining Budget</th>
                <th scope="col">Picks</th>
                <th scope="col">Projected Starter Points</th>
                <th scope="col">Roster Depth Score</th>
                <th scope="col">AAV Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {report.teams.map((team) => (
                <tr key={team.team_id}>
                  <td>{team.team_name}</td>
                  <td>{formatMoney(team.final_budget_minor)}</td>
                  <td>{team.acquisitions.length}</td>
                  <td>{team.projected_starter_points}</td>
                  <td>{team.roster_depth_score.value}</td>
                  <td>{formatPct(team.aav_efficiency_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="draft-complete__league-totals">
            League spend vs. AAV: {formatMoney(report.league_totals.spend_minor)} spent against{' '}
            {formatMoney(report.league_totals.aav_minor)} AAV.
          </p>
        </section>
      )}
    </main>
  );
}
