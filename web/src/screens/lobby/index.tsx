/**
 * Pre-Draft Lobby — shown to authenticated owners before the draft starts.
 * Displays: league name, scheduled start time (or status message), team name.
 * Per screen-information-architecture.md §0.1.
 */
import React from 'react';

export interface LobbyProps {
  leagueName: string;
  teamName: string;
  scheduledAt: string | null; // ISO-8601 string or null
  draftStatus: 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETE';
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

export function Lobby({
  leagueName,
  teamName,
  scheduledAt,
  draftStatus,
}: LobbyProps): React.ReactElement {
  const timeText = formatScheduledTime(scheduledAt, draftStatus);

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
    </main>
  );
}
