// Parsers that turn raw copy-pasted TikTok Shop analytics text into the shapes
// the weekly report form uses. Best-effort: the UI always falls back to manual
// entry, so these tolerate missing columns rather than throwing.
//
// Currently implemented: Top Videos, Top Creators, GMV Max.

const NOISE_TOP_VIDEOS = /^(video thumbnail|top\s*\d*\s*videos?\s*:?|creator\b.*|product info.*|video information.*)$/i;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}\b/;          // 10/18/2025 16:53
const ID_LABEL_RE = /^ID\s*:?$/i;                       // "ID:" on its own line
const ID_INLINE_RE = /^ID\s*:\s*(\d{6,})$/i;            // "ID: 7562729…" on one line
const LONG_ID_RE = /^\d{12,25}$/;                       // video / product id
const MONEY_RE = /^\$\s*[\d,]+(?:\.\d+)?$/;             // $223.9
const INT_RE = /^\d[\d,]*$/;                            // 6, 1,234

/**
 * Parse the "Top Videos" copy-paste from TikTok Shop's creator-video table.
 *
 * The export lays each video out as:
 *   <caption>                     (ignored)
 *   ID:
 *   <video id>                    ← 12-25 digit id
 *   <MM/DD/YYYY HH:MM>            ← date  (this is what distinguishes a VIDEO id
 *   <handle>                        block from the PRODUCT id block, whose id is
 *   <display name>                  followed by a category word instead of a date)
 *   <NNN Followers>
 *   <product name>
 *   ID:
 *   <product id>
 *   <category>
 *   $<gmv>                        ← Creator video-attributed GMV
 *   <items sold>                  ← Video-attributed items sold
 *   $<refunds> / <refunded> / <orders> / …   (ignored)
 *
 * We build the video URL ourselves from the handle + video id, since the paste
 * never contains it: https://www.tiktok.com/@<handle>/video/<video id>
 *
 * @param {string} raw
 * @returns {Array<{creatorName,videoLink,itemsSold,gmv,views,productClicks,notes}>}
 */
export function parseTopVideosText(raw) {
  if (!raw || !raw.trim()) return [];

  // 1. Normalise to trimmed, meaningful lines. Split any inline "ID: 123" so the
  //    rest of the logic only deals with the "ID:" + digits two-line form.
  const lines = [];
  for (const rawLine of raw.replace(/\r/g, '').split('\n')) {
    const l = rawLine.trim();
    if (!l || NOISE_TOP_VIDEOS.test(l)) continue;
    const inline = l.match(ID_INLINE_RE);
    if (inline) { lines.push('ID:'); lines.push(inline[1]); } else lines.push(l);
  }

  // 2. Locate every VIDEO-id block: "ID:" → long id → date line.
  const starts = [];
  for (let i = 0; i < lines.length - 2; i++) {
    if (ID_LABEL_RE.test(lines[i]) && LONG_ID_RE.test(lines[i + 1]) && DATE_RE.test(lines[i + 2])) {
      starts.push(i);
    }
  }

  const videos = [];
  for (let s = 0; s < starts.length; s++) {
    const i = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const videoId = lines[i + 1];
    const handle = (lines[i + 3] || '').replace(/^@/, '').trim();  // line right after the date

    // Find the PRODUCT-id marker inside this block, then read the value block
    // that follows the category line: first money = GMV, next integer = items sold.
    let productIdx = -1;
    for (let k = i + 4; k < end - 1; k++) {
      if (ID_LABEL_RE.test(lines[k]) && LONG_ID_RE.test(lines[k + 1])) { productIdx = k; break; }
    }
    const scanFrom = productIdx >= 0 ? productIdx + 2 : i + 4;  // +1 product id, +2 category

    let gmv = '', itemsSold = '';
    for (let k = scanFrom; k < end; k++) {
      if (!gmv && MONEY_RE.test(lines[k])) { gmv = lines[k].replace(/[$,\s]/g, ''); continue; }
      if (gmv && !itemsSold && INT_RE.test(lines[k])) { itemsSold = lines[k].replace(/,/g, ''); break; }
    }

    const videoLink = handle && videoId
      ? `https://www.tiktok.com/@${handle}/video/${videoId}`
      : '';

    videos.push({
      creatorName: handle,
      videoLink,
      itemsSold: itemsSold || '',
      gmv: gmv || '',
      views: '',
      productClicks: '',
      notes: '',
    });
  }

  return videos;
}

const HANDLE_RE = /^@\S+/;                              // @legendarylootfinds
const DELTA_RE = /^[+\-]\d[\d.,]*%$/;                   // +8.37%, -60%, +0%  (WoW change chips)
const TOTAL_GMV_RE = /%\s*of\s*total\s*gmv/i;           // "43.08% of total GMV"
const CREATOR_VALUE_RE = /^\$?\s*\d[\d,]*(?:\.\d+)?\s*[KMB%]?$/i;  // $608.12 · 61 · 6.43 · 2.38% · 33.07K
// TikTok renders an empty cell as a dash, and a brand-new creator's comparison
// chip as a dash or "New" (there is no previous period to compare against).
const CREATOR_DASH_RE = /^(-{1,2}|—|–|new)$/i;
const isCreatorCell = (l) => CREATOR_VALUE_RE.test(l) || CREATOR_DASH_RE.test(l);
// A chip sits AFTER a metric when the comparison toggle is on: normally a signed
// percent, but a dash / "New" for a creator with no prior period.
const isCreatorChip = (l) => DELTA_RE.test(l) || CREATOR_DASH_RE.test(l);

// The metric run right of Affiliate GMV, in TikTok's fixed column order.
const CREATOR_COLS = 8;   // commission, items, orders, avgCustomers, CTR, followers, LIVE, videos
const COL_ITEMS_SOLD = 1;
const COL_VIDEOS = 7;     // rightmost column = shoppable videos

/**
 * Parse the "Top Creators" copy-paste from TikTok Shop's creator-performance table.
 *
 * Each creator lays out as:
 *   @handle
 *   Followers
 *   <followers value>
 *   $<Affiliate GMV>              ← first money value
 *   <NN>% of total GMV
 *   $<Est. commission>
 *   <items sold>
 *   <affiliate orders>
 *   <avg customers>               ← decimal
 *   <CTR%>
 *   <affiliate followers>         ← 33.07K
 *   <LIVE streams>
 *   <shoppable videos>            ← rightmost value = videos posted
 *
 * The change-chip trap: when the period-comparison toggle is ON, TikTok emits a
 * +/-% chip after every metric. The original parser anchored on exactly that
 * ("line whose next line is a delta"), so a brand whose export had comparison
 * OFF — same columns, no chips — parsed GMV fine but left items sold and videos
 * BLANK, silently. Both layouts are live, so key on the column ORDER instead
 * (identical in both) and treat the chips as noise to skip.
 *
 * Within a creator's metric run, values are collected in order and the two we
 * want are picked by TYPE, not by index: items sold is the FIRST integer (the
 * commission before it is money; orders after it is also an integer but comes
 * later) and shoppable videos is the LAST integer (avg-customers is a decimal,
 * CTR a percent, followers a K/M value — none are integers). That survives both
 * layouts and any column TikTok hides.
 *
 * @param {string} raw
 * @returns {Array<{name,videosPosted,itemsSold,gmv,notes}>}
 */
export function parseTopCreatorsText(raw) {
  if (!raw || !raw.trim()) return [];
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);

  const starts = [];
  for (let i = 0; i < lines.length; i++) if (HANDLE_RE.test(lines[i])) starts.push(i);

  const strip = v => (v == null ? '' : String(v).replace(/[$,%\s]/g, ''));
  const isInt = v => INT_RE.test(String(v).trim());
  // A dash cell means zero (no LIVE streams, no videos) — not "unknown".
  const cellInt = (v) => (v == null ? '' : CREATOR_DASH_RE.test(v) ? '0' : isInt(v) ? strip(v) : '');
  const creators = [];

  for (let s = 0; s < starts.length; s++) {
    const i = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(i, end);
    const name = block[0].replace(/^@/, '').trim();

    // Affiliate GMV = first money value; Est. commission = the second. The
    // commission is where the metric run begins.
    let gmvIdx = -1, commIdx = -1, gmv = '';
    for (let k = 1; k < block.length; k++) {
      if (!MONEY_RE.test(block[k])) continue;
      if (gmvIdx < 0) { gmvIdx = k; gmv = strip(block[k]); }
      else { commIdx = k; break; }
    }

    // Is the comparison toggle on? If so EVERY metric is trailed by a chip, so
    // the values sit at every OTHER line. Decide by looking at the line right
    // after the commission: with chips it's a chip, without it's items sold (an
    // integer). Stepping by 2 in chip mode also means a metric whose own value is
    // a dash (0 LIVE streams) is read as a value, not mistaken for a chip.
    const chipMode = commIdx >= 0 && commIdx + 1 < block.length
      && isCreatorChip(block[commIdx + 1]);
    const step = chipMode ? 2 : 1;

    // Walk the fixed column order. Capping at CREATOR_COLS is what stops trailing
    // junk — pagination page-numbers ("1 2 3"), a rows-per-page "50" — from being
    // read as a metric: they fall outside the 8 real columns and are never seen.
    const cells = [];
    for (let k = commIdx; commIdx >= 0 && k < block.length && cells.length < CREATOR_COLS; k += step) {
      const l = block[k];
      if (TOTAL_GMV_RE.test(l)) continue;
      if (!isCreatorCell(l)) break;      // real text (a header, a caption) ends the run
      cells.push(l);
    }

    // Read by POSITION, never by "the last integer" — that rule silently reported
    // the AFFILIATE ORDERS column as videos whenever anything truncated the run.
    // A short run means the layout isn't the one we know, so leave the field BLANK
    // for manual entry: a wrong number in a client report is far worse than a gap.
    const itemsSold = cells.length > COL_ITEMS_SOLD ? cellInt(cells[COL_ITEMS_SOLD]) : '';
    const videosPosted = cells.length === CREATOR_COLS ? cellInt(cells[COL_VIDEOS]) : '';

    creators.push({ name, videosPosted, itemsSold, gmv, notes: '' });
  }

  return creators;
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;   // 2026-02-13 06:58:53
const USD_VALUE_RE = /^\$?\s*[\d,]+(?:\.\d+)?\s*USD$/i;           // 160.00 USD, 3,197.20 USD
const PURE_INT_RE = /^\d{1,3}(?:,\d{3})*$|^\d+$/;                 // 61, 1,234
const PURE_DECIMAL_RE = /^\d+\.\d+$/;                             // 0.77, 1.50

// A campaign's metrics TAIL (everything between its start-time and the NEXT
// campaign's name) is only value-like lines — this small, well-defined set. We
// use it to find each campaign name by scanning DOWN from the previous
// campaign's start-time: the first line that is NOT tail noise is the next
// campaign's name (the name always leads a block). This is far more robust than
// blacklisting the header's status/recommendation TEXT above the start-time,
// which varies wildly ("Not delivering", "Budget fully spent", "Campaign
// inactive", "Consider increasing", a bare "-", …) and broke name detection.
function isGmvTailNoise(l) {
  return USD_VALUE_RE.test(l)
    || PURE_DECIMAL_RE.test(l)
    || PURE_INT_RE.test(l)
    || /^-+$/.test(l)
    || /^(base|daily) budget:/i.test(l)
    || /^continuously$/i.test(l)
    || /^(analytics|edit)$/i.test(l)
    || DATETIME_RE.test(l);
}

const stripUsd = v => (v == null ? '' : String(v).replace(/USD/i, '').replace(/[$,\s]/g, ''));

/**
 * Parse the "GMV Max" campaign-list copy-paste (Product or LIVE GMV Max).
 *
 * TikTok's export dumps each campaign's columns top-to-bottom. Column meaning is
 * pinned by position + arithmetic (verified against real data): Cost/Spend is the
 * 2nd bare "X USD" line in the header (the 1st is the campaign budget; the
 * "N recommendation(s)" line between them is NOT always present). After the
 * start-time + schedule come the per-period metrics, where the lone bare integer
 * is Orders, the next USD is Cost-per-order, the USD after that is GMV, and the
 * bare decimal after GMV is ROI (= GMV ÷ Cost). Everything else (budgets, ROI
 * target, ROI-protection, gross revenue) is read past.
 *
 *   <name>
 *   [Analytics] [Edit]          (row buttons — noise)
 *   Active
 *   <campaign budget> USD / Daily budget: … USD
 *   N recommendation(s)
 *   <Spend> USD                 ← Cost
 *   [Base budget: … USD] / ROI protection eligible / - / -
 *   <YYYY-MM-DD HH:MM:SS>       ← start time (per-campaign anchor)
 *   Continuously
 *   … <Orders> <CPO USD> <GMV USD> <ROI> [Base budget: <n>]
 *
 * Applies equally to weekly and month-to-date — the user just changes the date
 * filter in TikTok Shop and re-pastes.
 *
 * @param {string} raw
 * @returns {Array<{campaign,spend,roi,orders,cpo,gmv,notes}>}
 */
export function parseGmvMaxText(raw) {
  if (!raw || !raw.trim()) return [];
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);

  const dts = [];
  for (let i = 0; i < lines.length; i++) if (DATETIME_RE.test(lines[i])) dts.push(i);

  // Campaign name = the FIRST line of each campaign block. Find it by scanning
  // DOWN from the previous campaign's start-time (or the top of the paste for
  // the first one) to the first line that isn't metrics-tail noise — the name
  // always leads a block, before its status / budget / recommendation lines.
  // Scanning down past the well-defined value tail is robust to the arbitrary
  // status/recommendation text that a walk-UP would trip over.
  const nameIdx = dts.map((dt, c) => {
    const start = c === 0 ? 0 : dts[c - 1] + 1;
    for (let k = start; k < dt; k++) {
      if (!isGmvTailNoise(lines[k])) return k;
    }
    return -1;
  });

  const rows = [];
  for (let c = 0; c < dts.length; c++) {
    const dt = dts[c];
    const nIdx = nameIdx[c];
    if (nIdx < 0) continue;
    const campaign = lines[nIdx];

    // Cost column (report "Spend"). TikTok column order is: Campaign budget →
    // Recommendations → Cost. The header's bare "X USD" lines are exactly
    // [campaign budget, cost] — "Daily budget:"/"Base budget:" sublabels don't
    // match USD_VALUE_RE (whole-line anchored). The "N recommendation(s)" line is
    // NOT always present (a campaign can have 0 / "-"), so we can't rely on it:
    // prefer the first bare USD AFTER it when present, else fall back to the 2nd
    // bare USD (i.e. skip the campaign budget, which is always the 1st).
    let spend = '';
    const headerUsd = [];
    let recIdx = -1;
    for (let k = nIdx + 1; k < dt; k++) {
      if (recIdx < 0 && /recommendation/i.test(lines[k])) recIdx = k;
      if (USD_VALUE_RE.test(lines[k])) headerUsd.push({ k, v: lines[k] });
    }
    if (recIdx >= 0) {
      const afterRec = headerUsd.find(u => u.k > recIdx);
      if (afterRec) spend = stripUsd(afterRec.v);
    }
    if (!spend && headerUsd.length > 1) spend = stripUsd(headerUsd[1].v);

    // Tail metrics live between this start-time and the next campaign's name.
    const tailEnd = c + 1 < dts.length ? nameIdx[c + 1] : lines.length;
    let orders = '', cpo = '', gmv = '', roi = '';
    let ordersIdx = -1;
    for (let k = dt + 1; k < tailEnd; k++) {
      if (PURE_INT_RE.test(lines[k]) && !USD_VALUE_RE.test(lines[k])) { orders = lines[k].replace(/,/g, ''); ordersIdx = k; break; }
    }
    if (ordersIdx >= 0) {
      const usds = [];
      for (let k = ordersIdx + 1; k < tailEnd; k++) if (USD_VALUE_RE.test(lines[k])) usds.push({ k, v: lines[k] });
      if (usds[0]) cpo = stripUsd(usds[0].v);
      if (usds[1]) gmv = stripUsd(usds[1].v);
      const afterGmv = usds[1] ? usds[1].k : ordersIdx;
      for (let k = afterGmv + 1; k < tailEnd; k++) {
        if (PURE_DECIMAL_RE.test(lines[k])) { roi = lines[k]; break; }
      }
    }

    rows.push({ campaign, spend, roi, orders, cpo, gmv, notes: '' });
  }

  return rows;
}
