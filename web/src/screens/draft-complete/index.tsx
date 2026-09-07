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
import React, { useState, useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// Bid analytics types (mirrors GET /drafts/:id/analytics/bids)
export interface BidAnalyticsTeam {
  team_id: string;
  team_name: string;
  total_bids: number;
  match_bids: number;
  absolute_bids: number;
}

export interface LatencyBucket {
  bucket: string;
  count: number;
}

export interface BidAnalytics {
  draft_id: string;
  per_team: BidAnalyticsTeam[];
  snipe_event_count: number;
  latency_histogram: LatencyBucket[];
}

export interface DraftCompleteProps {
  draftId: string;
  report: DraftSummaryReport;
  isCommissioner: boolean;
  /** The signed-in owner's team, if any (null for a commissioner or spectator). */
  currentTeamId?: string | null;
  /** League id — when present along with token, renders the ESPN transfer CTA. */
  leagueId?: string;
  /** Auth token — required alongside leagueId for the ESPN transfer CTA. */
  token?: string;
  /** Called when user clicks Export Worksheet; receives the blob URL */
  onExportWorksheet?: () => void;
  /** Called when user clicks Send Summary Email; receives recipients count */
  onEmailReport?: () => Promise<{ recipients: number; failed_count?: number }>;
}

type ViewMode = 'owner' | 'league' | 'bids';

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
  leagueId,
  token,
  onExportWorksheet,
  onEmailReport,
}: DraftCompleteProps): React.ReactElement {
  const myTeam = currentTeamId ? report.teams.find((t) => t.team_id === currentTeamId) ?? null : null;
  const [view, setView] = useState<ViewMode>(myTeam ? 'owner' : 'league');

  const [emailStatus, setEmailStatus] = useState<
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent'; recipients: number }
    | { state: 'partial'; recipients: number; failed_count: number }
    | { state: 'error'; message: string }
  >({ state: 'idle' });

  const [bidAnalytics, setBidAnalytics] = useState<BidAnalytics | null>(null);
  const [bidAnalyticsError, setBidAnalyticsError] = useState<string | null>(null);

  // Fetch bid analytics once on mount — REST, no WS subscription
  useEffect(() => {
    fetch(`/drafts/${draftId}/analytics/bids`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<BidAnalytics>;
      })
      .then(setBidAnalytics)
      .catch(() => setBidAnalyticsError('Could not load bid analytics'));
  }, [draftId]);

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
        : await fetch(`/drafts/${draftId}/report/email`, { method: 'POST' }).then(
            (r) => r.json() as Promise<{ recipients: number; failed_count?: number }>,
          );
      const failed = result.failed_count ?? 0;
      if (failed > 0) {
        setEmailStatus({ state: 'partial', recipients: result.recipients, failed_count: failed });
      } else {
        setEmailStatus({ state: 'sent', recipients: result.recipients });
      }
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
          {emailStatus.state === 'partial' && (
            <p className="draft-complete__email-error" role="alert">
              {emailStatus.failed_count} of {emailStatus.recipients} emails failed to send.
            </p>
          )}
          {emailStatus.state === 'error' && (
            <p className="draft-complete__email-error" role="alert">
              {emailStatus.message}
            </p>
          )}

          {leagueId && token && (
            <button
              type="button"
              className="draft-complete__btn draft-complete__btn--espn"
              aria-label="Open guided ESPN roster transfer"
              onClick={() => { window.open(`/espn-transfer?leagueId=${encodeURIComponent(leagueId)}&token=${encodeURIComponent(token)}`, '_blank'); }}
            >
              ESPN roster transfer
            </button>
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
        <button
          type="button"
          className={`draft-complete__tab${view === 'bids' ? ' draft-complete__tab--active' : ''}`}
          aria-pressed={view === 'bids'}
          onClick={() => setView('bids')}
        >
          Bid Activity
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

      {view === 'bids' && (
        <section className="draft-complete__bid-activity" aria-label="Bid activity">
          <h2>Bid Activity</h2>
          {bidAnalyticsError && (
            <p role="alert" className="draft-complete__error">{bidAnalyticsError}</p>
          )}
          {!bidAnalytics && !bidAnalyticsError && (
            <p>Loading bid analytics…</p>
          )}
          {bidAnalytics && (
            <>
              <p className="draft-complete__snipe-count">
                Anti-snipe extensions: <strong>{bidAnalytics.snipe_event_count}</strong>
              </p>

              <h3>Bids per team</h3>
              <table className="draft-complete__bid-table" aria-label="Bids per team">
                <thead>
                  <tr>
                    <th scope="col">Team</th>
                    <th scope="col">Total bids</th>
                    <th scope="col">Match bids</th>
                    <th scope="col">Custom bids</th>
                  </tr>
                </thead>
                <tbody>
                  {bidAnalytics.per_team.map((t) => (
                    <tr key={t.team_id}>
                      <td>{t.team_name}</td>
                      <td>{t.total_bids}</td>
                      <td>{t.match_bids}</td>
                      <td>{t.absolute_bids}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {bidAnalytics.latency_histogram.some((b) => b.count > 0) && (
                <>
                  <h3>Bid latency distribution</h3>
                  <table className="draft-complete__latency-table" aria-label="Bid latency histogram">
                    <thead>
                      <tr>
                        <th scope="col">Bucket</th>
                        <th scope="col">Bids</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bidAnalytics.latency_histogram.map((b) => (
                        <tr key={b.bucket}>
                          <td>{b.bucket}</td>
                          <td>{b.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
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
