/**
 * Ephemeral overlay shown for a few seconds after a PLAYER_AWARDED broadcast
 * (PRD.md §29). Purely presentational and non-blocking — the Draft Room
 * keeps rendering nomination/bid state underneath exactly as it does today;
 * this only auto-dismisses itself after `displayMs`.
 */
import React, { useEffect } from 'react';

import type { AwardEntry } from '../lib/useAuctionSocket.js';

export interface AuctionCloseCardProps {
  award: AwardEntry;
  winningTeamName: string;
  onDismiss: () => void;
  displayMs?: number;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

export function AuctionCloseCard({
  award,
  winningTeamName,
  onDismiss,
  displayMs = 3000,
}: AuctionCloseCardProps): React.ReactElement {
  useEffect(() => {
    const timer = setTimeout(onDismiss, displayMs);
    return () => clearTimeout(timer);
  }, [award.player_auction_id, award.resolution_sequence, displayMs, onDismiss]);

  const diff = award.price_minor - award.aav_minor;
  const diffLabel =
    diff === 0 ? 'At AAV' : diff > 0 ? `${formatMoney(diff)} over AAV` : `${formatMoney(-diff)} under AAV`;

  return (
    <div className="draft-room__close-card" role="status" data-testid="auction-close-card">
      <button
        type="button"
        className="draft-room__close-card-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss auction result"
        data-testid="close-card-dismiss"
      >
        ×
      </button>
      <p className="draft-room__close-card-player">{award.player_name}</p>
      <p className="draft-room__close-card-team">
        {winningTeamName} — {formatMoney(award.price_minor)}
      </p>
      <p className="draft-room__close-card-diff">{diffLabel}</p>
      <p className="draft-room__close-card-meta">
        {award.accepted_bid_count} {award.accepted_bid_count === 1 ? 'bid' : 'bids'} ·{' '}
        {award.unique_bidder_count} {award.unique_bidder_count === 1 ? 'bidder' : 'bidders'}
      </p>
      <p className="draft-room__close-card-budget">
        {winningTeamName} remaining: {formatMoney(award.remaining_budget_minor)}
      </p>
    </div>
  );
}
