/**
 * Pre-Draft Lobby — shown to authenticated owners before the draft starts.
 * Displays: league name, scheduled start time (or status message), team name,
 * a commissioner status-message section, prep-tool tabs (mirroring War Room's
 * "My Preparation" tabs plus Auto-Agent and Do Not Draft), and the team
 * presentation media control (MOD-015).
 * Per screen-information-architecture.md §0.1.
 */
import React, { useEffect, useMemo, useState } from 'react';

import { TeamMediaUpload, type TeamMedia } from '../../components/TeamMediaUpload.js';
import './lobby.css';

export interface LobbyProps {
  leagueName: string;
  teamName: string;
  scheduledAt: string | null; // ISO-8601 string or null
  draftStatus: 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETE';
  leagueId?: string;
  teamId?: string | null;
  token?: string;
  draftId?: string | null;
  // MOD-010's leagues.status_message field doesn't exist yet — optional and
  // safe if undefined so this renders correctly today and picks up the real
  // value automatically once MOD-010 ships, without any change here.
  statusMessage?: string | null;
}

function formatScheduledTime(
  scheduledAt: string | null,
  draftStatus: LobbyProps['draftStatus'],
): string {
  if (!scheduledAt) return 'Not yet scheduled';

  const scheduled = new Date(scheduledAt);
  const now = new Date();

  if (draftStatus === 'CREATED' && scheduled < now) {
    return 'Waiting for commissioner to start';
  }

  return scheduled.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
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

interface DatasetPlayer {
  player_id: string;
  dataset_entry_id: string;
  name: string;
  position: string;
}

type PrepTab = 'watchlist' | 'queue' | 'targets' | 'auto-agent' | 'do-not-draft';

const PREP_TABS: Array<{ id: PrepTab; label: string }> = [
  { id: 'watchlist', label: 'Watch List' },
  { id: 'queue', label: 'Nomination Queue' },
  { id: 'targets', label: 'Target Values' },
  { id: 'auto-agent', label: 'Auto-Agent' },
  { id: 'do-not-draft', label: 'Do Not Draft' },
];

export function Lobby({
  leagueName,
  teamName,
  scheduledAt,
  draftStatus,
  leagueId,
  teamId,
  token,
  draftId,
  statusMessage,
}: LobbyProps): React.ReactElement {
  const timeText = formatScheduledTime(scheduledAt, draftStatus);
  const canUseDraftTools = Boolean(draftId && teamId && token);

  const [prepTab, setPrepTab] = useState<PrepTab>('watchlist');
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [doNotDraft, setDoNotDraft] = useState<DoNotDraftEntry[]>([]);
  const [players, setPlayers] = useState<DatasetPlayer[]>([]);
  const [willingnessPct, setWillingnessPct] = useState(0.8);
  const [media, setMedia] = useState<TeamMedia>({ icon_url: null, nomination_audio_url: null });

  const refreshWatchlist = useMemo(
    () => () => {
      if (!canUseDraftTools) return;
      authedJson<{ watchlist: WatchlistItem[] }>(`/drafts/${draftId}/teams/${teamId}/watchlist`, token!)
        .then((d) => setWatchlist(d.watchlist ?? []))
        .catch(() => {});
    },
    [canUseDraftTools, draftId, teamId, token],
  );
  const refreshQueue = useMemo(
    () => () => {
      if (!canUseDraftTools) return;
      authedJson<{ queue: QueueItem[] }>(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token!)
        .then((d) => setQueue(d.queue ?? []))
        .catch(() => {});
    },
    [canUseDraftTools, draftId, teamId, token],
  );
  const refreshTargets = useMemo(
    () => () => {
      if (!canUseDraftTools) return;
      authedJson<{ targets: TargetItem[] }>(`/drafts/${draftId}/teams/${teamId}/target-values`, token!)
        .then((d) => setTargets(d.targets ?? []))
        .catch(() => {});
    },
    [canUseDraftTools, draftId, teamId, token],
  );
  const refreshDoNotDraft = useMemo(
    () => () => {
      if (!canUseDraftTools) return;
      authedJson<{ entries: DoNotDraftEntry[] }>(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token!)
        .then((d) => setDoNotDraft(d.entries ?? []))
        .catch(() => {});
    },
    [canUseDraftTools, draftId, teamId, token],
  );

  useEffect(() => {
    refreshWatchlist();
    refreshQueue();
    refreshTargets();
    refreshDoNotDraft();
  }, [refreshWatchlist, refreshQueue, refreshTargets, refreshDoNotDraft]);

  useEffect(() => {
    if (!leagueId || !token) return;
    authedJson<{ players: DatasetPlayer[] }>(`/leagues/${leagueId}/players`, token)
      .then((d) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [leagueId, token]);

  // Seed the media control with whatever's already stored, so a returning
  // owner sees "Replace"/"Remove" instead of "Upload" for media they already
  // set. There's no standalone GET for a single team's media (F-MOD-015 only
  // has POST/DELETE) — the roster grid (already owner-accessible) carries it.
  useEffect(() => {
    if (!canUseDraftTools) return;
    authedJson<{ teams: Array<{ team_id: string; icon_url: string | null }> }>(
      `/drafts/${draftId}/roster-grid`,
      token!,
    )
      .then((d) => {
        const mine = d.teams?.find((t) => t.team_id === teamId);
        if (mine) setMedia((prev) => ({ ...prev, icon_url: mine.icon_url }));
      })
      .catch(() => {});
  }, [canUseDraftTools, draftId, teamId, token]);

  function removeFromWatchlist(playerId: string): void {
    if (!canUseDraftTools) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist/${playerId}`, token!, { method: 'DELETE' })
      .then(refreshWatchlist)
      .catch(() => {});
  }

  function addToWatchlist(playerId: string): void {
    if (!canUseDraftTools || !playerId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/watchlist`, token!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_player_id: playerId }),
    })
      .then(refreshWatchlist)
      .catch(() => {});
  }

  function removeFromQueue(playerId: string): void {
    if (!canUseDraftTools) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue/${playerId}`, token!, { method: 'DELETE' })
      .then(refreshQueue)
      .catch(() => {});
  }

  function addToQueue(playerId: string): void {
    if (!canUseDraftTools || !playerId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_player_id: playerId }),
    })
      .then(refreshQueue)
      .catch(() => {});
  }

  function reorderQueue(newOrder: string[]): void {
    if (!canUseDraftTools) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/nomination-queue`, token!, {
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

  function addToDoNotDraft(playerId: string): void {
    if (!canUseDraftTools || !playerId) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft`, token!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    })
      .then(refreshDoNotDraft)
      .catch(() => {});
  }

  function removeFromDoNotDraft(playerId: string): void {
    if (!canUseDraftTools) return;
    authedJson(`/drafts/${draftId}/teams/${teamId}/do-not-draft/${playerId}`, token!, { method: 'DELETE' })
      .then(refreshDoNotDraft)
      .catch(() => {});
  }

  function submitWillingness(e: React.FormEvent): void {
    e.preventDefault();
    if (!canUseDraftTools) return;
    authedJson<{ team_id: string; willingness_pct: number }>(
      `/drafts/${draftId}/teams/${teamId}/auto-agent`,
      token!,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ willingness_pct: willingnessPct }),
      },
    )
      // No GET endpoint exists for auto-agent config (F-MOD-004 only exposes
      // PUT/PATCH) — the PUT response itself is the "read back" source of truth.
      .then((d) => setWillingnessPct(d.willingness_pct))
      .catch(() => {});
  }

  return (
    <main className="lobby">
      <header className="lobby__header">
        <h1 className="lobby__league-name">{leagueName}</h1>
      </header>

      <section className="lobby__team" aria-label="Your team">
        <h2 className="lobby__team-name">{teamName}</h2>
      </section>

      <section className="lobby__draft-info" aria-label="Draft schedule">
        <p className="lobby__scheduled-time" data-testid="scheduled-time">
          {timeText}
        </p>
      </section>

      {statusMessage && (
        <section className="lobby__status-message" aria-label="Commissioner status message" data-testid="status-message">
          {statusMessage}
        </section>
      )}

      {leagueId && teamId && token && (
        <section className="lobby__media" aria-label="Team presentation">
          <h2 className="lobby__section-heading">Team Presentation</h2>
          <TeamMediaUpload leagueId={leagueId} teamId={teamId} token={token} media={media} onChange={setMedia} />
        </section>
      )}

      <section className="lobby__prep" aria-label="Prep Tools">
        <div className="lobby__prep-tabs" role="tablist">
          {PREP_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={prepTab === t.id}
              className={prepTab === t.id ? 'lobby__prep-tab--active' : ''}
              onClick={() => setPrepTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!canUseDraftTools ? (
          <p className="lobby__prep-unavailable">
            Prep tools become available once the draft has been created.
          </p>
        ) : (
          <>
            {prepTab === 'watchlist' && (
              <ul className="lobby__prep-list">
                {watchlist.length === 0 && <li className="lobby__idle-small">Nothing watched yet.</li>}
                {watchlist.map((w) => (
                  <li key={w.dataset_player_id} className="lobby__prep-item">
                    <span>{w.player_name}</span>
                    <button aria-label={`Remove ${w.player_name} from watch list`} onClick={() => removeFromWatchlist(w.dataset_player_id)}>
                      Remove
                    </button>
                  </li>
                ))}
                <PlayerPicker
                  players={players}
                  excludeIds={watchlist.map((w) => w.dataset_player_id)}
                  onAdd={addToWatchlist}
                  addLabel="Add to Watch List"
                />
              </ul>
            )}

            {prepTab === 'queue' && (
              <ul className="lobby__prep-list">
                {queue.length === 0 && <li className="lobby__idle-small">Queue is empty.</li>}
                {queue.map((q, i) => (
                  <li key={q.dataset_player_id} className="lobby__prep-item">
                    <span>{i + 1}. {q.player_name}</span>
                    <div>
                      <button aria-label="Move up" onClick={() => moveQueueItem(i, -1)} disabled={i === 0}>↑</button>
                      <button aria-label="Move down" onClick={() => moveQueueItem(i, 1)} disabled={i === queue.length - 1}>↓</button>
                      <button aria-label={`Remove ${q.player_name} from queue`} onClick={() => removeFromQueue(q.dataset_player_id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
                <PlayerPicker
                  players={players}
                  excludeIds={queue.map((q) => q.dataset_player_id)}
                  onAdd={addToQueue}
                  addLabel="Add to Queue"
                />
              </ul>
            )}

            {prepTab === 'targets' && (
              <ul className="lobby__prep-list">
                {targets.length === 0 && <li className="lobby__idle-small">No custom targets set.</li>}
                {targets.map((t) => (
                  <li key={t.dataset_player_id} className="lobby__prep-item">
                    <span>{t.player_name}</span>
                    <span>${Math.round(t.target_value_minor / 100)}</span>
                  </li>
                ))}
              </ul>
            )}

            {prepTab === 'auto-agent' && (
              <form className="lobby__auto-agent-form" onSubmit={submitWillingness}>
                <label htmlFor="willingness-slider">Willingness ceiling ({Math.round(willingnessPct * 100)}%)</label>
                <input
                  id="willingness-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={willingnessPct}
                  onChange={(e) => setWillingnessPct(parseFloat(e.target.value))}
                />
                <button type="submit">Save</button>
              </form>
            )}

            {prepTab === 'do-not-draft' && (
              <ul className="lobby__prep-list">
                {doNotDraft.length === 0 && <li className="lobby__idle-small">No players on your Do Not Draft list.</li>}
                {doNotDraft.map((d) => (
                  <li key={d.player_id} className="lobby__prep-item">
                    <span>{d.player_name ?? d.player_id}</span>
                    <button aria-label={`Remove ${d.player_name ?? d.player_id} from Do Not Draft`} onClick={() => removeFromDoNotDraft(d.player_id)}>
                      Remove
                    </button>
                  </li>
                ))}
                <PlayerPicker
                  players={players}
                  excludeIds={doNotDraft.map((d) => d.player_id)}
                  onAdd={addToDoNotDraft}
                  addLabel="Add to Do Not Draft"
                />
              </ul>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function PlayerPicker({
  players,
  excludeIds,
  onAdd,
  addLabel,
}: {
  players: DatasetPlayer[];
  excludeIds: string[];
  onAdd: (playerId: string) => void;
  addLabel: string;
}): React.ReactElement | null {
  const [selected, setSelected] = useState('');
  const available = players.filter((p) => !excludeIds.includes(p.dataset_entry_id));
  if (available.length === 0) return null;

  return (
    <li className="lobby__prep-item">
      <select aria-label={addLabel} value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Select a player…</option>
        {available.map((p) => (
          <option key={p.dataset_entry_id} value={p.dataset_entry_id}>{p.name}</option>
        ))}
      </select>
      <button
        onClick={() => {
          onAdd(selected);
          setSelected('');
        }}
        disabled={!selected}
      >
        {addLabel}
      </button>
    </li>
  );
}
