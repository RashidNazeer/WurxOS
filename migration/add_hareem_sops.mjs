import { sb } from './lib/supabase.js';
const APPLY = process.argv.includes('--apply');

const BOSS_ID = '205800a5-6baf-5bed-bec7-322ae135dda9'; // Usman Qamar

const articles = [
  {
    title: 'How to Research Competitor Products Using Categories on Kalodata',
    url:   'https://docs.google.com/document/d/1vWB4q6sFIbyr69rPOO6OZCQYHFh1B1jbhQLtMWIsQpU/edit?tab=t.0#heading=h.btcvletcp54m',
  },
  {
    title: 'How to Check Content for Violations',
    url:   'https://docs.google.com/document/d/1391e9WPd0MNfRRT03NNuSxG997B7b49znJZIt1_sGic/edit?tab=t.0#heading=h.bzoec7mrkqqu',
  },
  {
    title: 'How to Create a Content Brief',
    url:   'https://docs.google.com/document/d/18lKEh-iym-5ACQ7_5PhSICJZO5vVg7DK9c6YdqolGUk/edit?tab=t.0#heading=h.x3csf721ujg4',
  },
  {
    title: 'How to Find High-Performing Creative Angles',
    url:   'https://docs.google.com/document/d/1X8027C3GQJOBmqRA3bJO58XimTWQfkBBIOLG0doW2sk/edit?tab=t.0#heading=h.cc1xs990gmcz',
  },
  {
    title: 'How to Research Top Performing Videos After Identifying Competitors',
    url:   'https://docs.google.com/document/d/1bfVTOnA9IoSP6YYqKg6ZOgMgASM-fs38RfZ69eKiBPU/edit?tab=t.0#heading=h.ukmu0wpaij06',
  },
  {
    title: 'How to Research Competitor Products Using Keywords on Kalodata',
    url:   'https://docs.google.com/document/d/1oMC1kJazmC7eTOrMjVG3EpYsa9lAZ8HJ-ZmJYgynwzw/edit?tab=t.0#heading=h.5zy8efnsinxa',
  },
  {
    title: 'How to Conduct Calls With Creators Explaining Briefs',
    url:   'https://docs.google.com/document/d/1Zq0_1t_ffry5FbdAXbwiWmHLo6nXMNDP77tZQDT0tvU/edit?tab=t.0#heading=h.ovlvlpgqb7gb',
  },
  {
    title: 'How to Update Creative Angle Testing Sheets',
    url:   'https://docs.google.com/document/d/1FTnBUjdlM-NIkCBUnsy3UprMVuMj4dpj1qP3GZ78e20/edit?tab=t.0#heading=h.x3csf721ujg4',
  },
];

const rows = articles.map((a) => ({
  title:        a.title,
  body:         `Full SOP in Google Docs: <a href="${a.url}" target="_blank" rel="noopener noreferrer">${a.url}</a>`,
  category:     'operational_sops',
  visibility:   'office',
  tags:         [],
  created_by:   BOSS_ID,
  url:          a.url,
  approval_status: 'approved',
  approved_by:  BOSS_ID,
  approved_at:  new Date().toISOString(),
  version:      1,
  version_label: '1.0',
  requires_ack: false,
  author_role:  'boss',
}));

console.log(`Will insert ${rows.length} KB articles as Usman Qamar (boss):`);
for (const r of rows) {
  console.log(`  • ${r.title}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN. Re-run with --apply to insert.');
  process.exit(0);
}

const { data, error } = await sb.from('kb_articles').insert(rows).select('id, title');
if (error) { console.error('Insert failed:', error); process.exit(1); }
console.log(`\nInserted ${data.length} articles:`);
for (const r of data) console.log(`  ${r.id}  ${r.title}`);
