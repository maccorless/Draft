/**
 * F-MOD-013: DraftComplete component — Owner view / League summary view split
 * and the three PRD §36.1-36.3 evaluation metrics (projected starter points,
 * roster depth score, AAV efficiency).
 *
 * URL.createObjectURL/revokeObjectURL are stubbed — jsdom does not implement
 * them, and the true system boundary here (an actual browser download
 * dialog) can't be exercised in a unit test; see [[feedback-ui-test-mocking]].
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DraftComplete, type DraftSummaryReport } from '../screens/draft-complete/index.js';

const DRAFT_ID = 'draft-1';

const report: DraftSummaryReport = {
  draft_id: DRAFT_ID,
  completed_at: new Date().toISOString(),
  teams: [
    {
      team_id: 't1',
      team_name: 'Alpha',
      final_budget_minor: 48000,
      acquisitions: [
        { player_name: 'Player A', position: 'QB', price_minor: 2000, roster_slot: 'QB' },
        { player_name: 'Player B', position: 'QB', price_minor: 500, roster_slot: 'BN' },
      ],
      projected_starter_points: 20,
      roster_depth_score: { value: 8, calculation_version: 'v1' },
      aav_efficiency_pct: 28.5714,
    },
    {
      team_id: 't2',
      team_name: 'Beta',
      final_budget_minor: 48500,
      acquisitions: [{ player_name: 'Player C', position: 'QB', price_minor: 1500, roster_slot: 'QB' }],
      projected_starter_points: 15,
      roster_depth_score: { value: 0, calculation_version: 'v1' },
      aav_efficiency_pct: -7.1428,
    },
  ],
  league_totals: { spend_minor: 4000, aav_minor: 4900 },
};

beforeEach(() => {
  (global as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  (global as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

describe('F-MOD-013 DraftComplete Owner/League views', () => {
  it('F_MOD_013_owner_view_shows_only_requesting_teams_picks_and_metrics', () => {
    render(
      <DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={false} currentTeamId="t1" />,
    );

    // Owner view is the default when the viewer has a team.
    expect(screen.getByText('Player A')).toBeTruthy();
    expect(screen.getByText('Player B')).toBeTruthy();
    expect(screen.queryByText('Player C')).toBeNull();

    expect(screen.getByText('20')).toBeTruthy(); // projected_starter_points
    expect(screen.getByText('8')).toBeTruthy(); // roster_depth_score.value
    expect(screen.getByText('+28.6%')).toBeTruthy(); // aav_efficiency_pct
  });

  it('F_MOD_013_league_summary_view_shows_every_team_side_by_side_with_metrics', () => {
    render(
      <DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={false} currentTeamId="t1" />,
    );

    fireEvent.click(screen.getByText('League Summary'));

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    // Both teams' AAV efficiency figures visible side by side.
    expect(screen.getByText('+28.6%')).toBeTruthy();
    expect(screen.getByText('-7.1%')).toBeTruthy();
  });

  it('F_MOD_013_league_summary_view_shows_league_wide_spend_vs_aav', () => {
    render(
      <DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={false} currentTeamId="t1" />,
    );
    fireEvent.click(screen.getByText('League Summary'));

    // final formatMoney rounds minor units (cents) to whole dollars: 4000 -> $40, 4900 -> $49
    expect(screen.getByText(/\$40 spent against \$49 AAV/)).toBeTruthy();
  });

  it('F_MOD_013_owner_without_a_team_defaults_to_league_summary_view', () => {
    // A commissioner (no teamId) opening the report shouldn't land on a
    // broken "My Team" tab with nothing to show.
    render(<DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={true} currentTeamId={null} />);

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('F_MOD_013_download_is_available_to_every_owner_in_both_views_not_commissioner_gated', () => {
    render(
      <DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={false} currentTeamId="t1" />,
    );

    fireEvent.click(screen.getByLabelText('Download my team report'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('League Summary'));
    fireEvent.click(screen.getByLabelText('Download league summary'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('F_MOD_013_commissioner_export_worksheet_and_email_buttons_still_work_unaffected_by_view_split', () => {
    render(
      <DraftComplete draftId={DRAFT_ID} report={report} isCommissioner={true} currentTeamId="t1" />,
    );

    expect(screen.getByLabelText('Export ESPN roster worksheet')).toBeTruthy();
    expect(screen.getByLabelText('Send draft summary email to all team owners')).toBeTruthy();
  });
});
