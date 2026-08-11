// Shared color theme + helpers for the Team Hierarchy page.
// Mirrors v1's src/components/teamManagement/hierarchyTheme.js verbatim.

export const ROLE_COLORS = {
  boss: { solid: '#0f172a', light: '#f1f5f9', text: '#0f172a' },
  ol:   { solid: '#7c3aed', light: '#f5f3ff', text: '#5b21b6' },
  tl:   { solid: '#16a34a', light: '#f0fdf4', text: '#166534' },
  pctl: { solid: '#0891b2', light: '#ecfeff', text: '#155e75' },
  apc:  { solid: '#3b82f6', light: '#eff6ff', text: '#1d4ed8' },
  ipc:  { solid: '#ec4899', light: '#fdf2f8', text: '#9d174d' },
};

export function roleLabel(role) {
  return {
    boss: 'BOSS', ol: 'OL', tl: 'TEAM LEAD', pctl: 'PAID COLLAB TL',
    apc: 'APC', ipc: 'IPC', ads_manager: 'ADS MANAGER',
  }[role] || (role || '').toUpperCase();
}

export function roleShortLabel(role) {
  return {
    boss: 'BOSS', ol: 'OL', tl: 'TL', pctl: 'PCTL', apc: 'APC', ipc: 'IPC', ads_manager: 'ADS MGR',
  }[role] || (role || '').toUpperCase();
}

export function initialsOf(s) {
  if (!s) return '?';
  return s.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
