// Formatting helpers copied verbatim from v1 (supabase/functions/ai-chat/index.ts
// in the app repo). The ported tools must print exactly what v1 prints
// (scripts/test-tools-parity.mjs), so do not "improve" these: a change here is
// a change in what the model reads.

export const ROLE_LABEL: Record<string, string> = {
  boss: 'Boss (agency owner)',
  ol: 'Operation Lead (OL)',
  tl: 'Team Lead — Affiliate (TL)',
  pctl: 'Paid Collab Team Lead (PCTL)',
  apc: 'Affiliate Program Coordinator (APC)',
  ipc: 'Influencer Program Coordinator (IPC)',
  developer: 'Developer',
};

export const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? `PKR ${v.toLocaleString('en-US')}` : String(n ?? '');
};

// v1's HTML → text. Differs from ../text.ts htmlToText (bullets, headings), so
// the ported get_reports keeps this one.
export const htmlToText = (s: unknown) => String(s || '')
  .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)\s*>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export const clip = (s: string, n = 500) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);

export const has = (v: unknown) => v != null && v !== '' && v !== 'N/A';

export const roleLabelOf = (role: unknown) => ROLE_LABEL[String(role || '').toLowerCase()] || String(role || 'unknown');

// milliseconds → "7h 20m"
export const hms = (ms: unknown) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0h';
  const h = Math.floor(n / 3_600_000);
  const m = Math.round((n % 3_600_000) / 60_000);
  return `${h}h${m ? ` ${m}m` : ''}`;
};

// The business "this month" in Asia/Karachi: the money gate for "is this month
// closed". The cluster runs UTC, so a raw new Date() month drifts near midnight.
export const karachiMonthNow = (): string => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const y = p.find((x) => x.type === 'year')?.value ?? '';
  const m = p.find((x) => x.type === 'month')?.value ?? '';
  return `${y}-${m}`;
};

const pktTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false });
export const pktTime = (ts: unknown) => (ts ? pktTimeFmt.format(new Date(ts as string)) : '—');

// YYYY-MM → {gte, lt} date-range strings for created_at/date filtering.
export const monthToRange = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, mm] = month.split('-').map(Number);
  const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  return { gte: `${month}-01`, lt: `${next}-01` };
};

// v1 get_reports formatters (verbatim).
// deno-lint-ignore no-explicit-any
export const metricsLine = (d: any) => {
  const o = d?.overallPerformance || d?.keyMetrics || {};
  const off = d?.offsitePerformance || {};
  const parts = [
    has(o.gmv) ? `GMV ${o.gmv}` : null,
    has(o.affiliateGmv) ? `affiliate GMV ${o.affiliateGmv}` : null,
    has(o.orders) ? `orders ${o.orders}` : null,
    has(o.samplesApproved) ? `samples ${o.samplesApproved}` : null,
    has(o.videosPosted) ? `videos ${o.videosPosted}` : null,
    has(o.roi) ? `ROI ${o.roi}` : null,
    has(o.shopPerformanceScore) ? `shop score ${o.shopPerformanceScore}` : null,
    has(off.offsiteGmv) ? `offsite GMV ${off.offsiteGmv}` : null,
  ].filter(Boolean).join(', ');
  return parts || 'no headline metrics filled';
};

// deno-lint-ignore no-explicit-any
export const tableBlock = (title: string, arr: any[], cols: [string, string][]) => {
  if (!Array.isArray(arr) || !arr.length) return '';
  const lines = arr.slice(0, 8).map((it: any) => '  - ' + cols.map(([k, lbl]) => has(it[k]) ? `${lbl}: ${it[k]}` : null).filter(Boolean).join(', '));
  return `\n  ${title}:\n${lines.join('\n')}`;
};

// deno-lint-ignore no-explicit-any
export const insightBlock = (d: any) => {
  const keys: [string, string][] = [
    ['overallInsights', 'Overall'], ['gmvMaxInsights', 'GMV Max'], ['topCreatorsInsights', 'Top creators'],
    ['topVideosInsights', 'Top videos'], ['productHighlightsInsights', 'Products'], ['offsiteInsights', 'Offsite'],
    ['keyWinsInsights', 'Key wins'],
  ];
  const out = keys.map(([k, lbl]) => { const t = clip(htmlToText(d[k])); return t && t.length > 3 ? `  ${lbl}: ${t}` : null; }).filter(Boolean);
  return out.length ? '\n  Insights:\n' + out.join('\n') : '';
};

// deno-lint-ignore no-explicit-any
export const writtenBlock = (d: any) => {
  const keys: [string, string][] = [
    ['recommendations', 'Recommendations'], ['actionItems', 'Action items'],
    ['upcomingCampaigns', 'Upcoming campaigns'], ['operationalUpdates', 'Operational updates'], ['campaignsText', 'Campaigns'],
  ];
  const out = keys.map(([k, lbl]) => { const t = clip(htmlToText(d[k])); return t && t.length > 3 ? `  ${lbl}: ${t}` : null; }).filter(Boolean);
  return out.length ? '\n  Written sections:\n' + out.join('\n') : '';
};
