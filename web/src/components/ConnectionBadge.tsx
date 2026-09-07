/**
 * ConnectionBadge — colored dot + latency pill for the header (PRD §28).
 * Shared between Draft Room and War Room; each screen passes its own ws state.
 * Self-contained with inline styles so no additional CSS import is required.
 */
import React from 'react';

import type { ConnectionStatus } from '../lib/useAuctionSocket.js';

export interface ConnectionBadgeProps {
  connectionStatus: ConnectionStatus;
  latencyMs: number | null;
}

function dotColor(connectionStatus: ConnectionStatus, latencyMs: number | null): string {
  if (connectionStatus !== 'open') return '#9e9e9e'; // grey — reconnecting/offline
  if (latencyMs === null) return '#9e9e9e';          // connected but no sample yet
  if (latencyMs < 80) return '#4caf50';              // green — excellent
  if (latencyMs < 200) return '#8bc34a';             // yellow-green — good
  if (latencyMs < 500) return '#ff9800';             // orange — degraded
  return '#f44336';                                  // red — poor
}

function badgeLabel(connectionStatus: ConnectionStatus, latencyMs: number | null): string {
  if (connectionStatus === 'reconnecting') return 'Reconnecting';
  if (connectionStatus === 'connecting') return 'Connecting…';
  if (connectionStatus === 'closed') return 'Offline';
  // open
  return latencyMs === null ? 'Live' : `${latencyMs}ms`;
}

export function ConnectionBadge({ connectionStatus, latencyMs }: ConnectionBadgeProps): React.ReactElement {
  const color = dotColor(connectionStatus, latencyMs);
  const label = badgeLabel(connectionStatus, latencyMs);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 'var(--text-xs, 11px)',
        color: 'var(--color-text-on-chrome-muted, #aaa)',
      }}
      data-testid="connection-badge"
      aria-label={`Connection: ${label}`}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: color,
          display: 'inline-block',
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
