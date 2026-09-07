/**
 * Draft Prep — owner-facing pre-draft screen. Center of the screen is the
 * full player pool: filterable by position/team/name, sortable by name/AAV/
 * projected points/target price, with inline Watch List / Nomination Queue /
 * Do Not Draft / Target Value actions per row. Auto-Agent settings (the 6
 * fields actually wired to the bidding engine — see auto-agent.ts) live below.
 * Reachable from the Lobby's "Draft Prep" button.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, ListPlus, ProhibitInset } from '@phosphor-icons/react';

import './draft-prep.css';

export interface DraftPrepProps {
  leagueId: string;
  teamId: string;
  token: string;
  draftId: string;
  leagueName: string;
  teamName: string;
}

interface Player {
  player_id: string;
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  projected_points: number | null;
}

interface WatchlistItem {
  dataset_player_id: string;
  player_name: string;
  position: string;
}

interface QueueItem {
  dataset_player_id: string;
  queue_position: number;
  player_name: string;
  position: string;
}

interface TargetItem {
  dataset_player_id: string;
  target_value_minor: number;
  player_name: string;
  position: string;
}

interface DoNotDraftEntry {
  player_id: string;
  player_name?: string;
}

// Per-player willingness ceiling configuration (F-MOD-004-rework-02;
// state-machine-flows.md §11 / data-model.md §10.5) — the 6 fields the
// bidding engine actually reads. willingness_pct/enabled on the DB row are
// deliberately retired (schema comment, server/db/schema/index.ts) and are
// not exposed here.
interface AutoAgentConfigState {
  use_owner_target_when_customized: boolean;
  fallback_to_primary_aav: boolean;
  max_over_base_pct: number;
  random_variance_pct: number;
  bench_value_pct: number;
  prioritize_starters: boolean;
}

const DEFAULT_AUTO_AGENT_CONFIG: AutoAgentConfigState = {
  use_owner_target_when_customized: true,
  fallback_to_primary_aav: true,
  max_over_base_pct: 0.25,
  random_variance_pct: 0.25,
  bench_value_pct: 0.5,
  prioritize_starters: true,
};

type SortKey = 'name' | 'aav' | 'points' | 'target';
type SortDir = 'asc' | 'desc';

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function DraftPrep({
  leagueId,
  teamId,
  token,
  draftId,
  leagueName,
  teamName,
}: DraftPrepProps): React.ReactElement {
  const [players, setPlayers] = useState<Player[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [doNotDraft, setDoNotDraft] = useState<DoNotDraftEntry[]>([]);
  const [autoAgentConfig, setAutoAgentConfig] = useState<AutoAgentConfigState>(DEFAULT_AUTO_AGENT_CONFIG);

  const [positionFilter, setPositionFilter] = useState('ALL');
  const [teamFilter, setTeamFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('aav');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const refreshWatchlist = useCallback(() => {
    authedJson<{ watchlist: WatchlistItem[] }>(`/drafts/${draftId}/teams/${teamId}/watchlist`, token)
      .then((d) => setWatchlist(d.watchlist ?? []))
      .catch(() => {});
  }, [draftId, teamId, token]);

  const refreshQueue = useCallback(() => {
    authedJson<{ queue: QueueItem[] }>(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token)
      .then((d) => setQueue(d.queue ?? []))
      .catch(() => {});
  }, [draftId, teamId, token]);

  const refreshTargets = useCallback(() => {
    authedJson<{ targets: TargetItem[] }>(`/drafts/${draftId}/teams/${teamId}/target-values`, token)
      .then((d) => setTargets(d.targets ?? []))
      .catch(() => {});
  }, [draftId, teamId, token]);

  const refreshDoNotDraft = useCallback(() => {
    authedJson<{ entries: DoNotDraftEntry[] }>(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token)
      .then((d) => setDoNotDraft(d.entries ?? []))
      .catch(() => {});
  }, [draftId, teamId, token]);

  const refreshAutoAgentConfig = useCallback(() => {
    authedJson<{ team_id: string } & AutoAgentConfigState>(`/drafts/${draftId}/teams/${teamId}/auto-agent`, token)
      .then((d) => setAutoAgentConfig({
        use_owner_target_when_customized: d.use_owner_target_when_customized,
        fallback_to_primary_aav: d.fallback_to_primary_aav,
        max_over_base_pct: d.max_over_base_pct,
        random_variance_pct: d.random_variance_pct,
        bench_value_pct: d.bench_value_pct,
        prioritize_starters: d.prioritize_starters,
      }))
      .catch(() => {});
  }, [draftId, teamId, token]);

  useEffect(() => {
    authedJson<{ players: Player[] }>(`/leagues/${leagueId}/players`, token)
      .then((d) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [leagueId, token]);

  useEffect(() => {
    refreshWatchlist();
    refreshQueue();
    refreshTargets();
    refreshDoNotDraft();
    refreshAutoAgentConfig();
  }, [refreshWatchlist, refreshQueue, refreshTargets, refreshDoNotDraft, refreshAutoAgentConfig]);

  const watchedIds = useMemo(() => new Set(watchlist.map((w) => w.dataset_player_id)), [watchlist]);
  const queuedByPlayer = useMemo(
    () => new Map(queue.map((q) => [q.dataset_player_id, q.queue_position])),
    [queue],
  );
  const targetByPlayer = useMemo(
    () => new Map(targets.map((t) => [t.dataset_player_id, t.target_value_minor])),
    [targets],
  );
  const doNotDraftIds = useMemo(() => new Set(doNotDraft.map((d) => d.player_id)), [doNotDraft]);

  const positions = useMemo(
    () => [...new Set(players.map((p) => p.position))].sort(),
    [players],
  );
  const nflTeams = useMemo(
    () => [...new Set(players.map((p) => p.nfl_team))].sort(),
    [players],
  );

  const visiblePlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = players.filter((p) => {
      if (positionFilter !== 'ALL' && p.position !== positionFilter) return false;
      if (teamFilter !== 'ALL' && p.nfl_team !== teamFilter) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'points':
          return dir * ((a.projected_points ?? -Infinity) - (b.projected_points ?? -Infinity));
        case 'target':
          return dir * ((targetByPlayer.get(a.player_id) ?? -Infinity) - (targetByPlayer.get(b.player_id) ?? -Infinity));
        case 'aav':
        default:
          return dir * (a.aav_minor - b.aav_minor);
      }
    });
  }, [players, positionFilter, teamFilter, search, sortKey, sortDir, targetByPlayer]);

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  function toggleWatch(player: Player): void {
    if (watchedIds.has(player.player_id)) {
      authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist/${player.player_id}`, token, { method: 'DELETE' })
        .then(refreshWatchlist)
        .catch(() => {});
    } else {
      authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataset_player_id: player.player_id }),
      })
        .then(refreshWatchlist)
        .catch(() => {});
    }
  }

  function toggleQueue(player: Player): void {
    if (queuedByPlayer.has(player.player_id)) {
      authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue/${player.player_id}`, token, { method: 'DELETE' })
        .then(refreshQueue)
        .catch(() => {});
    } else {
      authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataset_player_id: player.player_id }),
      })
        .then(refreshQueue)
        .catch(() => {});
    }
  }

  function moveQueueItem(index: number, dir: -1 | 1): void {
    const next = [...queue];
    const swapIdx = index + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[index], next[swapIdx]] = [next[swapIdx]!, next[index]!];
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ordered_player_ids: next.map((q) => q.dataset_player_id) }),
    })
      .then(refreshQueue)
      .catch(() => {});
  }

  function toggleDoNotDraft(player: Player): void {
    if (doNotDraftIds.has(player.player_id)) {
      authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft/${player.player_id}`, token, { method: 'DELETE' })
        .then(refreshDoNotDraft)
        .catch(() => {});
    } else {
      authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player_id: player.player_id }),
      })
        .then(refreshDoNotDraft)
        .catch(() => {});
    }
  }

  function saveTarget(playerId: string, dollarValue: string): void {
    const trimmed = dollarValue.trim();
    if (trimmed === '') return;
    const minor = Math.round(parseFloat(trimmed) * 100);
    if (!Number.isFinite(minor)) return;
    const nextTargets = [
      ...targets
        .filter((t) => t.dataset_player_id !== playerId)
        .map((t) => ({ dataset_player_id: t.dataset_player_id, target_value_minor: t.target_value_minor })),
      { dataset_player_id: playerId, target_value_minor: minor },
    ];
    authedJson(`/drafts/${draftId}/teams/${teamId}/target-values`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: nextTargets }),
    })
      .then(refreshTargets)
      .catch(() => {});
  }

  function submitAutoAgentConfig(e: React.FormEvent): void {
    e.preventDefault();
    authedJson<{ team_id: string } & AutoAgentConfigState>(
      `/drafts/${draftId}/teams/${teamId}/auto-agent`,
      token,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(autoAgentConfig),
      },
    )
      .then((d) => setAutoAgentConfig({
        use_owner_target_when_customized: d.use_owner_target_when_customized,
        fallback_to_primary_aav: d.fallback_to_primary_aav,
        max_over_base_pct: d.max_over_base_pct,
        random_variance_pct: d.random_variance_pct,
        bench_value_pct: d.bench_value_pct,
        prioritize_starters: d.prioritize_starters,
      }))
      .catch(() => {});
  }

  return (
    <main className="draft-prep">
      <header className="draft-prep__header">
        <div>
          <p className="draft-prep__eyebrow">{leagueName}</p>
          <h1 className="draft-prep__title">Draft Prep</h1>
        </div>
        <div className="draft-prep__header-links">
          <a href="/lobby">← Back to Lobby</a>
          <a href={`/draft-room?draftId=${draftId}`}>Enter Draft Room →</a>
        </div>
      </header>

      <section className="draft-prep__panel draft-prep__player-pool" aria-label="Player Pool">
        <h2 className="draft-prep__heading">Player Pool</h2>

        <div className="draft-prep__filters">
          <label className="draft-prep__filter-field">
            <span>Position</span>
            <select value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)}>
              <option value="ALL">All positions</option>
              {positions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="draft-prep__filter-field">
            <span>NFL Team</span>
            <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="ALL">All teams</option>
              {nflTeams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="draft-prep__filter-field draft-prep__filter-field--search">
            <span>Search</span>
            <input
              type="text"
              placeholder="Player name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search players by name"
            />
          </label>
        </div>

        <div className="draft-prep__table-wrap">
          <table className="draft-prep__table">
            <thead>
              <tr>
                <th className="draft-prep__sortable" onClick={() => toggleSort('name')}>
                  Name{sortIndicator('name')}
                </th>
                <th>Pos</th>
                <th>Team</th>
                <th className="draft-prep__sortable" onClick={() => toggleSort('aav')}>
                  AAV{sortIndicator('aav')}
                </th>
                <th className="draft-prep__sortable" onClick={() => toggleSort('points')}>
                  Proj Pts{sortIndicator('points')}
                </th>
                <th className="draft-prep__sortable" onClick={() => toggleSort('target')}>
                  My Target{sortIndicator('target')}
                </th>
                <th>Watch</th>
                <th>Queue</th>
                <th>DNL</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlayers.map((p) => (
                <PlayerRow
                  key={p.player_id}
                  player={p}
                  watched={watchedIds.has(p.player_id)}
                  queuePosition={queuedByPlayer.get(p.player_id) ?? null}
                  targetMinor={targetByPlayer.get(p.player_id) ?? null}
                  doNotDraft={doNotDraftIds.has(p.player_id)}
                  onToggleWatch={() => toggleWatch(p)}
                  onToggleQueue={() => toggleQueue(p)}
                  onToggleDoNotDraft={() => toggleDoNotDraft(p)}
                  onSaveTarget={(value) => saveTarget(p.player_id, value)}
                />
              ))}
              {visiblePlayers.length === 0 && (
                <tr><td colSpan={9} className="draft-prep__idle-small">No players match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="draft-prep__panel" aria-label="Nomination Queue">
        <h2 className="draft-prep__heading">Nomination Queue</h2>
        <p className="draft-prep__hint">Order matters here — this is who auto-nominates for you if you miss your turn.</p>
        <ol className="draft-prep__queue-list">
          {queue.length === 0 && <li className="draft-prep__idle-small">Queue is empty. Add players from the pool above.</li>}
          {queue.map((q, i) => (
            <li key={q.dataset_player_id} className="draft-prep__queue-item">
              <span>{q.player_name} <em>({q.position})</em></span>
              <span className="draft-prep__queue-controls">
                <button type="button" aria-label="Move up" onClick={() => moveQueueItem(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" aria-label="Move down" onClick={() => moveQueueItem(i, 1)} disabled={i === queue.length - 1}>↓</button>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="draft-prep__panel" aria-label="Auto-Agent Settings">
        <h2 className="draft-prep__heading">Auto-Agent Settings</h2>
        <p className="draft-prep__hint">
          Used only while your team is in Auto-Agent mode. Bids are computed per player: your Target
          Value (or Primary AAV) is the base, then these settings decide how far above it your agent
          will go.
        </p>
        <form className="draft-prep__auto-agent-form" onSubmit={submitAutoAgentConfig}>
          <div className="draft-prep__field">
            <label htmlFor="max-over-base-slider">
              Max over base ({Math.round(autoAgentConfig.max_over_base_pct * 100)}%)
            </label>
            <input
              id="max-over-base-slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={autoAgentConfig.max_over_base_pct}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, max_over_base_pct: parseFloat(e.target.value) }))}
            />
          </div>

          <div className="draft-prep__field">
            <label htmlFor="random-variance-slider">
              Random variance (±{Math.round(autoAgentConfig.random_variance_pct * 100)}%)
            </label>
            <input
              id="random-variance-slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={autoAgentConfig.random_variance_pct}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, random_variance_pct: parseFloat(e.target.value) }))}
            />
          </div>

          <div className="draft-prep__field">
            <label htmlFor="bench-value-slider">
              Bench discount ({Math.round(autoAgentConfig.bench_value_pct * 100)}%)
            </label>
            <input
              id="bench-value-slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={autoAgentConfig.bench_value_pct}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, bench_value_pct: parseFloat(e.target.value) }))}
            />
          </div>

          <label className="draft-prep__checkbox-label" htmlFor="prioritize-starters-toggle">
            <input
              id="prioritize-starters-toggle"
              type="checkbox"
              checked={autoAgentConfig.prioritize_starters}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, prioritize_starters: e.target.checked }))}
            />
            Prioritize starters
          </label>

          <label className="draft-prep__checkbox-label" htmlFor="use-owner-target-toggle">
            <input
              id="use-owner-target-toggle"
              type="checkbox"
              checked={autoAgentConfig.use_owner_target_when_customized}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, use_owner_target_when_customized: e.target.checked }))}
            />
            Use my Target Value when set
          </label>

          <label className="draft-prep__checkbox-label" htmlFor="fallback-primary-aav-toggle">
            <input
              id="fallback-primary-aav-toggle"
              type="checkbox"
              checked={autoAgentConfig.fallback_to_primary_aav}
              onChange={(e) => setAutoAgentConfig((c) => ({ ...c, fallback_to_primary_aav: e.target.checked }))}
            />
            Fall back to Primary AAV
          </label>

          <button type="submit">Save Auto-Agent Settings</button>
        </form>
      </section>

      <p className="draft-prep__team-footer">Prepping as <strong>{teamName}</strong></p>
    </main>
  );
}

function PlayerRow({
  player,
  watched,
  queuePosition,
  targetMinor,
  doNotDraft,
  onToggleWatch,
  onToggleQueue,
  onToggleDoNotDraft,
  onSaveTarget,
}: {
  player: Player;
  watched: boolean;
  queuePosition: number | null;
  targetMinor: number | null;
  doNotDraft: boolean;
  onToggleWatch: () => void;
  onToggleQueue: () => void;
  onToggleDoNotDraft: () => void;
  onSaveTarget: (value: string) => void;
}): React.ReactElement {
  const [targetInput, setTargetInput] = useState(targetMinor !== null ? String(targetMinor / 100) : '');

  return (
    <tr className={doNotDraft ? 'draft-prep__row--do-not-draft' : ''}>
      <td>{player.name}</td>
      <td>{player.position}</td>
      <td>{player.nfl_team}</td>
      <td className="draft-prep__num">${(player.aav_minor / 100).toFixed(0)}</td>
      <td className="draft-prep__num">{player.projected_points !== null ? player.projected_points.toFixed(1) : '—'}</td>
      <td>
        <input
          type="number"
          className="draft-prep__target-input"
          aria-label={`Target value for ${player.name}`}
          value={targetInput}
          onChange={(e) => setTargetInput(e.target.value)}
          onBlur={() => onSaveTarget(targetInput)}
        />
      </td>
      <td>
        <button
          type="button"
          className={`draft-prep__icon-toggle${watched ? ' draft-prep__icon-toggle--active' : ''}`}
          aria-pressed={watched}
          aria-label={watched ? `Remove ${player.name} from watch list` : `Add ${player.name} to watch list`}
          onClick={onToggleWatch}
        >
          <Star size={16} weight={watched ? 'fill' : 'regular'} />
        </button>
      </td>
      <td>
        <button
          type="button"
          className={`draft-prep__icon-toggle${queuePosition !== null ? ' draft-prep__icon-toggle--active' : ''}`}
          aria-pressed={queuePosition !== null}
          aria-label={queuePosition !== null ? `Remove ${player.name} from nomination queue` : `Add ${player.name} to nomination queue`}
          onClick={onToggleQueue}
        >
          <ListPlus size={16} weight={queuePosition !== null ? 'fill' : 'regular'} />
          {queuePosition !== null && <span className="draft-prep__queue-badge">{queuePosition + 1}</span>}
        </button>
      </td>
      <td>
        <button
          type="button"
          className={`draft-prep__icon-toggle draft-prep__icon-toggle--danger${doNotDraft ? ' draft-prep__icon-toggle--active' : ''}`}
          aria-pressed={doNotDraft}
          aria-label={doNotDraft ? `Remove ${player.name} from Do Not Draft` : `Add ${player.name} to Do Not Draft`}
          onClick={onToggleDoNotDraft}
        >
          <ProhibitInset size={16} weight={doNotDraft ? 'fill' : 'regular'} />
        </button>
      </td>
    </tr>
  );
}
