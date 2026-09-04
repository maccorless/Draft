/**
 * Team presentation media (icon + nomination MP3) file storage.
 *
 * Stored on local disk under the server package and served statically via
 * the GET route registered in routes.ts (per CLAUDE.md's storage decision:
 * Railway single-service deploy, no object-storage service).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/uploads/team-media — one level up from src/team-media/
export const TEAM_MEDIA_DIR = join(__dirname, '../../uploads/team-media');
export const TEAM_MEDIA_URL_PREFIX = '/media/team-media';

export type TeamMediaKind = 'icon' | 'nomination_audio';

const DEFAULT_EXT: Record<TeamMediaKind, string> = {
  icon: '.png',
  nomination_audio: '.mp3',
};

/**
 * Writes an uploaded file to disk and returns the URL the server serves it
 * from. Upload-or-replace: each call writes a new file under a fresh name,
 * the caller is responsible for pointing teams.icon_url / .nomination_audio_url
 * at the new URL (the previous file is simply orphaned, not deleted).
 *
 * TODO(railway-volume): Railway's default filesystem is ephemeral, so this
 * directory does not survive a redeploy/restart in production. The fix is a
 * persistent Railway volume mounted at TEAM_MEDIA_DIR (railway.toml) — not
 * implemented here, since local development has no such constraint.
 */
export async function saveTeamMediaFile(
  teamId: string,
  kind: TeamMediaKind,
  buffer: Buffer,
  originalFilename: string,
): Promise<string> {
  await mkdir(TEAM_MEDIA_DIR, { recursive: true });
  const ext = extname(originalFilename) || DEFAULT_EXT[kind];
  const filename = `${teamId}-${kind}-${randomUUID()}${ext}`;
  await writeFile(join(TEAM_MEDIA_DIR, filename), buffer);
  return `${TEAM_MEDIA_URL_PREFIX}/${filename}`;
}
