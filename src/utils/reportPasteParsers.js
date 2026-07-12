// Parsers that turn raw copy-pasted TikTok Shop analytics text into the shapes
// the weekly report form uses. Best-effort: the UI always falls back to manual
// entry, so these tolerate missing columns rather than throwing.
//
// Currently implemented: Top Videos, Top Creators.  (GMV Max to follow.)

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

/**
 * Parse the "Top Creators" copy-paste from TikTok Shop's creator-performance table.
 *
 * Each creator lays out as:
 *   @handle
 *   Followers
 *   <followers value>
 *   $<Affiliate GMV>              ← the ONLY money value not followed by a delta
 *   <NN>% of total GMV
 *   $<Est. commission>   <delta>
 *   <items sold>         <delta>
 *   <affiliate orders>   <delta>
 *   <avg customers>      <delta>
 *   <CTR%>               <delta>
 *   <affiliate followers><delta>
 *   <LIVE streams>       <delta>
 *   <shoppable videos>   <delta>  ← rightmost value = videos posted
 *
 * Every metric value is immediately followed by its own +/-% change chip, so we
 * collect "line whose next line is a delta" in order: [0]=commission,
 * [1]=items sold, and the last = shoppable videos posted. Affiliate GMV is the
 * exception (followed by "% of total GMV"), so it's read as the first $ value.
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
  const creators = [];

  for (let s = 0; s < starts.length; s++) {
    const i = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(i, end);
    const name = block[0].replace(/^@/, '').trim();

    // Affiliate GMV = first money value in the block.
    let gmv = '';
    for (let k = 1; k < block.length; k++) {
      if (MONEY_RE.test(block[k])) { gmv = strip(block[k]); break; }
    }

    // Ordered metric values = a line whose NEXT line is a delta chip.
    const values = [];
    for (let k = 0; k < block.length - 1; k++) {
      if (!DELTA_RE.test(block[k]) && DELTA_RE.test(block[k + 1])) values.push(block[k]);
    }
    const itemsSold = values.length > 1 ? strip(values[1]) : '';
    const videosPosted = values.length ? strip(values[values.length - 1]) : '';

    creators.push({ name, videosPosted, itemsSold, gmv, notes: '' });
  }

  return creators;
}
