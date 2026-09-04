/**
 * Team presentation media routes (F-MOD-015, PRD §5.1):
 *   POST   /leagues/:leagueId/teams/:teamId/media  — upload/replace icon and/or nomination MP3
 *   DELETE /leagues/:leagueId/teams/:teamId/media  — clear icon and/or nomination audio
 *   GET    /media/team-media/:filename             — serve a stored file (static, unauthenticated)
 *
 * Auth: that team's own OWNER token, or the league's COMMISSIONER token —
 * extends requireCommissioner's auth_epoch-checked JWT pattern to also
 * accept the matching team's own token (auth-hook.ts only covers commissioner-only routes).
 */
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';

import { saveTeamMediaFile, TEAM_MEDIA_DIR } from './storage.js';

interface TokenClaims {
  league_id: string;
  role: string;
  team_id?: string;
  auth_epoch: number;
}

type TeamMediaParams = { leagueId: string; teamId: string };

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
};

/**
 * Validates the JWT and requires the caller to be either the target team's
 * own owner, or the league's commissioner. Re-checks auth_epoch against the
 * DB (never trusts the token's copy) to honor revocation.
 */
async function requireTeamMediaAuth(
  sql: postgres.Sql,
  req: FastifyRequest<{ Params: TeamMediaParams }>,
  reply: FastifyReply,
): Promise<TeamMediaParams | null> {
  let claims: TokenClaims;
  try {
    claims = await req.jwtVerify<TokenClaims>();
  } catch {
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    return null;
  }

  const { leagueId, teamId } = req.params;
  if (claims.league_id !== leagueId) {
    reply.status(403).send({ code: 'FORBIDDEN', message: 'Token scope mismatch' });
    return null;
  }

  const isOwnerOfTeam = claims.role === 'OWNER' && claims.team_id === teamId;
  const isCommissioner = claims.role === 'COMMISSIONER';
  if (!isOwnerOfTeam && !isCommissioner) {
    reply.status(403).send({ code: 'FORBIDDEN', message: "Must be this team's owner or the league commissioner" });
    return null;
  }

  const epochRows = isOwnerOfTeam
    ? await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM teams WHERE id = ${teamId} LIMIT 1`
    : await sql<[{ auth_epoch: number }]>`SELECT auth_epoch FROM leagues WHERE id = ${leagueId} LIMIT 1`;
  if (!epochRows[0] || claims.auth_epoch !== epochRows[0].auth_epoch) {
    reply.status(401).send({ code: 'TOKEN_REVOKED', message: 'Token has been revoked' });
    return null;
  }

  const teamRows = await sql<[{ id: string }]>`
    SELECT id FROM teams WHERE id = ${teamId} AND league_id = ${leagueId} LIMIT 1
  `;
  if (!teamRows[0]) {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'Team not found in this league' });
    return null;
  }

  return { leagueId, teamId };
}

async function currentMedia(
  sql: postgres.Sql,
  teamId: string,
): Promise<{ icon_url: string | null; nomination_audio_url: string | null }> {
  const [row] = await sql<[{ icon_url: string | null; nomination_audio_url: string | null }]>`
    SELECT icon_url, nomination_audio_url FROM teams WHERE id = ${teamId} LIMIT 1
  `;
  return row ?? { icon_url: null, nomination_audio_url: null };
}

const DeleteTeamMediaBody = z.object({
  media: z.array(z.enum(['icon', 'nomination_audio'])).min(1),
});

export async function registerTeamMediaRoutes(
  server: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  server.post<{ Params: TeamMediaParams }>(
    '/leagues/:leagueId/teams/:teamId/media',
    async (req, reply) => {
      const ctx = await requireTeamMediaAuth(sql, req, reply);
      if (!ctx) return;
      const { teamId } = ctx;

      let iconUrl: string | undefined;
      let audioUrl: string | undefined;

      if (!req.isMultipart()) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Request must be multipart/form-data' });
      }

      try {
        for await (const part of req.files()) {
          const buffer = await part.toBuffer();
          if (part.fieldname === 'icon') {
            iconUrl = await saveTeamMediaFile(teamId, 'icon', buffer, part.filename);
          } else if (part.fieldname === 'nomination_audio') {
            audioUrl = await saveTeamMediaFile(teamId, 'nomination_audio', buffer, part.filename);
          }
        }
      } catch {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Malformed multipart body' });
      }

      if (iconUrl === undefined && audioUrl === undefined) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'No icon or nomination_audio file uploaded' });
      }

      if (iconUrl !== undefined && audioUrl !== undefined) {
        await sql`UPDATE teams SET icon_url = ${iconUrl}, nomination_audio_url = ${audioUrl} WHERE id = ${teamId}`;
      } else if (iconUrl !== undefined) {
        await sql`UPDATE teams SET icon_url = ${iconUrl} WHERE id = ${teamId}`;
      } else {
        // Reached only when the guard above ruled out "neither set" and the
        // prior branch ruled out iconUrl being set — audioUrl must be defined.
        await sql`UPDATE teams SET nomination_audio_url = ${audioUrl!} WHERE id = ${teamId}`;
      }

      const media = await currentMedia(sql, teamId);
      return reply.send({ team_id: teamId, ...media });
    },
  );

  server.delete<{ Params: TeamMediaParams }>(
    '/leagues/:leagueId/teams/:teamId/media',
    async (req, reply) => {
      const ctx = await requireTeamMediaAuth(sql, req, reply);
      if (!ctx) return;
      const { teamId } = ctx;

      const parsed = DeleteTeamMediaBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request body' });
      }
      const clearIcon = parsed.data.media.includes('icon');
      const clearAudio = parsed.data.media.includes('nomination_audio');

      if (clearIcon && clearAudio) {
        await sql`UPDATE teams SET icon_url = NULL, nomination_audio_url = NULL WHERE id = ${teamId}`;
      } else if (clearIcon) {
        await sql`UPDATE teams SET icon_url = NULL WHERE id = ${teamId}`;
      } else if (clearAudio) {
        await sql`UPDATE teams SET nomination_audio_url = NULL WHERE id = ${teamId}`;
      }

      const media = await currentMedia(sql, teamId);
      return reply.send({ team_id: teamId, ...media });
    },
  );

  // Static file serve — public, no auth (referenced directly by <img>/<audio>
  // tags across windows). basename() strips any path segments to prevent
  // traversal outside TEAM_MEDIA_DIR.
  server.get<{ Params: { filename: string } }>(
    '/media/team-media/:filename',
    async (req, reply) => {
      const filename = basename(req.params.filename);
      let data: Buffer;
      try {
        data = await readFile(join(TEAM_MEDIA_DIR, filename));
      } catch {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Media file not found' });
      }
      const contentType = MIME_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
      reply.header('content-type', contentType);
      return reply.send(data);
    },
  );
}
