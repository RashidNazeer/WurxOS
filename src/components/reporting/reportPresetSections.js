// ============================================================
// Preset descriptors — the single source of truth for WHICH report sections
// offer a "Save / Restore preset" control, and (for structured sections) which
// fields a preset can save.
//
// Keyed by report type → sectionKey. For hardcoded sections the sectionKey IS
// the report data key (so the preset's DB `section_key` matches the data key).
//
//   kind 'rows'  → repeating-rows array at data[dataKey]; `fields` = the
//                  toggleable columns a user can choose to save.
//   kind 'text'  → a single rich-text string at data[dataKey]; whole content is
//                  saved (no field toggles).
//
// Presets are intentionally offered only where reusing content helps: the
// row-based sections (campaign / creator / video / product lists) and the
// long-text sections. Pure single-number metric boxes (overview totals, key
// metrics, GMV breakdown, …) are omitted — a preset there would only re-enter
// last period's figures. Custom sections get presets too, wired separately in
// BrandSectionsBlock (custom table → 'object', custom long-text → 'text').
// ============================================================

// Field lists mirror the ArraySection `fields` / empty-row factories in each
// form (reportsApi.js). Keys MUST match the row keys exactly.
const CREATOR_FIELDS = [
  { key: 'name', label: 'Creator' },
  { key: 'videosPosted', label: 'Videos' },
  { key: 'itemsSold', label: 'Items sold' },
  { key: 'gmv', label: 'GMV' },
  { key: 'notes', label: 'Notes' },
];
const VIDEO_FIELDS = [
  { key: 'creatorName', label: 'Creator' },
  { key: 'videoLink', label: 'Video link' },
  { key: 'itemsSold', label: 'Items sold' },
  { key: 'gmv', label: 'GMV' },
  { key: 'views', label: 'Views' },
  { key: 'productClicks', label: 'Product clicks' },
  { key: 'notes', label: 'Notes' },
];
const GMV_MAX_FIELDS = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'spend', label: 'Cost' },
  { key: 'roi', label: 'ROI' },
  { key: 'orders', label: 'Orders' },
  { key: 'cpo', label: 'CPO' },
  { key: 'gmv', label: 'GMV' },
  { key: 'notes', label: 'Notes' },
];
const PRODUCT_FIELDS = [
  { key: 'productId', label: 'Product ID' },
  { key: 'productName', label: 'Product' },
  { key: 'unitsSold', label: 'Units sold' },
  { key: 'gmv', label: 'GMV' },
  { key: 'newVideos', label: 'New videos' },
  { key: 'videosMtd', label: 'Videos MTD' },
  { key: 'samplesApprovedWeek', label: 'Samples (wk)' },
  { key: 'samplesApprovedMtd', label: 'Samples (MTD)' },
  { key: 'notes', label: 'Notes' },
];

// Monthly uses different row shapes for the same-named sections.
const MONTHLY_CREATOR_FIELDS = [
  { key: 'username', label: 'Creator' },
  { key: 'gmv', label: 'GMV' },
];
const MONTHLY_VIDEO_FIELDS = [
  { key: 'videoLink', label: 'Video link' },
  { key: 'gmv', label: 'GMV' },
];
const MONTHLY_PRODUCT_FIELDS = [
  { key: 'productId', label: 'Product ID' },
  { key: 'productName', label: 'Product' },
  { key: 'unitsSold', label: 'Units sold' },
  { key: 'gmv', label: 'GMV' },
  { key: 'samplesApproved', label: 'Samples' },
];
const MONTHLY_GMV_MAX_FIELDS = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'spend', label: 'Cost' },
  { key: 'roi', label: 'ROI' },
  { key: 'orders', label: 'Orders' },
  { key: 'cpo', label: 'CPO' },
  { key: 'gmv', label: 'GMV' },
];

const rows = (label, dataKey, fields) => ({ label, kind: 'rows', dataKey, fields });
const text = (label, dataKey) => ({ label, kind: 'text', dataKey });

// Weekly + Bi-Weekly share the same row shapes.
const SHARED_ROWS = {
  topCreators: rows('Top Creators', 'topCreators', CREATOR_FIELDS),
  topVideos: rows('Top Videos', 'topVideos', VIDEO_FIELDS),
  gmvMax: rows('GMV Max Performance', 'gmvMax', GMV_MAX_FIELDS),
  gmvMaxMtd: rows('Month-to-Date GMV Max', 'gmvMaxMtd', GMV_MAX_FIELDS),
  productHighlights: rows('Product Highlights', 'productHighlights', PRODUCT_FIELDS),
};

export const PRESET_SECTIONS = {
  weekly: {
    ...SHARED_ROWS,
    upcomingCampaigns: text('Current & Upcoming Campaigns', 'upcomingCampaigns'),
    operationalUpdates: text('Operational Updates', 'operationalUpdates'),
    recommendations: text('Recommendations & Action Items', 'recommendations'),
    reportInsights: text('Insights', 'reportInsights'),
  },
  biweekly: {
    // Bi-weekly's insights are per-section editors that sit inside each row
    // section's card; giving each its own preset pill would stack two pills per
    // card. So bi-weekly presets cover the row sections + the standalone
    // long-text sections only (the insights are reachable via the row-section
    // save if ever needed). Weekly's single consolidated Insights box keeps a
    // preset; monthly's do too.
    ...SHARED_ROWS,
    upcomingCampaigns: text('Current & Upcoming Campaigns', 'upcomingCampaigns'),
    operationalUpdates: text('Operational Updates', 'operationalUpdates'),
    recommendations: text('Recommendations & Action Items', 'recommendations'),
  },
  monthly: {
    topCreators: rows('Top Creators', 'topCreators', MONTHLY_CREATOR_FIELDS),
    topVideos: rows('Top Videos', 'topVideos', MONTHLY_VIDEO_FIELDS),
    productAnalytics: rows('Product Analytics', 'productAnalytics', MONTHLY_PRODUCT_FIELDS),
    gmvMax: rows('GMV Max Performance', 'gmvMax', MONTHLY_GMV_MAX_FIELDS),
    keyWinsInsights: text('Key Wins / Insights', 'keyWinsInsights'),
    campaignsText: text('Campaigns', 'campaignsText'),
    recommendations: text('Recommendations & Action Items', 'recommendations'),
  },
};

export function getPresetDescriptor(reportType, sectionKey) {
  return PRESET_SECTIONS[reportType]?.[sectionKey] || null;
}
