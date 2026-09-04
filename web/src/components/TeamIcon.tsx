/**
 * Renders a team's presentation icon (F-MOD-015) — only when icon_url is
 * set. Shared by War Room's roster/budget grid and Draft Room's My Team
 * panel so neither renders a broken-image element when a team has no icon.
 */
import React from 'react';

export interface TeamIconProps {
  iconUrl: string | null;
  className?: string;
}

export function TeamIcon({ iconUrl, className }: TeamIconProps): React.ReactElement | null {
  if (!iconUrl) return null;
  return <img src={iconUrl} alt="" className={className} data-testid="team-icon" />;
}
