export const ROLES = [
  { value: 'boss',      label: 'Boss',                  blurb: 'Owner / Employer' },
  { value: 'ol',        label: 'Operation Lead',        blurb: 'OL' },
  { value: 'tl',        label: 'Team Lead',             blurb: 'TL' },
  { value: 'pctl',      label: 'Paid Collab Team Lead', blurb: 'PCTL' },
  { value: 'apc',       label: 'Affiliate Coordinator', blurb: 'APC' },
  { value: 'ipc',       label: 'Influencer Coordinator',blurb: 'IPC' },
  { value: 'developer', label: 'Developer',             blurb: 'Engineering' },
];

export const ROLE_VALUES = ROLES.map((r) => r.value);

export const roleLabel = (value) =>
  ROLES.find((r) => r.value === value)?.label || value;

// Role-specific extras shown during Create/Edit and validated server-side.
//   reportsToRole: the role that this user must report to (null = none)
//   permissions:   list of { key, label, hint } permission toggles
export const ROLE_EXTRAS = {
  boss: { reportsToRole: null, permissions: [] },
  ol:   { reportsToRole: null, permissions: [] },
  tl: {
    reportsToRole: null,
    permissions: [
      { key: 'canAddAPC',           label: 'Can add APCs',            hint: 'Allow this TL to onboard APCs themselves.' },
      { key: 'canAddBrand',         label: 'Can add brands',          hint: 'Allow this TL to create new brands.' },
      { key: 'canManageIncentives', label: 'Can manage incentives',   hint: 'Allow this TL to configure incentives.' },
    ],
  },
  pctl: {
    reportsToRole: null,
    permissions: [
      { key: 'canAddIPC',   label: 'Can add IPCs',    hint: 'Allow this PCTL to onboard IPCs themselves.' },
      { key: 'canAddBrand', label: 'Can add brands',  hint: 'Allow this PCTL to create new brands.' },
    ],
  },
  apc: {
    reportsToRole: 'tl',
    permissions: [
      { key: 'canManageTasks', label: 'Can create tasks', hint: 'Allow this APC to create/edit tasks on their brands.' },
    ],
  },
  ipc: {
    reportsToRole: 'pctl',
    permissions: [
      { key: 'canManageTasks', label: 'Can create tasks', hint: 'Allow this IPC to create/edit tasks on their brands.' },
    ],
  },
  developer: { reportsToRole: null,   permissions: [] },
};

export const getRoleExtras = (role) => ROLE_EXTRAS[role] || { reportsToRole: null, permissions: [] };

// Paid-collab posture of a brand. Mirrors v1's four buckets.
export const PAID_COLLAB_STATUSES = [
  { value: 'not_applicable',     label: 'Not applicable',    blurb: 'No paid collab activity on this brand.' },
  { value: 'managed_by_brand',   label: 'Managed by brand',  blurb: 'Brand runs their own paid collab.' },
  { value: 'managed_internally', label: 'Managed internally',blurb: 'Our PCTL team runs everything.' },
  { value: 'hybrid',             label: 'Hybrid',            blurb: 'Shared between brand and our team.' },
];

export const paidCollabStatusLabel = (v) =>
  PAID_COLLAB_STATUSES.find((s) => s.value === v)?.label || v;

// GMV Max (paid ads) posture of a brand — same four buckets as paid collab,
// but about who runs the brand's GMV Max campaigns. Drives whether the GMV Max
// Budget and Target ROI goal cards show in Brand Analytics (mig 263).
export const GMV_MAX_STATUSES = [
  { value: 'not_applicable',     label: 'Not applicable',     blurb: 'No GMV Max campaigns on this brand.' },
  { value: 'managed_by_brand',   label: 'Managed by brand',   blurb: 'Brand runs their own GMV Max.' },
  { value: 'managed_internally', label: 'Managed internally', blurb: 'We run this brand’s GMV Max.' },
  { value: 'hybrid',             label: 'Hybrid',             blurb: 'Shared between brand and our team.' },
];

export const gmvMaxStatusLabel = (v) =>
  GMV_MAX_STATUSES.find((s) => s.value === v)?.label || v;

// A managed-status ('paid_collab_status' / 'gmv_max_status') means WE handle it
// when it's run internally or shared. Used to gate the per-brand goal cards.
export const isManagedByUs = (v) => v === 'managed_internally' || v === 'hybrid';
