/**
 * Reusable team presentation media upload control (F-MOD-015) — icon +
 * optional nomination MP3, with replace/remove. Mounted by MOD-010
 * (commissioner-side, League Setup) and MOD-014 (owner-side, Pre-Draft
 * Lobby); this component owns the upload/replace/remove logic so neither
 * screen reimplements it.
 */
import React, { useRef, useState } from 'react';

import './team-media-upload.css';

export interface TeamMedia {
  icon_url: string | null;
  nomination_audio_url: string | null;
}

export interface TeamMediaUploadProps {
  leagueId: string;
  teamId: string;
  token: string;
  media: TeamMedia;
  onChange: (media: TeamMedia) => void;
}

async function uploadTeamMedia(
  leagueId: string,
  teamId: string,
  token: string,
  files: { icon?: File; nomination_audio?: File },
): Promise<TeamMedia> {
  const form = new FormData();
  if (files.icon) form.append('icon', files.icon);
  if (files.nomination_audio) form.append('nomination_audio', files.nomination_audio);

  const res = await fetch(`/leagues/${leagueId}/teams/${teamId}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return res.json() as Promise<TeamMedia>;
}

async function deleteTeamMedia(
  leagueId: string,
  teamId: string,
  token: string,
  kinds: Array<'icon' | 'nomination_audio'>,
): Promise<TeamMedia> {
  const res = await fetch(`/leagues/${leagueId}/teams/${teamId}/media`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ media: kinds }),
  });
  if (!res.ok) throw new Error(`Remove failed (${res.status})`);
  return res.json() as Promise<TeamMedia>;
}

export function TeamMediaUpload({ leagueId, teamId, token, media, onChange }: TeamMediaUploadProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  async function handleIconSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadTeamMedia(leagueId, teamId, token, { icon: file }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAudioSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadTeamMedia(leagueId, teamId, token, { nomination_audio: file }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(kind: 'icon' | 'nomination_audio'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onChange(await deleteTeamMedia(leagueId, teamId, token, [kind]));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="team-media-upload" aria-label="Team presentation media">
      {error && (
        <p className="team-media-upload__error" role="alert">{error}</p>
      )}

      <div className="team-media-upload__row">
        <span className="team-media-upload__label">Team icon</span>
        {media.icon_url ? (
          <img className="team-media-upload__icon-preview" src={media.icon_url} alt="Team icon" />
        ) : (
          <span className="team-media-upload__empty">None set</span>
        )}
        <button type="button" disabled={busy} onClick={() => iconInputRef.current?.click()}>
          {media.icon_url ? 'Replace' : 'Upload'}
        </button>
        {media.icon_url && (
          <button type="button" disabled={busy} onClick={() => handleRemove('icon')}>
            Remove
          </button>
        )}
        <input
          ref={iconInputRef}
          type="file"
          accept="image/*"
          className="team-media-upload__hidden-input"
          aria-label="Upload team icon"
          onChange={handleIconSelected}
        />
      </div>

      <div className="team-media-upload__row">
        <span className="team-media-upload__label">Nomination audio (MP3)</span>
        {media.nomination_audio_url ? (
          <audio className="team-media-upload__audio-preview" controls src={media.nomination_audio_url} />
        ) : (
          <span className="team-media-upload__empty">None set</span>
        )}
        <button type="button" disabled={busy} onClick={() => audioInputRef.current?.click()}>
          {media.nomination_audio_url ? 'Replace' : 'Upload'}
        </button>
        {media.nomination_audio_url && (
          <button type="button" disabled={busy} onClick={() => handleRemove('nomination_audio')}>
            Remove
          </button>
        )}
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/mpeg,.mp3"
          className="team-media-upload__hidden-input"
          aria-label="Upload nomination audio"
          onChange={handleAudioSelected}
        />
      </div>
    </div>
  );
}
