// ============================================================
// The demo company: Meridian Media.
//
// One invented TikTok Shop affiliate agency — same business model as the real
// one, so every feature in the app still makes sense, but not one real person,
// brand or number.
//
// This file is the SINGLE SOURCE OF TRUTH for the demo org. It is imported by
// two very different consumers:
//   * scripts/seed-demo.mjs  (Node)    — creates these people and brands
//   * src/components/demo/DemoBar.jsx  (browser) — lets you sign in as them
// so it must stay pure data with no imports and no `import.meta` / `process`.
// If the two ever disagree the switcher offers accounts that do not exist.
//
// The org shape is deliberately the one the app expects (verified against the
// real model, which this mirrors without copying):
//   profiles.reports_to        APC -> TL, IPC -> PCTL; TL/PCTL themselves null
//   brands.owner_id            the TL who owns the brand (NOT the APC)
//   brand_assignments          the APC <-> brand link — how an APC's brands are
//                              found; never owner_id
//   ads_manager_brands         separate on purpose: an ads manager runs a
//                              brand's ads, they do not coordinate the brand
// Get this wrong and screens render empty rather than erroring, which in a
// live walkthrough is the worst possible failure.
// ============================================================

export const DEMO_COMPANY = 'Meridian Media';

// Undeliverable by construction, so nothing the demo does can ever mail a real
// person. Accounts are created pre-confirmed; no address is ever contacted.
const DOMAIN = 'meridian.example.com';
const mail = (slug) => `${slug}@${DOMAIN}`;

// Ordered for the role switcher's dropdown: the order you would actually walk
// someone through the product — the top of the company down to the floor.
export const DEMO_USERS = [
  {
    key: 'boss', email: mail('adrian.vance'), name: 'Adrian Vance',
    role: 'boss', title: 'Founder',
    blurb: 'Sees everything: payroll, every brand, the nuclear buttons.',
    salary: 0, startDate: '2023-01-09',
  },
  {
    key: 'ol', email: mail('priya.raghavan'), name: 'Priya Raghavan',
    role: 'ol', title: 'Operations Lead',
    blurb: 'Runs the week: verifies incentive plans, rates APCs, chairs agenda.',
    salary: 240000, startDate: '2023-03-20',
  },
  {
    key: 'tl_alpha', email: mail('marcus.bell'), name: 'Marcus Bell',
    role: 'tl', title: 'Team Lead — Alpha',
    blurb: 'Owns four brands and the three APCs who run them.',
    salary: 180000, startDate: '2023-06-12',
  },
  {
    key: 'tl_beta', email: mail('elena.ortiz'), name: 'Elena Ortiz',
    role: 'tl', title: 'Team Lead — Beta',
    blurb: 'Second brand team; useful for showing team-vs-team performance.',
    salary: 180000, startDate: '2023-09-04',
  },
  {
    key: 'pctl', email: mail('tomas.nagy'), name: 'Tomas Nagy',
    role: 'pctl', title: 'Paid Collab Team Lead',
    blurb: 'The paid-collaboration side: budgets, creator deals, IPCs.',
    salary: 175000, startDate: '2024-01-15',
  },
  {
    key: 'ads', email: mail('dana.whitfield'), name: 'Dana Whitfield',
    role: 'ads_manager', title: 'Ads Manager',
    blurb: 'GMV Max spend across four brands. Sees only what is granted.',
    salary: 165000, startDate: '2024-02-05',
  },
  {
    key: 'apc_leo', email: mail('leo.fontaine'), name: 'Leo Fontaine',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Two brands. The busiest account — best one to demo the APC day.',
    salary: 95000, startDate: '2024-04-08', reportsTo: 'tl_alpha',
  },
  {
    key: 'apc_mira', email: mail('mira.castellanos'), name: 'Mira Castellanos',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Strong performer — shows what a promotion-track score looks like.',
    salary: 92000, startDate: '2024-05-20', reportsTo: 'tl_alpha',
  },
  {
    key: 'apc_jonah', email: mail('jonah.reid'), name: 'Jonah Reid',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Carries a red flag and a warning — the difficult-conversation case.',
    salary: 88000, startDate: '2024-08-01', reportsTo: 'tl_alpha',
  },
  {
    key: 'apc_ayesha', email: mail('ayesha.karim'), name: 'Ayesha Karim',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Two brands on the Beta team.',
    salary: 94000, startDate: '2024-03-11', reportsTo: 'tl_beta',
  },
  {
    key: 'apc_ivan', email: mail('ivan.petrov'), name: 'Ivan Petrov',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Newest hire — thin history, shows how the app treats a new joiner.',
    salary: 85000, startDate: '2025-11-17', reportsTo: 'tl_beta',
  },
  {
    key: 'apc_nadia', email: mail('nadia.haddad'), name: 'Nadia Haddad',
    role: 'apc', title: 'Affiliate Partnerships Coordinator',
    blurb: 'Covering a second brand temporarily — shows the cover mechanism.',
    salary: 93000, startDate: '2024-06-24', reportsTo: 'tl_beta',
  },
  {
    key: 'ipc_ruth', email: mail('ruth.adeyemi'), name: 'Ruth Adeyemi',
    role: 'ipc', title: 'Influencer Partnerships Coordinator',
    blurb: 'Paid collab work — no affiliate brands, by design.',
    salary: 90000, startDate: '2024-07-15', reportsTo: 'pctl',
  },
  {
    key: 'ipc_kai', email: mail('kai.lindqvist'), name: 'Kai Lindqvist',
    role: 'ipc', title: 'Influencer Partnerships Coordinator',
    blurb: 'Second IPC.',
    salary: 90000, startDate: '2025-02-10', reportsTo: 'pctl',
  },
  {
    key: 'dev', email: mail('sam.okoye'), name: 'Sam Okoye',
    role: 'developer', title: 'Developer',
    blurb: 'The build queue — dev projects, tasks, bug reports.',
    salary: 200000, startDate: '2023-11-06',
  },
];

// Brands. `owner` is a TL key; `apcs` are APC keys (brand_assignments).
// `cover` is a SECOND, time-boxed assignment — the app treats a null expiry as
// permanent and a dated one as temporary cover, and several rules hang off that
// difference, so the demo carries one of each.
export const DEMO_BRANDS = [
  {
    key: 'novafuel', name: 'NovaFuel Supplements', client: 'NovaFuel Labs Inc.',
    currency: 'USD', tier: 'Tier 1', owner: 'tl_alpha', apcs: ['apc_leo'],
    gmvTarget: 145000, gmvAchieved: 151480,
  },
  {
    key: 'lumen', name: 'Lumen Skincare', client: 'Lumen Beauty Group',
    currency: 'USD', tier: 'Tier 1', owner: 'tl_alpha', apcs: ['apc_leo'],
    gmvTarget: 120000, gmvAchieved: 108250,
  },
  {
    key: 'terrapaws', name: 'Terra Paws', client: 'Terra Pet Co.',
    currency: 'USD', tier: 'Tier 2', owner: 'tl_alpha', apcs: ['apc_mira'],
    gmvTarget: 86000, gmvAchieved: 94310,
  },
  {
    key: 'brightside', name: 'Brightside Wellness', client: 'Brightside Ltd',
    currency: 'GBP', tier: 'Tier 2', owner: 'tl_alpha', apcs: ['apc_jonah'],
    gmvTarget: 64000, gmvAchieved: 51900,
  },
  {
    key: 'kettle', name: 'Kettle & Co', client: 'Kettle Foods LLC',
    currency: 'USD', tier: 'Tier 2', owner: 'tl_beta', apcs: ['apc_ayesha'],
    gmvTarget: 78000, gmvAchieved: 80640,
  },
  {
    key: 'verahome', name: 'Vera Home', client: 'Vera Living',
    currency: 'USD', tier: 'Tier 3', owner: 'tl_beta', apcs: ['apc_ayesha'],
    gmvTarget: 42000, gmvAchieved: 38970,
  },
  {
    key: 'peak', name: 'Peak Athletics', client: 'Peak Sportswear Ltd',
    currency: 'GBP', tier: 'Tier 2', owner: 'tl_beta', apcs: ['apc_ivan'],
    gmvTarget: 55000, gmvAchieved: 57120,
  },
  {
    key: 'bloom', name: 'Bloom Botanicals', client: 'Bloom Natural Co.',
    currency: 'USD', tier: 'Tier 1', owner: 'tl_beta', apcs: ['apc_nadia'],
    // Nadia owns this one; Ivan is covering it while she is on leave. Dated
    // expiry = temporary, which is what makes it cover rather than a swap.
    cover: { apc: 'apc_ivan', days: 9 },
    gmvTarget: 132000, gmvAchieved: 139880,
  },
];

// Which brands the ads manager may see. Deliberately a subset — an ads manager
// with an empty set sees nothing at all, and showing a partial set is the
// clearest way to demonstrate that the boundary is real.
export const DEMO_ADS_BRANDS = ['novafuel', 'lumen', 'bloom', 'peak'];

// Brands the paid-collab side works, and the OL's curated incentive brands.
export const DEMO_PAID_COLLAB_BRANDS = ['novafuel', 'terrapaws', 'kettle', 'bloom'];
export const DEMO_OL_INCENTIVE_BRANDS = ['novafuel', 'lumen', 'terrapaws', 'bloom'];

export const byKey = (k) => DEMO_USERS.find((u) => u.key === k);
export const brandByKey = (k) => DEMO_BRANDS.find((b) => b.key === k);
