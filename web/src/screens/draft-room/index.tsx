/**
 * Draft Room — the primary live-auction view (screen-information-architecture.md §2).
 * Lowest-cognitive-load screen in the product: what's happening right now, and
 * what should I do in the next few seconds. Server is authoritative for every
 * price/deadline/winner here — this component only renders what it broadcasts.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WifiHigh, WifiMedium, WifiSlash, Robot } from '@phosphor-icons/react';

import { useAuctionSocket } from '../../lib/useAuctionSocket.js';
import { NominationAudioPlayer } from '../../components/NominationAudioPlayer.js';
import { TeamIcon } from '../../components/TeamIcon.js';
import { AuctionCloseCard } from '../../components/AuctionCloseCard.js';
import { PlayerDetailPopover } from '../../components/PlayerDetailPopover.js';
import type { AwardEntry } from '../../lib/useAuctionSocket.js';
import './draft-room.css';

interface DraftRoomProps {
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

interface DraftConfig {
  roster: { total_roster_size: number; bench_slots: number } | null;
  roster_slots: RosterSlotDef[];
  auction: { initial_budget_minor: number; min_bid_minor: number } | null;
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
}

interface DatasetPlayer {
  player_id: string;
  dataset_entry_id: string;
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  tier: number | null;
  projected_points: number | null;
  injury_status?: string | null;
  injury_detail?: string | null;
  injury_updated_at?: string | null;
  bye_week?: number | null;
  prior_season_stats?: unknown;
  aav_sources?: AavSourceEntry[];
}

interface TargetItem {
  dataset_player_id: string;
  target_value_minor: number;
  player_name: string;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

/** Mirrors server/src/auction/engine.ts's assignRosterSlot ordering + eligibility
 * for a client-side preview only — the server always makes the real assignment. */
function computeWouldFill(slots: RosterSlotDef[], filled: GridSlot[], playerPosition: string): string {
  const filledByPos = new Map(filled.map((s) => [s.position, s.filled]));
  const ordered = [...slots].sort((a, b) =>
    a.is_starter === b.is_starter ? a.priority - b.priority : a.is_starter ? -1 : 1,
  );
  const pos = playerPosition.toUpperCase();
  for (const slot of ordered) {
    const slotPos = slot.position.toUpperCase();
    const alreadyFilled = filledByPos.get(slot.position) ?? 0;
    if (alreadyFilled >= slot.slot_count) continue;
    if (slotPos === pos || slotPos === 'BN' || slotPos === 'BENCH' || slotPos === 'SUPERFLEX' || (slotPos === 'FLEX' && ['RB', 'WR', 'TE'].includes(pos))) {
      return slot.is_starter ? slot.position : 'BENCH';
    }
  }
  return '—';
}

function useCountdown(deadlineTs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadlineTs) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadlineTs]);
  if (!deadlineTs) return 0;
  return Math.max(0, Math.round((deadlineTs - now) / 1000));
}

export function DraftRoom({ draftId, leagueId, token, teamId }: DraftRoomProps): React.ReactElement {
  const ws = useAuctionSocket(draftId, token);
  const navigate = useNavigate();
  const [config, setConfig] = useState<DraftConfig | null>(null);
  const [rosterGrid, setRosterGrid] = useState<GridTeam[]>([]);
  const [players, setPlayers] = useState<DatasetPlayer[]>([]);
  const [customAmount, setCustomAmount] = useState('');
  const [nominateSearch, setNominateSearch] = useState('');
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [closeCardAward, setCloseCardAward] = useState<AwardEntry | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const awardCountRef = useRef(0);

  useEffect(() => {
    fetch(`/drafts/${draftId}/config`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
    fetch(`/leagues/${leagueId}/players`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d: { players: DatasetPlayer[] }) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [draftId, leagueId, token]);

  useEffect(() => {
    if (!teamId) return;
    fetch(`/drafts/${draftId}/teams/${teamId}/target-values`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d: { targets: TargetItem[] }) => setTargets(d.targets ?? []))
      .catch(() => {});
  }, [draftId, teamId, token]);

  // A close card is ephemeral overlay state, independent of the nomination
  // flow underneath — new awards prepend to recentAwards, so the newest is
  // always index 0 (PRD.md §29).
  useEffect(() => {
    if (ws.recentAwards.length > 0) {
      setCloseCardAward(ws.recentAwards[0]!);
    }
  }, [ws.recentAwards.length]);

  // The popover is scoped to whichever player is currently up for auction —
  // close it rather than let it silently show stale data for a new player.
  useEffect(() => {
    setShowPopover(false);
  }, [ws.currentAuction?.player_auction_id]);

  const refreshGrid = useMemo(
    () => () => {
      fetch(`/drafts/${draftId}/roster-grid`, { headers: { authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((d: { teams: GridTeam[] }) => setRosterGrid(d.teams ?? []))
        .catch(() => {});
    },
    [draftId, token],
  );

  useEffect(() => {
    refreshGrid();
  }, [refreshGrid]);

  useEffect(() => {
    if (ws.recentAwards.length !== awardCountRef.current) {
      awardCountRef.current = ws.recentAwards.length;
      refreshGrid();
    }
  }, [ws.recentAwards.length, refreshGrid]);

  // Covers both the live DRAFT_COMPLETE broadcast for an already-connected
  // client and the reconnect-snapshot case (STATE_SNAPSHOT also carries
  // draftStatus: 'COMPLETE') — replaces the old dead-end inline message.
  useEffect(() => {
    if (ws.draftStatus === 'COMPLETE') {
      navigate(`/draft-complete?draftId=${draftId}`, { replace: true });
    }
  }, [ws.draftStatus, draftId, navigate]);

  const drafted = useMemo(() => new Set(ws.recentAwards.map((a) => a.player_name)), [ws.recentAwards]);
  const myGridTeam = teamId ? rosterGrid.find((t) => t.team_id === teamId) ?? null : null;

  const auction = ws.currentAuction;
  // Neither leading_team_id (the nominator leads at the opening price from
  // creation) nor rebid_deadline_ts (pre-populated at creation, dual-purpose
  // column) can tell second-bid from rebid phase. auction_version can:
  // engine.ts creates every auction at version 1 and increments on the first
  // accepted competing bid, so ===1 means "nobody has bid against the
  // nominator yet" reliably.
  const isSecondBid = !!auction && auction.auction_version === 1;
  const deadline = auction ? (isSecondBid ? auction.nomination_deadline_ts : auction.rebid_deadline_ts) : null;
  const secondsLeft = useCountdown(deadline);

  const wouldFill = useMemo(() => {
    if (!auction || !config || !myGridTeam) return null;
    return computeWouldFill(config.roster_slots, myGridTeam.slots, auction.position);
  }, [auction, config, myGridTeam]);

  const scarcity = useMemo(() => {
    if (!auction || auction.tier === null) return null;
    const remaining = players.filter(
      (p) => p.position === auction.position && p.tier === auction.tier && !drafted.has(p.name) && p.name !== auction.player_name,
    ).length;
    return remaining;
  }, [auction, players, drafted]);

  const activePlayerDetail = useMemo(
    () => (auction ? players.find((p) => p.name === auction.player_name) ?? null : null),
    [auction, players],
  );

  // Mechanically selected: same position + same tier, not yet drafted, per
  // the popover's "comparable remaining players" requirement — same approach
  // War Room's tierBoard/comparable lists already use.
  const comparablePlayers = useMemo(() => {
    if (!auction || auction.tier === null) return [];
    return players
      .filter((p) => p.position === auction.position && p.tier === auction.tier && !drafted.has(p.name) && p.name !== auction.player_name)
      .sort((a, b) => b.aav_minor - a.aav_minor)
      .slice(0, 6);
  }, [auction, players, drafted]);

  const myTargetValueMinor = useMemo(() => {
    if (!auction) return null;
    return targets.find((t) => t.player_name === auction.player_name)?.target_value_minor ?? null;
  }, [auction, targets]);

  // Stable identity: the countdown timers re-render DraftRoom every 200ms
  // while a nomination deadline is active, so an inline arrow here would
  // reset AuctionCloseCard's auto-dismiss effect on every tick.
  const dismissCloseCard = useCallback(() => setCloseCardAward(null), []);

  const closeCardTeamName = closeCardAward
    ? rosterGrid.find((t) => t.team_id === closeCardAward.winning_team_id)?.team_name ?? 'Unknown team'
    : '';

  const isLeading = !!(auction && teamId && auction.leading_team_id === teamId);
  const isNominatorOfOpen = !!(auction && teamId && auction.nominator_team_id === teamId);
  const canPlaceBid = !!(auction && teamId && !isLeading && ws.draftStatus === 'RUNNING');
  const canMatch = !!(
    auction &&
    teamId &&
    ws.nominatorMatchAvailable &&
    isNominatorOfOpen &&
    !isLeading &&
    !isSecondBid // only meaningful once someone has actually outbid the opening price
  );

  const isMyNominationTurn = !auction && teamId !== null && ws.currentNominatorTeamId === teamId;
  const nominationSecondsLeft = useCountdown(!auction ? ws.nominationDeadlineTs : null);

  const availablePlayers = useMemo(() => {
    if (!nominateSearch.trim()) return [];
    const q = nominateSearch.toLowerCase();
    return players
      .filter((p) => !drafted.has(p.name) && p.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [players, drafted, nominateSearch]);

  function handlePlusOne(): void {
    if (!auction) return;
    ws.bid(auction.player_auction_id, auction.current_bid_minor + 100, 'RELATIVE');
  }

  function handleCustomBid(e: React.FormEvent): void {
    e.preventDefault();
    if (!auction) return;
    const amount = Math.round(parseFloat(customAmount) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return;
    ws.bid(auction.player_auction_id, amount, 'ABSOLUTE');
    setCustomAmount('');
  }

  function handleNominate(entryId: string, aavMinor: number): void {
    ws.nominate(entryId, Math.max(config?.auction?.min_bid_minor ?? 100, 100));
    void aavMinor;
    setNominateSearch('');
  }

  const connectionMeta: Record<string, { icon: typeof WifiHigh; label: string }> = {
    open: { icon: WifiHigh, label: 'Live' },
    connecting: { icon: WifiMedium, label: 'Connecting…' },
    reconnecting: { icon: WifiSlash, label: 'Reconnecting…' },
    closed: { icon: WifiSlash, label: 'Offline' },
  };
  const connMeta = connectionMeta[ws.connectionStatus] ?? connectionMeta['closed']!;
  const ConnIcon = connMeta.icon;

  return (
    <div className="draft-room">
      <NominationAudioPlayer cue={ws.nominationAudioCue} />
      {closeCardAward && (
        <AuctionCloseCard
          award={closeCardAward}
          winningTeamName={closeCardTeamName}
          onDismiss={dismissCloseCard}
        />
      )}
      {showPopover && auction && activePlayerDetail && (
        <PlayerDetailPopover
          player={activePlayerDetail}
          targetValueMinor={myTargetValueMinor}
          comparables={comparablePlayers}
          onClose={() => setShowPopover(false)}
        />
      )}
      <header className="draft-room__topbar">
        <span className="draft-room__title">Draft Room</span>
        <div className="draft-room__health">
          {ws.draftStatus === 'PAUSED' && <span className="draft-room__paused-badge">PAUSED</span>}
          {teamId && myGridTeam?.control_mode === 'AUTO_AGENT' && (
            <span className="draft-room__auto-badge" data-testid="auto-agent-badge">
              <Robot size={14} weight="bold" /> AUTO
            </span>
          )}
          <span
            className={`draft-room__conn draft-room__conn--${ws.connectionStatus}`}
            data-testid="connection-status"
          >
            <ConnIcon size={14} weight="bold" /> {connMeta.label}
          </span>
        </div>
      </header>

      <div className="draft-room__layout">
        <aside className="draft-room__team-context" aria-label="My Team">
          <h2 className="draft-room__panel-heading">
            <TeamIcon iconUrl={myGridTeam?.icon_url ?? null} className="draft-room__team-icon" />
            My Team
          </h2>
          {myGridTeam ? (
            <dl className="draft-room__stat-list">
              <div className="draft-room__stat">
                <dt>Budget</dt>
                <dd data-testid="my-budget">{formatMoney(myGridTeam.remaining_budget_minor)}</dd>
              </div>
              <div className="draft-room__stat">
                <dt>Max bid</dt>
                <dd data-testid="my-max-bid">{formatMoney(myGridTeam.max_legal_bid_minor)}</dd>
              </div>
              <div className="draft-room__stat">
                <dt>Roster</dt>
                <dd>
                  {myGridTeam.roster_filled_count} / {config?.roster?.total_roster_size ?? '—'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="draft-room__spectator-note">
              {teamId ? 'Loading…' : 'Viewing without bidding rights.'}
            </p>
          )}

          {auction && wouldFill && (
            <div className="draft-room__would-fill">
              <span className="draft-room__would-fill-label">If won</span>
              <strong className="draft-room__would-fill-value">{wouldFill}</strong>
            </div>
          )}
        </aside>

        <main className="draft-room__active-auction" aria-label="Active Auction">
          {!auction ? (
            <div className="draft-room__no-auction">
              {ws.draftStatus === 'COMPLETE' ? (
                <p>Draft complete — opening the summary report…</p>
              ) : isMyNominationTurn ? (
                <div className="draft-room__nominate-panel">
                  <p className="draft-room__your-turn">Your turn to nominate</p>
                  {nominationSecondsLeft > 0 && (
                    <p className="draft-room__nominate-timer">{nominationSecondsLeft}s</p>
                  )}
                  <input
                    className="draft-room__nominate-search"
                    type="text"
                    placeholder="Search a player to nominate…"
                    value={nominateSearch}
                    onChange={(e) => setNominateSearch(e.target.value)}
                    aria-label="Search players to nominate"
                    data-testid="nominate-search"
                  />
                  {availablePlayers.length > 0 && (
                    <ul className="draft-room__nominate-results">
                      {availablePlayers.map((p) => (
                        <li key={p.dataset_entry_id}>
                          <button
                            className="draft-room__nominate-result"
                            onClick={() => handleNominate(p.dataset_entry_id, p.aav_minor)}
                            data-testid={`nominate-${p.dataset_entry_id}`}
                          >
                            <span>{p.name}</span>
                            <span className="draft-room__nominate-meta">
                              {p.position} · {p.nfl_team} · AAV {formatMoney(p.aav_minor)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p>Waiting for the next nomination…</p>
              )}
            </div>
          ) : (
            <>
              <div className="draft-room__player">
                <h1 className="draft-room__player-name">
                  <button
                    type="button"
                    className="draft-room__player-name-btn"
                    data-testid="active-player-name"
                    onClick={() => setShowPopover(true)}
                    aria-label={`View details for ${auction.player_name}`}
                  >
                    {auction.player_name}
                  </button>
                  {activePlayerDetail?.injury_status && (
                    <span className="draft-room__injury-indicator" data-testid="injury-indicator" title={activePlayerDetail.injury_status}>
                      {activePlayerDetail.injury_status}
                    </span>
                  )}
                </h1>
                <p className="draft-room__player-meta">
                  {auction.position} · {auction.nfl_team}
                  {auction.tier !== null && ` · Tier ${auction.tier}`}
                </p>
                <p className="draft-room__player-aav">AAV {formatMoney(auction.aav_minor)}</p>
              </div>

              <div className="draft-room__price-block">
                <span className="draft-room__phase-badge">{isSecondBid ? 'SECOND BID' : 'REBID'}</span>
                <div className="draft-room__current-bid" data-testid="current-bid">
                  {formatMoney(auction.current_bid_minor)}
                </div>
                <div className="draft-room__leader" data-testid="current-leader">
                  {isSecondBid ? 'Nominated by ' : 'Leading: '}
                  {rosterGrid.find((t) => t.team_id === auction.leading_team_id)?.team_name ?? 'Unknown team'}
                </div>
                <div className={`draft-room__timer${secondsLeft <= 5 ? ' draft-room__timer--urgent' : ''}`} data-testid="timer">
                  {secondsLeft}s
                </div>
              </div>

              {ws.lastError && (
                <div className="draft-room__bid-error" role="alert" data-testid="bid-error">
                  {ws.lastError.reason}
                  <button onClick={ws.clearError} aria-label="Dismiss">×</button>
                </div>
              )}

              <div className="draft-room__bid-controls" aria-label="Bid controls">
                <button
                  className="draft-room__bid-btn draft-room__bid-btn--plus-one"
                  onClick={handlePlusOne}
                  disabled={!canPlaceBid}
                  data-testid="plus-one-button"
                >
                  +$1 → {formatMoney(auction.current_bid_minor + 100)}
                </button>

                <form className="draft-room__custom-bid" onSubmit={handleCustomBid}>
                  <span className="draft-room__custom-bid-prefix">$</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="Custom"
                    aria-label="Custom bid amount"
                    disabled={!canPlaceBid}
                    data-testid="custom-bid-input"
                  />
                  <button type="submit" disabled={!canPlaceBid || !customAmount} data-testid="custom-bid-submit">
                    BID
                  </button>
                </form>

                {canMatch && (
                  <button className="draft-room__match-btn" onClick={ws.nominatorMatch} data-testid="match-button">
                    MATCH {formatMoney(auction.current_bid_minor)}
                  </button>
                )}

                {isLeading && <p className="draft-room__leading-note">You're winning this auction.</p>}
              </div>

              {scarcity !== null && (
                <p className="draft-room__scarcity" data-testid="scarcity">
                  {auction.position} Tier {auction.tier} · {scarcity} remaining
                </p>
              )}
            </>
          )}
        </main>

        <aside className="draft-room__recent-bids" aria-label="Recent Bids">
          <h2 className="draft-room__panel-heading">Recent Bids</h2>
          {ws.bidLadder.length === 0 ? (
            <p className="draft-room__no-bids">No bids yet.</p>
          ) : (
            <ol className="draft-room__bid-ladder" data-testid="bid-ladder">
              {ws.bidLadder.map((entry, i) => (
                <li key={`${entry.at_ts}-${i}`} className="draft-room__bid-ladder-item">
                  <span className="draft-room__bid-ladder-amount">{formatMoney(entry.bid_amount_minor)}</span>
                  <span className="draft-room__bid-ladder-team">
                    {rosterGrid.find((t) => t.team_id === entry.team_id)?.team_name ?? '—'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
