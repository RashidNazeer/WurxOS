// SYNTHETIC report rows, one per real layout (inventory §2). Invented brands,
// people and numbers: no client data.
import type { ReportRow, ReportCtx } from '../../extractors/report.ts';

export const BRAND_ID = '00000000-0000-4000-8000-00000000b001';
export const AUTHOR_ID = '00000000-0000-4000-8000-00000000a001';
export const CTX: ReportCtx = { brand: { brand_name: 'Acme Kitchen', client_name: 'Acme Holdings Ltd', currency: null } };

const base = (over: Partial<ReportRow>): ReportRow => ({
  id: '00000000-0000-4000-8000-0000000000r1',
  type: 'weekly',
  brand_id: BRAND_ID,
  author_id: AUTHOR_ID,
  status: 'approved',
  period_label: 'Week 12',
  period_start: '2026-03-16',
  period_end: '2026-03-22',
  data: {},
  sections_enabled: null,
  updated_at: '2026-03-23T10:00:00Z',
  ...over,
});

export const weeklySingle = () => base({
  data: {
    insightsSingle: true,
    overallPerformance: { gmv: '12345.67', affiliateGmv: '9000.10', orders: '321', samplesApproved: '14', roi: 'N/A', shopPerformanceScore: '4.6', videosPosted: '38' },
    overallNotes: { samplesApproved: '40', videosPosted: '910', gmv: '30100.00', videosMtd: '' },
    reportInsights: '<p>GMV grew <strong>18%</strong> week on week, driven by the lunchbox bundle.</p><ul><li>Top creator doubled output</li><li>GMV Max ROI held at 3.2</li></ul><h3>Risks</h3><p>Stock on the blue variant is low &amp; may run out.</p>',
    // Stale per-section field: the single layout's view hides it, so must we.
    overallInsights: 'LEGACY TEXT THAT MUST NOT APPEAR',
    topCreators: [
      { name: 'creator_one', videosPosted: '5', itemsSold: '44', gmv: '1500.00', notes: '' },
      { name: '', videosPosted: '', itemsSold: '', gmv: '', notes: '' },
    ],
    topVideos: [{ creatorName: 'creator_one', videoLink: 'https://example.com/v/1', itemsSold: '20', gmv: '700.00', views: '120000', productClicks: '900', notes: '' }],
    gmvMax: [{ campaign: 'Bundle push', spend: '500.00', roi: '3.2', orders: '60', cpo: '8.33', gmv: '1600.00', notes: '' }],
    gmvMaxMtd: [{ campaign: '', spend: '', roi: '', orders: '', cpo: '', gmv: '', notes: '' }],
    productHighlights: [{ productId: 'P-1', productName: 'Lunchbox bundle', unitsSold: '200', gmv: '6000.00', newVideos: '12', notes: '' }],
    offsitePerformance: { offsiteGmv: '', tiktokShopGmv: '', offsiteEffect: '', dataFrom: '', dataTo: '' },
    offsiteInsights: 'Offsite text hidden on the single layout',
    upcomingCampaigns: '<p>Spring sale on 2026-04-01.</p>',
    operationalUpdates: 'Not_Available_yet',
    recommendations: '<p>Increase sample approvals for mid-tier creators.</p>',
    actionItems: '<p>Send 20 samples by Friday.</p>',
    customFields: {
      cs_aaa_1: { kind: 'builtin_extra', name: 'Total user count', type: 'number', value: '5120', source: 'brand', sectionKey: 'overallPerformance', sectionTitle: 'Overall Performance' },
      cs_bbb_2: { kind: 'long_text', name: 'Competitor watch', value: '<p>Rival brand launched a cheaper bundle.</p>', source: 'brand' },
      cs_ccc_3: {
        kind: 'table', name: 'Outreach', source: 'brand', sectionId: 'cs_ccc_3',
        columns: [{ id: 'c1', label: 'Creator level', type: 'text' }, { id: 'c2', label: 'Invites sent', type: 'number' }],
        rows: [{ c1: 'L3', c2: '120', stale: 'x' }, { c1: '', c2: '' }],
      },
    },
    rejectionNote: 'INTERNAL REVIEWER NOTE',
    submittedBy: '00000000-0000-4000-8000-0000000000s1',
    submittedByName: 'Submitter Person',
    submittedAt: '2026-03-23T09:00:00Z',
    highlights: { reportInsights: '<mark>GMV grew</mark>' },
  },
});

export const weeklyLegacy = () => base({
  id: '00000000-0000-4000-8000-0000000000r2',
  sections_enabled: { overallPerformance: true, topCreators: true, topVideos: false, gmvMax: true, productHighlights: true, offsitePerformance: true, upcomingCampaigns: true, operationalUpdates: true, recommendations: true },
  data: {
    currency: 'gbp',
    overallPerformance: { gmv: '800.00', affiliateGmv: '', orders: '20', samplesApproved: '', roi: '', shopPerformanceScore: '', videosPosted: '' },
    overallNotes: { samplesApproved: '', videosPosted: '', gmv: '', videosMtd: '' },
    overallInsights: '<p>Slow week after the holiday.</p>',
    topCreatorsInsights: 'Null',
    topVideos: [{ creatorName: 'hidden_creator', gmv: '99.00' }],
    topVideosInsights: 'Disabled section text',
    gmvMax: [],
    gmvMaxInsights: '<p>Paused GMV Max while ROI recovers.</p>',
    productHighlights: [],
    productHighlightsInsights: '',
    offsitePerformance: { offsiteGmv: '150.00', tiktokShopGmv: '800.00', offsiteEffect: '15.8', dataFrom: '2026-03-01', dataTo: '2026-03-07' },
    offsiteInsights: '<p>Amazon halo visible.</p>',
    upcomingCampaigns: '',
    operationalUpdates: '<p>New APC onboarded to the brand.</p>',
    recommendations: '',
    actionItems: '',
    customFields: {},
    gmvBreakdown: { liveGmv: '40.00' },
    gmvBreakdownInsights: 'Stray weekly breakdown note',
  },
});

export const biweekly = () => base({
  id: '00000000-0000-4000-8000-0000000000r3',
  type: 'biweekly',
  status: 'submitted',
  period_label: 'Period 3',
  period_start: '2026-03-02',
  period_end: '2026-03-15',
  data: {
    insightsSingle: false,
    overallPerformance: { gmv: '5000.00', orders: '140' },
    overallInsights: '<p>Two strong weeks.</p>',
    topCreators: [{ name: 'bw_creator', gmv: '900.00', videosPosted: '4', itemsSold: '30', notes: 'great hooks' }],
    upcomingCampaigns: 'Easter drop',
    recommendations: 'Keep the cadence.',
  },
});

export const monthly = () => base({
  id: '00000000-0000-4000-8000-0000000000r4',
  type: 'monthly',
  period_label: 'March 2026',
  period_start: '2026-03-01',
  period_end: '2026-03-31',
  sections_enabled: { customers: false },
  data: {
    currency: 'USD',
    sectionsEnabled: { customers: false },
    totalSales: { monthGmv: '41000.00', allTimeGmv: '250000.00' },
    keyMetrics: { gmv: '41000.00', orders: '1200', customers: '950', itemsSold: '1400' },
    kpis: { completedCollabs: '55', contentPending: '12', totalOrders: '1200', freeSamplesApproved: '80' },
    gmvBreakdown: { affiliateGmv: '30000.00', organicGmv: '', liveGmv: '', videoGmv: '28000.00', productCardGmv: '' },
    topCreators: [{ username: '@m_creator', gmv: '4000.00' }],
    topVideos: [{ videoLink: 'https://example.com/v/9', gmv: '2500.00' }],
    videoPerformance: { productImpressions: '900000', productClicks: '', videoViews: '', ctr: '1.2', ctor: '', skuOrders: '', gmv: '', videos1MViews: '1', videos100kViews: '', videos10kViews: '', videos1000Gmv: '', videos100Gmv: '', newVideosPosted: '' },
    creatorsPerformance: { creators1Plus: '60', creators3Plus: '', creators10Plus: '', creators1kGmv: '', creators100Gmv: '' },
    productAnalytics: [{ productId: 'P-9', productName: 'Chef knife', unitsSold: '300', gmv: '9000.00', samplesApproved: '10' }],
    gmvMax: [{ campaign: '', spend: '', roi: '', orders: '', cpo: '', gmv: '' }],
    customers: { awareCustomers: 'SHOULD NOT APPEAR 777', newCustomers: '', potentialNewCustomers: '', crmMessagesSent: '', convertedCustomers: '' },
    keyWinsInsights: '<p>Best month ever for the knife line.</p>',
    campaignsText: '<p>Mother’s Day campaign planned.</p>',
    recommendations: '<p>Double down on knives.</p>',
    customFields: {},
  },
});

// A shape none of the known layouts recognise (e.g. an old legacy import).
export const generic = () => base({
  id: '00000000-0000-4000-8000-0000000000r5',
  type: 'weekly',
  legacy_id: 'fs-legacy-1',
  data: {
    summaryText: '<p>Imported from the old system.</p>',
    metrics: { totalGmv: '777.00', notes: 'N/A' },
    rows: [{ who: 'x_creator', amount: '12.00' }],
    rejectionNote: 'INTERNAL REVIEWER NOTE',
    submittedByName: 'Submitter Person',
  },
});
