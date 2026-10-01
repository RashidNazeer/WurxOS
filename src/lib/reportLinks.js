// Report URLs — the single source for every link into a report (Today,
// Approvals, global search, notifications). Round-4 contract (spec F2):
//
//   reportListUrl(type, brandId?)              → '/weekly-reports' | '/weekly-reports/<brandId>'
//   reportUrl({ id, brandId, type }, { edit }) → '/weekly-reports/<brandId>/<id>[/edit]'
//   reportNewUrl(type, brandId)                → '/weekly-reports/<brandId>/new'
//   reportResolverUrl(id)                      → '/r/<id>' (type-agnostic; resolves server-side)
//
// Until the report pages read their URL (F2), deep links would land on the
// overview anyway, so DEEP_LINKS_READY keeps reportUrl/reportNewUrl on the
// brand list. Flip it when F2 ships; callers don't change.
export const DEEP_LINKS_READY = false;

const BASE = {
  weekly: '/weekly-reports',
  biweekly: '/biweekly-reports',
  monthly: '/monthly-reports',
};

// Accepts 'weekly' | 'biweekly' | 'bi-weekly' | 'monthly' (any case); unknown → weekly.
export function normalizeReportType(type) {
  const t = String(type || '').toLowerCase().replace(/[^a-z]/g, '');
  return t === 'biweekly' || t === 'monthly' ? t : 'weekly';
}

export function reportListUrl(type, brandId) {
  const base = BASE[normalizeReportType(type)];
  return brandId ? `${base}/${encodeURIComponent(brandId)}` : base;
}

export function reportUrl({ id, brandId, type } = {}, { edit = false } = {}) {
  if (!DEEP_LINKS_READY || !id || !brandId) return reportListUrl(type, DEEP_LINKS_READY ? brandId : undefined);
  const url = `${reportListUrl(type, brandId)}/${encodeURIComponent(id)}`;
  return edit ? `${url}/edit` : url;
}

export function reportNewUrl(type, brandId) {
  if (!DEEP_LINKS_READY || !brandId) return reportListUrl(type);
  return `${reportListUrl(type, brandId)}/new`;
}

export function reportResolverUrl(id) {
  return `/r/${encodeURIComponent(id)}`;
}
