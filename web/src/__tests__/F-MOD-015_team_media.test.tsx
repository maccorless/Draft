/**
 * F-MOD-015: Team presentation media — frontend components.
 *
 * TeamIcon: only renders wherever icon_url is set, never a broken-image
 * element. TeamMediaUpload: upload/replace/remove wired to the media
 * endpoints. NominationAudioPlayer: plays a cue capped at duration_cap_ms.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TeamIcon } from '../components/TeamIcon.js';
import { TeamMediaUpload } from '../components/TeamMediaUpload.js';
import { NominationAudioPlayer } from '../components/NominationAudioPlayer.js';
import type { NominationAudioCue } from '../lib/useAuctionSocket.js';

describe('F-MOD-015 TeamIcon', () => {
  it('test_F_MOD_015_team_icon_renders_when_icon_url_set', () => {
    render(<TeamIcon iconUrl="/media/team-media/abc.png" />);
    expect(screen.getByTestId('team-icon')).toBeTruthy();
  });

  it('test_F_MOD_015_team_icon_renders_nothing_when_icon_url_null', () => {
    const { container } = render(<TeamIcon iconUrl={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('F-MOD-015 TeamMediaUpload', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('test_F_MOD_015_upload_control_shows_none_set_when_no_media', () => {
    render(
      <TeamMediaUpload
        leagueId="league-1"
        teamId="team-1"
        token="tok"
        media={{ icon_url: null, nomination_audio_url: null }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText('None set').length).toBe(2);
  });

  it('test_F_MOD_015_upload_control_uploads_icon_and_calls_onChange', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ team_id: 'team-1', icon_url: '/media/team-media/new-icon.png', nomination_audio_url: null }),
    });
    global.fetch = mockFetch;
    const onChange = vi.fn();

    render(
      <TeamMediaUpload
        leagueId="league-1"
        teamId="team-1"
        token="tok"
        media={{ icon_url: null, nomination_audio_url: null }}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText('Upload team icon') as HTMLInputElement;
    const file = new File(['icon-bytes'], 'icon.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ team_id: 'team-1', icon_url: '/media/team-media/new-icon.png', nomination_audio_url: null });
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/leagues/league-1/teams/team-1/media',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('test_F_MOD_015_upload_control_shows_replace_button_when_icon_already_set', () => {
    render(
      <TeamMediaUpload
        leagueId="league-1"
        teamId="team-1"
        token="tok"
        media={{ icon_url: '/media/team-media/existing.png', nomination_audio_url: null }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Replace')).toBeTruthy();
    expect(screen.getByText('Remove')).toBeTruthy();
  });

  it('test_F_MOD_015_upload_control_remove_calls_delete_endpoint_and_onChange', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ team_id: 'team-1', icon_url: null, nomination_audio_url: null }),
    });
    global.fetch = mockFetch;
    const onChange = vi.fn();

    render(
      <TeamMediaUpload
        leagueId="league-1"
        teamId="team-1"
        token="tok"
        media={{ icon_url: '/media/team-media/existing.png', nomination_audio_url: null }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ team_id: 'team-1', icon_url: null, nomination_audio_url: null });
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/leagues/league-1/teams/team-1/media',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ media: ['icon'] }) }),
    );
  });
});

describe('F-MOD-015 NominationAudioPlayer', () => {
  let originalAudio: typeof Audio;
  let playSpy: ReturnType<typeof vi.fn>;
  let pauseSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalAudio = global.Audio;
    playSpy = vi.fn().mockResolvedValue(undefined);
    pauseSpy = vi.fn();
    // jsdom has no real audio decoding pipeline — this is the documented
    // boundary-only stand-in for the browser's actual playback engine.
    global.Audio = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this['play'] = playSpy;
      this['pause'] = pauseSpy;
      this['src'] = '';
      this['currentTime'] = 0;
    }) as unknown as typeof Audio;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.Audio = originalAudio;
  });

  it('test_F_MOD_015_audio_player_plays_cue_on_receipt', () => {
    const cue: NominationAudioCue = { team_id: 't1', audio_url: '/media/team-media/a.mp3', duration_cap_ms: 5000, receivedAt: 1 };
    render(<NominationAudioPlayer cue={cue} />);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('test_F_MOD_015_audio_player_stops_playback_after_duration_cap_ms', () => {
    const cue: NominationAudioCue = { team_id: 't1', audio_url: '/media/team-media/a.mp3', duration_cap_ms: 5000, receivedAt: 1 };
    render(<NominationAudioPlayer cue={cue} />);
    expect(pauseSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('test_F_MOD_015_audio_player_renders_nothing_when_no_cue', () => {
    const { container } = render(<NominationAudioPlayer cue={null} />);
    expect(container.innerHTML).toBe('');
    expect(playSpy).not.toHaveBeenCalled();
  });
});
