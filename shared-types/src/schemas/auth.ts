import { z } from 'zod';

export const SiteAuthRequestSchema = z.object({
  site_password: z.string().min(1),
});

export type SiteAuthRequest = z.infer<typeof SiteAuthRequestSchema>;

export const SiteAuthResponseSchema = z.object({
  leagues: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

export type SiteAuthResponse = z.infer<typeof SiteAuthResponseSchema>;

export const LeagueAuthRequestSchema = z.object({
  role: z.enum(['COMMISSIONER', 'OWNER']),
  team_id: z.string().uuid().optional(),
  password: z.string().min(1),
});

export type LeagueAuthRequest = z.infer<typeof LeagueAuthRequestSchema>;

export const LeagueAuthResponseSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number(),
});

export type LeagueAuthResponse = z.infer<typeof LeagueAuthResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  ts: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * JWT payload shape — decoded token carries these claims.
 */
export const JwtPayloadSchema = z.object({
  league_id: z.string().uuid(),
  team_id: z.string().uuid().optional(),
  role: z.enum(['COMMISSIONER', 'OWNER', 'HOST']),
  auth_epoch: z.number().int().nonnegative(),
});

export type JwtPayload = z.infer<typeof JwtPayloadSchema>;
