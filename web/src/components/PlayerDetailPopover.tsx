/**
 * Dismissible player detail panel opened from the Draft Room's active-player
 * name (screen-information-architecture.md §3, "Draft Room — Optional
 * Expandable Player Detail"). Presentation-only: dismissing it never touches
 * auction state, and the bid controls rendered behind it are unaffected.
 *
 * Field groups follow the same display conventions War Room's Player
 * Intelligence panel already established (`web/src/screens/war-room/index.tsx`)
 * for injury freshness, bye week, and the AAV-by-source list, so both screens
 * read the same way. Groups with no data today (e.g. prior-season stats for a
 * player whose dataset never populated it) are simply omitted, not rendered
 * as broken placeholders.
 */
import React from 'react';

export interface AavSourceEntry {
  source: string;
  aav_minor: number;
}

export interface PopoverPlayer {
  name: string;
  position: string;
  nfl_team: string;
  tier: number | null;
  aav_minor: number;
  projected_points: number | null;
  bye_week?: number | null;
  injury_status?: string | null;
  injury_detail?: string | null;
  injury_updated_at?: string | null;
  prior_season_stats?: unknown;
  aav_sources?: AavSourceEntry[];
}

export interface ComparablePlayer {
  dataset_entry_id: string;
  name: string;
  aav_minor: number;
}

export interface PlayerDetailPopoverProps {
  player: PopoverPlayer;
  targetValueMinor: number | null;
  comparables: ComparablePlayer[];
  onClose: () => void;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

/** "updated 22m ago" style freshness string — mirrors War Room's formatFreshness. */
function formatFreshness(isoTimestamp: string): string {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.max(0, Math.round(elapsedMs / 60000));
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `updated ${days}d ago`;
}

function isPlainObject(value: unknown): value is Record<string, string | number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function PlayerDetailPopover({
  player,
  targetValueMinor,
  comparables,
  onClose,
}: PlayerDetailPopoverProps): React.ReactElement {
  const priorSeasonStats = isPlainObject(player.prior_season_stats) ? player.prior_season_stats : null;

  return (
    <div className="draft-room__popover" role="dialog" aria-label="Player detail" data-testid="player-detail-popover">
      <button
        type="button"
        className="draft-room__popover-close"
        onClick={onClose}
        aria-label="Close player detail"
        data-testid="popover-close"
      >
        ×
      </button>

      <h2 className="draft-room__popover-name">{player.name}</h2>
      <p className="draft-room__popover-meta">
        {player.position} · {player.nfl_team}
        {player.tier !== null && ` · Tier ${player.tier}`}
      </p>

      <dl className="draft-room__popover-stats">
        <div>
          <dt>AAV</dt>
          <dd>{formatMoney(player.aav_minor)}</dd>
        </div>
        {player.projected_points !== null && (
          <div>
            <dt>Projected pts</dt>
            <dd>{player.projected_points.toFixed(1)}</dd>
          </div>
        )}
        {targetValueMinor !== null && (
          <div>
            <dt>My Target</dt>
            <dd data-testid="popover-target">{formatMoney(targetValueMinor)}</dd>
          </div>
        )}
        {player.bye_week != null && (
          <div>
            <dt>Bye Week</dt>
            <dd>{player.bye_week}</dd>
          </div>
        )}
        {player.injury_status && (
          <div>
            <dt>Injury</dt>
            <dd data-testid="popover-injury">
              {player.injury_status}
              {player.injury_detail ? ` — ${player.injury_detail}` : ''}
              {player.injury_updated_at && (
                <span className="draft-room__popover-injury-freshness">
                  {' '}({formatFreshness(player.injury_updated_at)})
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      {player.aav_sources && player.aav_sources.length > 0 && (
        <dl className="draft-room__popover-aav-sources" aria-label="AAV by source" data-testid="popover-aav-sources">
          {player.aav_sources.map((s) => (
            <div key={s.source}>
              <dt>{s.source}</dt>
              <dd>{formatMoney(s.aav_minor)}</dd>
            </div>
          ))}
        </dl>
      )}

      {priorSeasonStats && (
        <dl className="draft-room__popover-prior-stats" aria-label="Prior season stats" data-testid="popover-prior-stats">
          {Object.entries(priorSeasonStats).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h3 className="draft-room__popover-subheading">Comparable Remaining</h3>
      {comparables.length > 0 ? (
        <ul className="draft-room__popover-comparables" data-testid="popover-comparables">
          {comparables.map((c) => (
            <li key={c.dataset_entry_id}>
              <span>{c.name}</span>
              <span className="draft-room__popover-comparable-aav">{formatMoney(c.aav_minor)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="draft-room__popover-idle">No comparable players remaining.</p>
      )}
    </div>
  );
}
