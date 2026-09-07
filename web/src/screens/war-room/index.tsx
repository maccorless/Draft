/**
 * War Room — secondary desktop view: what's happening across the draft, and
 * what to prepare for next (screen-information-architecture.md §4-8, §15).
 * Follows the current nomination automatically but never duplicates the
 * Draft Room's bidding controls — this is understand-and-prepare, not act.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Binoculars, ListNumbers, Target, X, Prohibit } from '@phosphor-icons/react';

import { useAuctionSocket } from '../../lib/useAuctionSocket.js';
import { TeamIcon } from '../../components/TeamIcon.js';
import './war-room.css';

interface WarRoomProps {
  draftId: string;
  leagueId: string;
  token: string;
  teamId: string | null;
}

interface RosterSlotDef {
  position: string;
  priority: number;
  is_starter: boolean;
  slot_count: number;
}

interface GridSlot {
  position: string;
  is_starter: boolean;
  filled: number;
  total: number;
}

interface GridTeam {
  team_id: string;
  team_name: string;
  icon_url: string | null;
  remaining_budget_minor: number;
  max_legal_bid_minor: number;
  roster_filled_count: number;
  control_mode: 'MANUAL' | 'AUTO_AGENT';
  slots: GridSlot[];
}

interface AavSourceEntry {
  source: string;
  aav_minor: number;
  tier: number | null;
  projected_points: number | null;
}

interface DatasetPlayer {
  player_id: string;
  dataset_entry_id: string;
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  tier: number | null;
  projected_points?: number | null;
  bye_week?: number | null;
  injury_status?: string | null;
  injury_detail?: string | null;
  injury_updated_at?: string | null;
  aav_sources?: AavSourceEntry[];
  prior_season_stats?: unknown;
}

interface ActivityEntry {
  acquisition_id: string;
  player_name: string;
  position: string;
  price_minor: number;
  team_id: string;
  team_name: string;
  bid_count: number;
  unique_bidder_count: number;
  aav_diff_minor: number | null;
}

interface WatchlistItem {
  dataset_player_id: string;
  player_name: string;
  position: string;
  aav_minor: number;
}

interface QueueItem {
  dataset_player_id: string;
  queue_position: number;
  player_name: string;
  position: string;
  aav_minor: number;
}

interface TargetItem {
  dataset_player_id: string;
  target_value_minor: number;
  player_name: string;
  position: string;
  aav_minor: number;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

/** "updated 22m ago" style freshness string for an injury_updated_at timestamp. */
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

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

interface DoNotDraftEntry {
  player_id: string;
  player_name?: string;
}

type PrepTab = 'watchlist' | 'queue' | 'targets' | 'do-not-draft';

const CONNECTION_LABEL: Record<string, string> = {
  open: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  closed: 'Offline',
};

export function WarRoom({ draftId, leagueId, token, teamId }: WarRoomProps): React.ReactElement {
  const ws = useAuctionSocket(draftId, token);
  const navigate = useNavigate();
  const [rosterSlots, setRosterSlots] = useState<RosterSlotDef[]>([]);
  const [minBidMinor, setMinBidMinor] = useState<number | null>(null);
  const [rosterGrid, setRosterGrid] = useState<GridTeam[]>([]);
  const [players, setPlayers] = useState<DatasetPlayer[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [doNotDraft, setDoNotDraft] = useState<DoNotDraftEntry[]>([]);
  const [prepTab, setPrepTab] = useState<PrepTab>('watchlist');
  const [showAllTargetablePlayers, setShowAllTargetablePlayers] = useState(false);
  const [targetDraft, setTargetDraft] = useState('');

  useEffect(() => {
    authedJson<{ roster_slots: RosterSlotDef[]; auction: { min_bid_minor: number } | null }>(`/drafts/${draftId}/config`, token)
      .then((d) => {
        setRosterSlots(d.roster_slots ?? []);
        setMinBidMinor(d.auction?.min_bid_minor ?? null);
      })
      .catch(() => {});
    authedJson<{ players: DatasetPlayer[] }>(`/leagues/${leagueId}/players`, token)
      .then((d) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [draftId, leagueId, token]);

  const refreshGrid = useMemo(
    () => () => {
      authedJson<{ teams: GridTeam[] }>(`/drafts/${draftId}/roster-grid`, token)
        .then((d) => setRosterGrid(d.teams ?? []))
        .catch(() => {});
    },
    [draftId, token],
  );

  const refreshActivity = useMemo(
    () => () => {
      authedJson<{ recent: ActivityEntry[] }>(`/drafts/${draftId}/activity`, token)
        .then((d) => setActivity(d.recent ?? []))
        .catch(() => {});
    },
    [draftId, token],
  );

  useEffect(() => {
    refreshGrid();
    refreshActivity();
  }, [refreshGrid, refreshActivity]);

  useEffect(() => {
    if (ws.recentAwards.length > 0) {
      refreshGrid();
      refreshActivity();
    }
  }, [ws.recentAwards.length, refreshGrid, refreshActivity]);

  // War Room never had its own "draft complete" branch — it just never
  // reacted to draftStatus at all, leaving a connected client stranded here.
  // Covers both the live DRAFT_COMPLETE broadcast and the reconnect-snapshot
  // case (STATE_SNAPSHOT also carries draftStatus: 'COMPLETE').
  useEffect(() => {
    if (ws.draftStatus === 'COMPLETE') {
      navigate(`/draft-complete?draftId=${draftId}`, { replace: true });
    }
  }, [ws.draftStatus, draftId, navigate]);

  const refreshWatchlist = useMemo(
    () => () => {
      if (!teamId) return;
      authedJson<{ watchlist: WatchlistItem[] }>(`/drafts/${draftId}/teams/${teamId}/watchlist`, token)
        .then((d) => setWatchlist(d.watchlist ?? []))
        .catch(() => {});
    },
    [draftId, teamId, token],
  );
  const refreshQueue = useMemo(
    () => () => {
      if (!teamId) return;
      authedJson<{ queue: QueueItem[] }>(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token)
        .then((d) => setQueue(d.queue ?? []))
        .catch(() => {});
    },
    [draftId, teamId, token],
  );
  const refreshTargets = useMemo(
    () => () => {
      if (!teamId) return;
      authedJson<{ targets: TargetItem[] }>(`/drafts/${draftId}/teams/${teamId}/target-values`, token)
        .then((d) => setTargets(d.targets ?? []))
        .catch(() => {});
    },
    [draftId, teamId, token],
  );

  const refreshDoNotDraft = useMemo(
    () => () => {
      if (!teamId) return;
      authedJson<{ entries: DoNotDraftEntry[] }>(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token)
        .then((d) => setDoNotDraft(d.entries ?? []))
        .catch(() => {});
    },
    [draftId, teamId, token],
  );

  useEffect(() => {
    refreshWatchlist();
    refreshQueue();
    refreshTargets();
    refreshDoNotDraft();
  }, [refreshWatchlist, refreshQueue, refreshTargets, refreshDoNotDraft]);

  function addToDoNotDraft(playerId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    })
      .then(refreshDoNotDraft)
      .catch(() => {});
  }

  function removeFromDoNotDraft(playerId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft/${playerId}`, token, { method: 'DELETE' })
      .then(refreshDoNotDraft)
      .catch(() => {});
  }

  const drafted = useMemo(() => new Set(ws.recentAwards.map((a) => a.player_name)), [ws.recentAwards]);
  const auction = ws.currentAuction;
  const myTarget = auction ? targets.find((t) => t.player_name === auction.player_name) ?? null : null;
  const activePlayerDetail = useMemo(
    () => (auction ? players.find((p) => p.name === auction.player_name) ?? null : null),
    [auction, players],
  );
  const priorSeasonStats = isPlainObject(activePlayerDetail?.prior_season_stats)
    ? activePlayerDetail.prior_season_stats
    : null;

  const tierBoard = useMemo(() => {
    if (!auction || auction.tier === null) return [];
    return players
      .filter((p) => p.position === auction.position && p.tier === auction.tier && !drafted.has(p.name))
      .sort((a, b) => b.aav_minor - a.aav_minor)
      .slice(0, 8);
  }, [auction, players, drafted]);

  const comparable = useMemo(() => {
    if (!auction) return [];
    return players
      .filter((p) => p.position === auction.position && p.name !== auction.player_name && !drafted.has(p.name))
      .sort((a, b) => b.aav_minor - a.aav_minor)
      .slice(0, 6);
  }, [auction, players]);

  const marketContext = useMemo(() => {
    const spentMinor = activity.reduce((sum, a) => sum + a.price_minor, 0);
    const draftedByPos: Record<string, number> = {};
    for (const a of activity) draftedByPos[a.position] = (draftedByPos[a.position] ?? 0) + 1;
    const totalBudgetMinor = rosterGrid.reduce((sum, t) => sum + t.remaining_budget_minor, 0);
    const avgBudgetMinor = rosterGrid.length > 0 ? Math.round(totalBudgetMinor / rosterGrid.length) : 0;

    // Actual-vs-AAV comparison: sum(price) - sum(aav) across rows that carry
    // a resolved AAV baseline. No awards yet → $0/0%, never NaN.
    const priced = activity.filter((a) => a.aav_diff_minor !== null);
    const aavDiffMinor = priced.reduce((sum, a) => sum + a.aav_diff_minor!, 0);
    const aavBaselineMinor = priced.reduce((sum, a) => sum + (a.price_minor - a.aav_diff_minor!), 0);
    const aavDiffPct = aavBaselineMinor > 0 ? (aavDiffMinor / aavBaselineMinor) * 100 : 0;

    const remainingByTier: Record<number, number> = {};
    for (const p of players) {
      if (drafted.has(p.name) || p.tier === null) continue;
      remainingByTier[p.tier] = (remainingByTier[p.tier] ?? 0) + 1;
    }

    return { spentMinor, draftedByPos, totalBudgetMinor, avgBudgetMinor, aavDiffMinor, aavDiffPct, remainingByTier };
  }, [activity, rosterGrid, players, drafted]);

  const isMyNominationTurn = teamId !== null && !auction && ws.currentNominatorTeamId === teamId;

  // Position-focus highlighting (visual emphasis only, never reorders rows):
  // teams with an open compatible starter slot for the active position, and
  // the team(s) with the highest remaining budget.
  const highestBudgetMinor = useMemo(
    () => (rosterGrid.length > 0 ? Math.max(...rosterGrid.map((t) => t.remaining_budget_minor)) : null),
    [rosterGrid],
  );
  const teamsWithOpenSlotForPosition = useMemo(() => {
    if (!auction) return new Set<string>();
    return new Set(
      rosterGrid
        .filter((t) =>
          t.slots.some(
            (s) => s.is_starter && s.filled < s.total && (s.position === auction.position || s.position === 'FLEX' || s.position === 'SUPERFLEX'),
          ),
        )
        .map((t) => t.team_id),
    );
  }, [auction, rosterGrid]);

  // Whammy toast: same ephemeral, self-dismissing pattern Draft Room already
  // uses for the same ws.whammyNotice event (F-MOD-008-rework-01 gap-review).
  const [whammyVisible, setWhammyVisible] = useState(false);
  useEffect(() => {
    if (!ws.whammyNotice) return;
    setWhammyVisible(true);
    const timer = setTimeout(() => setWhammyVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [ws.whammyNotice?.receivedAt]);

  function addToWatchlist(entryId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_player_id: entryId }),
    })
      .then(refreshWatchlist)
      .catch(() => {});
  }

  function removeFromWatchlist(entryId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist/${entryId}`, token, { method: 'DELETE' })
      .then(refreshWatchlist)
      .catch(() => {});
  }

  function addToQueue(entryId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_player_id: entryId }),
    })
      .then(refreshQueue)
      .catch(() => {});
  }

  function removeFromQueue(entryId: string): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue/${entryId}`, token, { method: 'DELETE' })
      .then(refreshQueue)
      .catch(() => {});
  }

  function reorderQueue(newOrder: string[]): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ordered_player_ids: newOrder }),
    })
      .then(refreshQueue)
      .catch(() => {});
  }

  function moveQueueItem(index: number, dir: -1 | 1): void {
    const next = [...queue];
    const swapIdx = index + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[index], next[swapIdx]] = [next[swapIdx]!, next[index]!];
    reorderQueue(next.map((q) => q.dataset_player_id));
  }

  function saveTarget(entryId: string, valueMinor: number): void {
    if (!teamId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/target-values`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ dataset_player_id: entryId, target_value_minor: valueMinor }] }),
    })
      .then(refreshTargets)
      .catch(() => {});
  }

  function handleSetTarget(e: React.FormEvent): void {
    e.preventDefault();
    if (!auction) return;
    const entry = players.find((p) => p.name === auction.player_name);
    const amount = Math.round(parseFloat(targetDraft) * 100);
    if (!entry || !Number.isFinite(amount) || amount <= 0) return;
    saveTarget(entry.dataset_entry_id, amount);
    setTargetDraft('');
  }

  return (
    <div className="war-room">
      {whammyVisible && ws.whammyNotice && (
        <div className="war-room__whammy-toast" role="status" data-testid="whammy-toast">
          {(rosterGrid.find((t) => t.team_id === ws.whammyNotice!.team_id)?.team_name ?? 'A team')} —{' '}
          {ws.whammyNotice.description || 'Whammy'} ({formatMoney(ws.whammyNotice.amount_minor)})
        </div>
      )}
      <header className="war-room__topbar">
        <span className="war-room__title">War Room</span>
        <div className="war-room__topbar-actions">
          {/* UF-01-03 item 4: reciprocal link back to the same team identity's
              Draft Room, opened as a separate synchronized window. */}
          <a
            className="war-room__draft-room-link"
            href={`/draft-room?draftId=${draftId}`}
            target="_blank"
            rel="noreferrer"
            data-testid="open-draft-room-link"
          >
            Draft Room ↗
          </a>
          <span className={`war-room__conn war-room__conn--${ws.connectionStatus}`}>
            {CONNECTION_LABEL[ws.connectionStatus] ?? ws.connectionStatus}
          </span>
        </div>
      </header>

      <div className="war-room__grid">
        {/* Zone A: Player Intelligence */}
        <section className="war-room__panel war-room__player-intel" aria-label="Player Intelligence">
          {auction ? (
            <>
              <h1 className="war-room__player-name">{auction.player_name}</h1>
              <p className="war-room__player-meta">
                {auction.position} · {auction.nfl_team}
                {auction.tier !== null && ` · Tier ${auction.tier}`}
              </p>
              <dl className="war-room__player-stats">
                <div>
                  <dt>AAV</dt>
                  <dd>{formatMoney(auction.aav_minor)}</dd>
                </div>
                {auction.projected_points !== null && (
                  <div>
                    <dt>Projected pts</dt>
                    <dd>{auction.projected_points.toFixed(1)}</dd>
                  </div>
                )}
                {myTarget && (
                  <div>
                    <dt>My Target</dt>
                    <dd className="war-room__my-target">{formatMoney(myTarget.target_value_minor)}</dd>
                  </div>
                )}
                {activePlayerDetail?.bye_week != null && (
                  <div>
                    <dt>Bye Week</dt>
                    <dd>{activePlayerDetail.bye_week}</dd>
                  </div>
                )}
                {activePlayerDetail?.injury_status && (
                  <div>
                    <dt>Injury</dt>
                    <dd data-testid="injury-detail">
                      {activePlayerDetail.injury_status}
                      {activePlayerDetail.injury_detail ? ` — ${activePlayerDetail.injury_detail}` : ''}
                      {activePlayerDetail.injury_updated_at && (
                        <span className="war-room__injury-freshness">
                          {' '}({formatFreshness(activePlayerDetail.injury_updated_at)})
                        </span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {activePlayerDetail?.aav_sources && activePlayerDetail.aav_sources.length > 0 && (
                <dl className="war-room__aav-sources" aria-label="AAV by source">
                  {activePlayerDetail.aav_sources.map((s) => (
                    <div key={s.source}>
                      <dt>{s.source}</dt>
                      <dd>{formatMoney(s.aav_minor)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {priorSeasonStats && (
                <dl className="war-room__prior-stats" aria-label="Prior season stats" data-testid="prior-season-stats">
                  {Object.entries(priorSeasonStats).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {teamId && (
                <form className="war-room__target-form" onSubmit={handleSetTarget}>
                  <label htmlFor="target-input">Set my target</label>
                  <span className="war-room__target-prefix">$</span>
                  <input
                    id="target-input"
                    type="number"
                    min={1}
                    value={targetDraft}
                    onChange={(e) => setTargetDraft(e.target.value)}
                    placeholder={myTarget ? String(Math.round(myTarget.target_value_minor / 100)) : 'e.g. 45'}
                  />
                  <button type="submit" disabled={!targetDraft}>Save</button>
                </form>
              )}
            </>
          ) : (
            <p className="war-room__idle">No auction active — waiting for the next nomination.</p>
          )}
        </section>

        {/* Zone B: Tier + Comparable */}
        <section className="war-room__panel war-room__tier-board" aria-label="Tier Board">
          <h2 className="war-room__panel-heading">Tier Board</h2>
          {auction && tierBoard.length > 0 ? (
            <ul className="war-room__player-list">
              <li className="war-room__player-list-item war-room__player-list-item--active">
                <span>{auction.player_name}</span>
                <span className="war-room__player-list-tag">ACTIVE</span>
              </li>
              {tierBoard.map((p) => (
                <li key={p.dataset_entry_id} className="war-room__player-list-item">
                  <span>{p.name}</span>
                  <span className="war-room__player-list-aav">{formatMoney(p.aav_minor)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="war-room__idle-small">No tier context yet.</p>
          )}

          <h3 className="war-room__panel-subheading">Comparable Remaining</h3>
          {comparable.length > 0 ? (
            <table className="war-room__comparable-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Tier</th>
                  <th>AAV</th>
                  <th>Proj</th>
                  <th>My Target</th>
                </tr>
              </thead>
              <tbody>
                {comparable.map((p) => {
                  const target = targets.find((t) => t.player_name === p.name) ?? null;
                  return (
                    <tr key={p.dataset_entry_id}>
                      <td>{p.name}</td>
                      <td>{p.tier ?? '—'}</td>
                      <td className="war-room__mono">{formatMoney(p.aav_minor)}</td>
                      <td className="war-room__mono">{p.projected_points != null ? p.projected_points.toFixed(1) : '—'}</td>
                      <td className="war-room__mono">{target ? formatMoney(target.target_value_minor) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="war-room__idle-small">—</p>
          )}
        </section>

        {/* Zone: My Preparation */}
        <section className="war-room__panel war-room__prep" aria-label="My Preparation">
          <div className="war-room__prep-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={prepTab === 'watchlist'}
              className={prepTab === 'watchlist' ? 'war-room__prep-tab--active' : ''}
              onClick={() => setPrepTab('watchlist')}
            >
              <Binoculars size={16} /> Watch
            </button>
            <button
              role="tab"
              aria-selected={prepTab === 'queue'}
              className={prepTab === 'queue' ? 'war-room__prep-tab--active' : ''}
              onClick={() => setPrepTab('queue')}
            >
              <ListNumbers size={16} /> Queue
            </button>
            <button
              role="tab"
              aria-selected={prepTab === 'targets'}
              className={prepTab === 'targets' ? 'war-room__prep-tab--active' : ''}
              onClick={() => setPrepTab('targets')}
            >
              <Target size={16} /> Targets
            </button>
            <button
              role="tab"
              aria-selected={prepTab === 'do-not-draft'}
              className={prepTab === 'do-not-draft' ? 'war-room__prep-tab--active' : ''}
              onClick={() => setPrepTab('do-not-draft')}
            >
              <Prohibit size={16} /> Do Not Draft
            </button>
          </div>

          {!teamId ? (
            <p className="war-room__idle-small">Preparation tools are private to a team session.</p>
          ) : (
            <>
              {prepTab === 'watchlist' && (
                <ul className="war-room__prep-list">
                  {watchlist.length === 0 && <li className="war-room__idle-small">Nothing watched yet.</li>}
                  {watchlist.map((w) => {
                    const hasCustomTarget = targets.some((t) => t.dataset_player_id === w.dataset_player_id);
                    const status = players.find((p) => p.name === w.player_name)?.injury_status;
                    return (
                    <li key={w.dataset_player_id} className="war-room__prep-item">
                      <span>
                        {w.player_name}
                        <span className="war-room__mono"> {formatMoney(w.aav_minor)}</span>
                        {hasCustomTarget && <span title="Custom target set"> ★</span>}
                        {status && <span className="war-room__watchlist-status"> · {status}</span>}
                      </span>
                      <div className="war-room__prep-actions">
                        {isMyNominationTurn && (
                          <button onClick={() => ws.nominate(w.dataset_player_id, 100)} className="war-room__prep-nominate">
                            Nominate
                          </button>
                        )}
                        <button
                          aria-label={`Remove ${w.player_name} from watch list`}
                          onClick={() => removeFromWatchlist(w.dataset_player_id)}
                          className="war-room__prep-remove"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                    );
                  })}
                  {auction && !watchlist.some((w) => w.player_name === auction.player_name) && (
                    <li className="war-room__prep-add">
                      <button onClick={() => addToWatchlist(players.find((p) => p.name === auction.player_name)?.dataset_entry_id ?? '')}>
                        + Watch {auction.player_name}
                      </button>
                    </li>
                  )}
                </ul>
              )}

              {prepTab === 'queue' && (
                <ul className="war-room__prep-list">
                  {queue.length === 0 && <li className="war-room__idle-small">Queue is empty.</li>}
                  {queue.map((q, i) => (
                    <li key={q.dataset_player_id} className="war-room__prep-item">
                      <span className="war-room__queue-pos">{i + 1}.</span>
                      <span>
                        {q.player_name}
                        {minBidMinor !== null && <span className="war-room__mono"> {formatMoney(minBidMinor)}</span>}
                        {drafted.has(q.player_name) && <span className="war-room__queue-drafted"> (drafted)</span>}
                      </span>
                      <div className="war-room__prep-actions">
                        <button aria-label="Move up" onClick={() => moveQueueItem(i, -1)} disabled={i === 0}>↑</button>
                        <button aria-label="Move down" onClick={() => moveQueueItem(i, 1)} disabled={i === queue.length - 1}>↓</button>
                        <button
                          aria-label={`Remove ${q.player_name} from queue`}
                          onClick={() => removeFromQueue(q.dataset_player_id)}
                          className="war-room__prep-remove"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                  {auction && !queue.some((q) => q.player_name === auction.player_name) && (
                    <li className="war-room__prep-add">
                      <button onClick={() => addToQueue(players.find((p) => p.name === auction.player_name)?.dataset_entry_id ?? '')}>
                        + Queue {auction.player_name}
                      </button>
                    </li>
                  )}
                </ul>
              )}

              {prepTab === 'targets' && (
                <>
                  <label className="war-room__targets-toggle">
                    <input
                      type="checkbox"
                      checked={showAllTargetablePlayers}
                      onChange={(e) => setShowAllTargetablePlayers(e.target.checked)}
                    />
                    {' '}All tracked players
                  </label>
                  <ul className="war-room__prep-list">
                    {!showAllTargetablePlayers ? (
                      <>
                        {targets.length === 0 && <li className="war-room__idle-small">No custom targets set.</li>}
                        {targets.map((t) => (
                          <li key={t.dataset_player_id} className="war-room__prep-item">
                            <span>{t.player_name}</span>
                            <span className="war-room__mono">{formatMoney(t.target_value_minor)}</span>
                          </li>
                        ))}
                      </>
                    ) : (
                      players.map((p) => {
                        const target = targets.find((t) => t.dataset_player_id === p.dataset_entry_id);
                        return (
                          <li key={p.dataset_entry_id} className="war-room__prep-item">
                            <span>{p.name}</span>
                            <span className="war-room__mono">{target ? formatMoney(target.target_value_minor) : ''}</span>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </>
              )}

              {prepTab === 'do-not-draft' && (
                <ul className="war-room__prep-list">
                  {doNotDraft.length === 0 && <li className="war-room__idle-small">No players on your Do Not Draft list.</li>}
                  {doNotDraft.map((d) => (
                    <li key={d.player_id} className="war-room__prep-item">
                      <span>{d.player_name ?? d.player_id}</span>
                      <button
                        aria-label={`Remove ${d.player_name ?? d.player_id} from Do Not Draft`}
                        onClick={() => removeFromDoNotDraft(d.player_id)}
                        className="war-room__prep-remove"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                  {auction && !doNotDraft.some((d) => d.player_name === auction.player_name) && (
                    <li className="war-room__prep-add">
                      <button onClick={() => addToDoNotDraft(players.find((p) => p.name === auction.player_name)?.dataset_entry_id ?? '')}>
                        + Do Not Draft {auction.player_name}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
        </section>

        {/* League Roster / Budget Grid — largest area */}
        <section className="war-room__panel war-room__roster-grid" aria-label="League Roster and Budget Grid">
          <h2 className="war-room__panel-heading">League Roster / Budget</h2>
          <div className="war-room__grid-scroll">
            <table className="war-room__grid-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>$</th>
                  <th>Max</th>
                  {rosterSlots.filter((s) => s.is_starter).map((s) => (
                    <th key={s.position}>{s.position}</th>
                  ))}
                  <th>Bench</th>
                  <th>Auto</th>
                </tr>
              </thead>
              <tbody>
                {rosterGrid.map((team) => (
                  <tr
                    key={team.team_id}
                    className={[
                      team.team_id === auction?.leading_team_id ? 'war-room__grid-row--leading' : '',
                      teamsWithOpenSlotForPosition.has(team.team_id) ? 'war-room__grid-row--open-slot' : '',
                      highestBudgetMinor !== null && team.remaining_budget_minor === highestBudgetMinor ? 'war-room__grid-row--top-budget' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <td className="war-room__grid-team-name">
                      <TeamIcon iconUrl={team.icon_url} className="war-room__team-icon" />
                      {team.team_name}
                    </td>
                    <td className="war-room__mono">{formatMoney(team.remaining_budget_minor)}</td>
                    <td className="war-room__mono">{formatMoney(team.max_legal_bid_minor)}</td>
                    {rosterSlots.filter((s) => s.is_starter).map((s) => {
                      const slot = team.slots.find((sl) => sl.position === s.position);
                      const isFull = slot ? slot.filled >= slot.total : false;
                      return (
                        <td key={s.position} className={isFull ? 'war-room__slot--filled' : 'war-room__slot--open'}>
                          {slot ? `${slot.filled}/${slot.total}` : '—'}
                        </td>
                      );
                    })}
                    <td>
                      {(() => {
                        const bench = team.slots.filter((s) => !s.is_starter);
                        const filled = bench.reduce((s, b) => s + b.filled, 0);
                        const total = bench.reduce((s, b) => s + b.total, 0);
                        return `${filled}/${total}`;
                      })()}
                    </td>
                    <td>{team.control_mode === 'AUTO_AGENT' ? <span className="war-room__auto-dot" title="Auto-Agent" /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent Activity */}
        <section className="war-room__panel war-room__activity" aria-label="Recent Auction Activity">
          <h2 className="war-room__panel-heading">Recent Activity</h2>
          {auction && (
            <div className="war-room__activity-active">
              <span className="war-room__activity-label">ACTIVE</span>
              <strong>{auction.player_name}</strong>
              <span className="war-room__mono">{formatMoney(auction.current_bid_minor)}</span>
            </div>
          )}
          <ul className="war-room__activity-list">
            {activity.map((a) => (
              <li key={a.acquisition_id} className="war-room__activity-item">
                <span className="war-room__activity-label war-room__activity-label--sold">SOLD</span>
                <div>
                  <strong>{a.player_name}</strong> — {formatMoney(a.price_minor)}
                  <div className="war-room__activity-meta">
                    {a.team_name} · {a.bid_count} {a.bid_count === 1 ? 'bid' : 'bids'} · {a.unique_bidder_count} {a.unique_bidder_count === 1 ? 'bidder' : 'bidders'}
                    {a.aav_diff_minor !== null && (
                      <span className={a.aav_diff_minor >= 0 ? 'war-room__aav-diff--over' : 'war-room__aav-diff--under'}>
                        {' '}· {a.aav_diff_minor >= 0 ? '+' : '−'}{formatMoney(Math.abs(a.aav_diff_minor))} vs AAV
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Market Context */}
        <section className="war-room__panel war-room__market" aria-label="Market Context">
          <h2 className="war-room__panel-heading">Market Context</h2>
          <dl className="war-room__market-stats">
            <div>
              <dt>League spent</dt>
              <dd className="war-room__mono">{formatMoney(marketContext.spentMinor)}</dd>
            </div>
            <div>
              <dt>Budget remaining league-wide</dt>
              <dd className="war-room__mono">{formatMoney(marketContext.totalBudgetMinor)}</dd>
            </div>
            <div>
              <dt>Avg. budget remaining</dt>
              <dd className="war-room__mono">{formatMoney(marketContext.avgBudgetMinor)}</dd>
            </div>
            <div>
              <dt>Actual vs AAV</dt>
              <dd className="war-room__mono" data-testid="market-aav-baseline">
                {marketContext.aavDiffMinor >= 0 ? '+' : '−'}{formatMoney(Math.abs(marketContext.aavDiffMinor))}
                {' '}({marketContext.aavDiffPct >= 0 ? '+' : ''}{marketContext.aavDiffPct.toFixed(1)}%)
              </dd>
            </div>
          </dl>
          {Object.keys(marketContext.draftedByPos).length > 0 && (
            <>
              <h3 className="war-room__panel-subheading">Drafted by position</h3>
              <ul className="war-room__market-positions">
                {Object.entries(marketContext.draftedByPos).map(([pos, n]) => (
                  <li key={pos}>
                    <span>{pos}</span>
                    <span className="war-room__mono">{n}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {Object.keys(marketContext.remainingByTier).length > 0 && (
            <>
              <h3 className="war-room__panel-subheading">Remaining by tier</h3>
              <ul className="war-room__market-positions" data-testid="market-remaining-by-tier">
                {Object.entries(marketContext.remainingByTier)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([tier, n]) => (
                    <li key={tier}>
                      <span>Tier {tier}</span>
                      <span className="war-room__mono">{n}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
