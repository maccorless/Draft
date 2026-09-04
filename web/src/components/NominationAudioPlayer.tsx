/**
 * Plays a team's nomination MP3 on TEAM_NOMINATION_AUDIO, capped at
 * duration_cap_ms regardless of the source file's actual length. Purely
 * presentation — renders no visible UI and never blocks nomination/bidding
 * controls (playback failures, e.g. browsers requiring a user gesture, are
 * swallowed rather than surfaced as an error).
 */
import { useEffect, useRef } from 'react';

import type { NominationAudioCue } from '../lib/useAuctionSocket.js';

export interface NominationAudioPlayerProps {
  cue: NominationAudioCue | null;
}

export function NominationAudioPlayer({ cue }: NominationAudioPlayerProps): null {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!cue) return;
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;
    audio.src = cue.audio_url;
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Autoplay blocked or playback unsupported — presentation-only, never surfaced.
    });

    const stopTimer = setTimeout(() => {
      audio.pause();
    }, cue.duration_cap_ms);

    return () => {
      clearTimeout(stopTimer);
      audio.pause();
    };
  }, [cue]);

  return null;
}
