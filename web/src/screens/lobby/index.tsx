/**
 * Pre-Draft Lobby — landing screen shown to authenticated owners before the
 * draft starts. Displays league name, scheduled start time (or status
 * message), team name, a commissioner status-message section, and the team
 * presentation media control (MOD-015). Primary navigation ("Draft Prep" /
 * "Enter Draft Room" / "Open War Room") is rendered by the caller
 * (App.tsx's DraftGateway) since it depends on whether an active draft
 * exists — see F-MOD-014_enter_draft_room_link.test.tsx.
 * Per screen-information-architecture.md §0.1. Prep tools (Watch List,
 * Nomination Queue, Target Values, Auto-Agent, Do Not Draft, and the full
 * filterable/sortable player pool) live on the separate Draft Prep screen
 * (web/src/screens/draft-prep/).
 */
import React, { useEffect, useState } from 'react';

import { TeamMediaUpload, type TeamMedia } from '../../components/TeamMediaUpload.js';
import './lobby.css';

async function authedJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

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
  const [media, setMedia] = useState<TeamMedia>({ icon_url: null, nomination_audio_url: null });

  // Seed the media control with whatever's already stored, so a returning
  // owner sees "Replace"/"Remove" instead of "Upload" for media they already
  // set. There's no standalone GET for a single team's media (F-MOD-015 only
  // has POST/DELETE) — the roster grid (already owner-accessible) carries it.
  useEffect(() => {
    if (!leagueId || !teamId || !token || !draftId) return;
    authedJson<{ teams: Array<{ team_id: string; icon_url: string | null }> }>(
      `/drafts/${draftId}/roster-grid`,
      token,
    )
      .then((d) => {
        const mine = d.teams?.find((t) => t.team_id === teamId);
        if (mine) setMedia((prev) => ({ ...prev, icon_url: mine.icon_url }));
      })
      .catch(() => {});
  }, [leagueId, teamId, token, draftId]);

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
    </main>
  );
}
