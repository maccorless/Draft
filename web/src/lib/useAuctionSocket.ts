/**
 * Live auction WebSocket client — shared by Draft Room and War Room.
 *
 * Each screen opens its own independent connection (per PRD: Draft Room and
 * War Room are synchronized windows sharing one team identity, not a shared
 * connection) and authenticates with the same session token. The server is
 * the sole source of truth for prices/deadlines/winners; this hook only
 * mirrors what it broadcasts — it never computes outcomes locally.
 */
import { useEffect, useReducer, useRef, useCallback } from 'react';

// ─── Server -> client shapes (mirrors server/src/session/routes.ts + the WS
//     event payloads engine.ts/auto-agent.ts/corrections.ts/whammy.ts send) ──

export interface SnapshotTeam {
  team_id: string;
  remaining_budget_minor: number;
  roster_filled_count: number;
  control_mode: 'MANUAL' | 'AUTO_AGENT';
}

export interface CurrentAuction {
  player_auction_id: string;
  current_bid_minor: number;
  leading_team_id: string | null;
  auction_version: number;
  nomination_deadline_ts: number;
  rebid_deadline_ts: number;
  nominator_team_id: string | null;
  player_name: string;
  position: string;
  nfl_team: string;
  tier: number | null;
  aav_minor: number;
  projected_points: number | null;
}

export interface BidLadderEntry {
  bid_amount_minor: number;
  team_id: string;
  at_ts: number;
  is_match: boolean;
}

export interface AwardEntry {
  player_auction_id: string;
  player_name: string;
  winning_team_id: string;
  price_minor: number;
  roster_slot: string;
  resolution_sequence: number;
  accepted_bid_count: number;
  unique_bidder_count: number;
  aav_minor: number;
  remaining_budget_minor: number;
}

export interface NominationAudioCue {
  team_id: string;
  audio_url: string;
  duration_cap_ms: number;
  /** Distinguishes repeat cues for the same team_id/url so a consumer's useEffect re-fires. */
  receivedAt: number;
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface AuctionState {
  connectionStatus: ConnectionStatus;
  draftStatus: string | null;
  teams: Record<string, SnapshotTeam>;
  currentAuction: CurrentAuction | null;
  bidLadder: BidLadderEntry[];
  nominatorMatchAvailable: boolean;
  currentNominatorTeamId: string | null;
  nominationDeadlineTs: number | null;
  recentAwards: AwardEntry[];
  asOfSequence: number;
  lastError: { code: string; reason: string } | null;
  nominationAudioCue: NominationAudioCue | null;
}

const initialState: AuctionState = {
  connectionStatus: 'connecting',
  draftStatus: null,
  teams: {},
  currentAuction: null,
  bidLadder: [],
  nominatorMatchAvailable: true,
  currentNominatorTeamId: null,
  nominationDeadlineTs: null,
  recentAwards: [],
  asOfSequence: -1,
  lastError: null,
  nominationAudioCue: null,
};

type Action =
  | { type: 'CONNECTION'; status: ConnectionStatus }
  | { type: 'MESSAGE'; msg: { type: string; payload?: Record<string, unknown> } }
  | { type: 'CLEAR_ERROR' };

function reducer(state: AuctionState, action: Action): AuctionState {
  if (action.type === 'CONNECTION') {
    return { ...state, connectionStatus: action.status };
  }
  if (action.type === 'CLEAR_ERROR') {
    return { ...state, lastError: null };
  }

  const { msg } = action;
  const p = msg.payload ?? {};

  switch (msg.type) {
    case 'STATE_SNAPSHOT': {
      const teams: Record<string, SnapshotTeam> = {};
      for (const t of (p['teams'] as SnapshotTeam[] | undefined) ?? []) {
        teams[t.team_id] = t;
      }
      const auction = (p['current_auction'] as CurrentAuction | null) ?? null;
      return {
        ...state,
        teams,
        currentAuction: auction,
        // Between auctions there's no NOMINATION_TURN_CHANGED to have heard yet,
        // so the snapshot's own current_nominator_team_id is the only source.
        currentNominatorTeamId: auction?.nominator_team_id ?? (p['current_nominator_team_id'] as string | null) ?? null,
        nominationDeadlineTs: auction?.nomination_deadline_ts ?? null,
        draftStatus: (p['status'] as string) ?? state.draftStatus,
        asOfSequence: (p['as_of_sequence'] as number) ?? state.asOfSequence,
        bidLadder: [],
      };
    }

    case 'NOMINATION_STARTED': {
      return {
        ...state,
        currentAuction: {
          player_auction_id: String(p['player_auction_id']),
          current_bid_minor: Number(p['opening_bid_minor']),
          // The nominator IS the leader at the opening price from creation
          // (server/src/auction/engine.ts's INSERT sets current_leader_id =
          // the nominator, auction_version = 1) — never null/0. Getting this
          // wrong here means every first competing bid gets rejected as
          // stale (expected_auction_version mismatch against the DB).
          leading_team_id: String(p['nominator_team_id']),
          auction_version: 1,
          nomination_deadline_ts: Number(p['nomination_deadline_ts']),
          // The DB column this mirrors is dual-purpose: engine.ts's INSERT
          // pre-populates it with the second-bid deadline (not null), then
          // overwrites it with the real rebid deadline once a competing bid
          // lands. So it's NOT a reliable "has anyone bid yet" signal —
          // auction_version (1 at creation, 2+ after the first bid) is; see
          // DraftRoom's isSecondBid.
          rebid_deadline_ts: Number(p['second_bid_deadline_ts']),
          nominator_team_id: String(p['nominator_team_id']),
          player_name: String(p['player_name']),
          position: String(p['position'] ?? ''),
          nfl_team: String(p['nfl_team'] ?? ''),
          tier: (p['tier'] as number | null) ?? null,
          aav_minor: Number(p['aav_minor'] ?? 0),
          projected_points: (p['projected_points'] as number | null) ?? null,
        },
        currentNominatorTeamId: String(p['nominator_team_id']),
        nominationDeadlineTs: Number(p['nomination_deadline_ts']),
        nominatorMatchAvailable: true,
        bidLadder: [],
      };
    }

    case 'BID_ACCEPTED': {
      if (!state.currentAuction || state.currentAuction.player_auction_id !== p['player_auction_id']) {
        return state;
      }
      const entry: BidLadderEntry = {
        bid_amount_minor: Number(p['bid_amount_minor']),
        team_id: String(p['leading_team_id']),
        at_ts: Date.now(),
        is_match: false,
      };
      return {
        ...state,
        currentAuction: {
          ...state.currentAuction,
          current_bid_minor: entry.bid_amount_minor,
          leading_team_id: entry.team_id,
          auction_version: Number(p['auction_version']),
          rebid_deadline_ts: Number(p['rebid_deadline_ts']),
        },
        bidLadder: [entry, ...state.bidLadder].slice(0, 10),
      };
    }

    case 'NOMINATOR_MATCH_USED': {
      if (!state.currentAuction) return state;
      return {
        ...state,
        currentAuction: {
          ...state.currentAuction,
          current_bid_minor: Number(p['bid_amount_minor'] ?? state.currentAuction.current_bid_minor),
          leading_team_id: String(p['team_id'] ?? state.currentAuction.leading_team_id),
        },
        nominatorMatchAvailable: false,
      };
    }

    case 'PLAYER_AWARDED': {
      const award: AwardEntry = {
        player_auction_id: String(p['player_auction_id']),
        player_name: String(p['player_name']),
        winning_team_id: String(p['winning_team_id']),
        price_minor: Number(p['price_minor']),
        roster_slot: String(p['roster_slot']),
        resolution_sequence: Number(p['resolution_sequence']),
        accepted_bid_count: Number(p['accepted_bid_count'] ?? 0),
        unique_bidder_count: Number(p['unique_bidder_count'] ?? 0),
        aav_minor: Number(p['aav_minor'] ?? 0),
        remaining_budget_minor: Number(p['remaining_budget_minor'] ?? 0),
      };
      const teamId = award.winning_team_id;
      const prevTeam = state.teams[teamId];
      return {
        ...state,
        currentAuction: null,
        bidLadder: [],
        recentAwards: [award, ...state.recentAwards].slice(0, 15),
        teams: prevTeam
          ? {
              ...state.teams,
              [teamId]: {
                ...prevTeam,
                // Server-computed and authoritative — not re-derived client-side.
                remaining_budget_minor: award.remaining_budget_minor,
                roster_filled_count: prevTeam.roster_filled_count + 1,
              },
            }
          : state.teams,
      };
    }

    case 'NOMINATION_TURN_CHANGED': {
      return {
        ...state,
        currentNominatorTeamId: String(p['current_nominator_team_id']),
        nominationDeadlineTs: Number(p['nomination_deadline_ts']),
      };
    }

    case 'DRAFT_STATUS_CHANGED': {
      return { ...state, draftStatus: String(p['status']) };
    }

    case 'DRAFT_COMPLETE': {
      return { ...state, draftStatus: 'COMPLETE' };
    }

    case 'TEAM_AUTO_AGENT_ENABLED':
    case 'TEAM_AUTO_AGENT_DISABLED': {
      const teamId = String(p['team_id'] ?? '');
      const prevTeam = state.teams[teamId];
      if (!prevTeam) return state;
      return {
        ...state,
        teams: {
          ...state.teams,
          [teamId]: { ...prevTeam, control_mode: msg.type === 'TEAM_AUTO_AGENT_ENABLED' ? 'AUTO_AGENT' : 'MANUAL' },
        },
      };
    }

    case 'TEAM_NOMINATION_AUDIO': {
      return {
        ...state,
        nominationAudioCue: {
          team_id: String(p['team_id']),
          audio_url: String(p['audio_url']),
          duration_cap_ms: Number(p['duration_cap_ms'] ?? 5000),
          receivedAt: Date.now(),
        },
      };
    }

    case 'ERROR': {
      return { ...state, lastError: { code: String(p['code']), reason: String(p['reason']) } };
    }

    case 'BID_REJECTED': {
      return { ...state, lastError: { code: String(p['code']), reason: String(p['reason']) } };
    }

    default:
      return state;
  }
}

export interface UseAuctionSocketResult extends AuctionState {
  send: (message: { type: string; payload?: Record<string, unknown> }) => void;
  bid: (playerAuctionId: string, amountMinor: number, kind: 'ABSOLUTE' | 'RELATIVE') => void;
  nominatorMatch: () => void;
  nominate: (playerDatasetEntryId: string, openingBidMinor: number) => void;
  passNomination: () => void;
  clearError: () => void;
}

/**
 * Opens (and keeps open, with backoff reconnect) a WS connection to
 * /ws/drafts/:draftId, authenticating with `token`. Relative URL — goes
 * through the same dev-server proxy the rest of the app uses.
 */
export function useAuctionSocket(draftId: string | null, token: string | null): UseAuctionSocketResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeenSeqRef = useRef<number>(-1);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    lastSeenSeqRef.current = state.asOfSequence;
  }, [state.asOfSequence]);

  useEffect(() => {
    if (!draftId || !token) return;

    // "Was this close intentional" can't be a single flag shared across every
    // socket this effect ever creates — under React 18 StrictMode's dev-mode
    // double-invoke (mount, cleanup, mount again), a shared ref gets reset by
    // the *second* mount before the *first* socket's belated close event
    // fires, so that stale close reads it as unintentional and reconnects —
    // leaving two live sockets both processing every broadcast (visible as
    // duplicate bid-ladder entries). Comparing identity against wsRef.current
    // instead means a superseded socket's close is always correctly ignored,
    // regardless of timing.
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect(): void {
      if (cancelled) return;
      dispatch({ type: 'CONNECTION', status: reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting' });

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/drafts/${draftId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'AUTHENTICATE',
          payload: { token, last_seen_sequence: lastSeenSeqRef.current },
        }));
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (wsRef.current !== ws) return; // superseded — ignore its late messages too
        try {
          const msg = JSON.parse(event.data) as { type: string; payload?: Record<string, unknown> };
          if (msg.type === 'STATE_SNAPSHOT') {
            dispatch({ type: 'CONNECTION', status: 'open' });
            reconnectAttemptRef.current = 0;
          }
          dispatch({ type: 'MESSAGE', msg });
        } catch {
          // Malformed frame — ignore rather than crash the socket handler.
        }
      };

      ws.onclose = () => {
        if (cancelled || wsRef.current !== ws) return;
        dispatch({ type: 'CONNECTION', status: 'reconnecting' });
        const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 15000);
        reconnectAttemptRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
      dispatch({ type: 'CONNECTION', status: 'closed' });
    };
  }, [draftId, token]);

  const send = useCallback((message: { type: string; payload?: Record<string, unknown> }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const bid = useCallback(
    (playerAuctionId: string, amountMinor: number, kind: 'ABSOLUTE' | 'RELATIVE') => {
      send({
        type: 'BID_COMMAND',
        payload: {
          player_auction_id: playerAuctionId,
          bid_amount_minor: amountMinor,
          bid_type: kind,
          ...(kind === 'RELATIVE' && state.currentAuction
            ? {
                expected_current_bid_minor: state.currentAuction.current_bid_minor,
                expected_auction_version: state.currentAuction.auction_version,
              }
            : {}),
        },
      });
    },
    [send, state.currentAuction],
  );

  const nominatorMatch = useCallback(() => {
    send({ type: 'NOMINATOR_MATCH' });
  }, [send]);

  const nominate = useCallback(
    (playerDatasetEntryId: string, openingBidMinor: number) => {
      send({
        type: 'NOMINATE_COMMAND',
        payload: { player_dataset_entry_id: playerDatasetEntryId, opening_bid_minor: openingBidMinor },
      });
    },
    [send],
  );

  const passNomination = useCallback(() => {
    send({ type: 'PASS_NOMINATION' });
  }, [send]);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  return { ...state, send, bid, nominatorMatch, nominate, passNomination, clearError };
}
