// Shared color theme + helpers for the Team Hierarchy page.
// Ported from v1's hierarchyTheme.js; colours moved onto theme tokens.

// Role palette on the shared chart slots (they theme for light/dark).
// solid = fill, on = text on that fill, light = tinted panel, text = readable
// role-coloured text on surfaces. --chart-3 (amber) is avoided for fills.
const tone = (n) => ({
  solid: `var(--chart-${n})`,
  on: 'var(--text-inverse)',
  light: `color-mix(in srgb, var(--chart-${n}) 10%, var(--surface-1))`,
  text: `color-mix(in srgb, var(--chart-${n}) 80%, var(--text-primary))`,
});
export const ROLE_COLORS = {
  boss: tone(8),
  ol:   tone(4),
  tl:   tone(7),
  pctl: tone(2),
  apc:  tone(6),
  ipc:  tone(5),
  // Engineering — a separate branch from the TL/PCTL brand pods, so it gets
  // its own colour rather than borrowing one that implies a brand-owning team.
  developer: tone(1),
};

// Translucent version of any colour token (replaces hex-alpha suffixes).
export const alpha = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function roleLabel(role) {
  return {
    boss: 'BOSS', ol: 'OL', tl: 'TEAM LEAD', pctl: 'PAID COLLAB TL',
    apc: 'APC', ipc: 'IPC', ads_manager: 'ADS MANAGER', developer: 'DEVELOPER',
  }[role] || (role || '').toUpperCase();
}

export function roleShortLabel(role) {
  return {
    boss: 'BOSS', ol: 'OL', tl: 'TL', pctl: 'PCTL', apc: 'APC', ipc: 'IPC',
    ads_manager: 'ADS MGR', developer: 'DEV',
  }[role] || (role || '').toUpperCase();
}

// Header label + member-section label per team-lead role. Brands are a
// TL/PCTL concept only — a developer team never owns one, so callers that
// render a brands section should skip it entirely when hasBrands is false,
// rather than showing it permanently empty.
const TEAM_KIND = {
  pctl:      { headerLabel: 'PAID COLLAB TL', memberLabel: 'IPCs',       memberShortLabel: 'IPC',       hasBrands: true },
  developer: { headerLabel: 'TEAM LEAD',      memberLabel: 'Developers', memberShortLabel: 'Developer', hasBrands: false },
};
export function teamKindOf(role) {
  return TEAM_KIND[role] || { headerLabel: 'TEAM LEAD', memberLabel: 'APCs', memberShortLabel: 'APC', hasBrands: true };
}

export function initialsOf(s) {
  if (!s) return '?';
  return s.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
