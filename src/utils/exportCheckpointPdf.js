// ============================================================
// Weekly Checkpoint PDF export — one landscape page per slide (16:9 deck).
//
// Each ".ckpt-slide" node is rendered to a raster with html-to-image (the real
// browser renderer, so gradients / charts / fonts match the preview exactly),
// then placed full-bleed on its own 1280×720 landscape PDF page. Authored at
// exactly SLIDE_W×SLIDE_H, so a slide can never split across a page.
//
// Speed: the web fonts are embedded ONCE up-front (getFontEmbedCSS) and reused
// for every slide — otherwise html-to-image re-fetches & re-inlines the whole
// font set on each of the 12 captures, which is what made it feel slow.
// ============================================================

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export async function exportCheckpointToPdf(container, { title = 'Weekly Checkpoint', onProgress } = {}) {
  if (!container) return;
  const slides = Array.from(container.querySelectorAll('.ckpt-slide'));
  if (!slides.length) return;

  const [htmlToImage, jspdf] = await Promise.all([
    import('html-to-image'),
    import('jspdf'),
  ]);
  const JsPDF = jspdf.jsPDF || jspdf.default;

  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }

  // Embed all @font-face CSS once, then hand it to every capture so the fonts
  // aren't re-fetched per slide (the main cost with 12 slides).
  let fontEmbedCSS;
  try { fontEmbedCSS = await htmlToImage.getFontEmbedCSS(slides[0]); } catch { fontEmbedCSS = undefined; }

  const pdf = new JsPDF({ unit: 'px', format: [SLIDE_W, SLIDE_H], orientation: 'landscape' });

  for (let i = 0; i < slides.length; i++) {
    if (onProgress) onProgress(i + 1, slides.length);
    const canvas = await htmlToImage.toCanvas(slides[i], {
      pixelRatio: 1.8,
      cacheBust: false,
      backgroundColor: '#ffffff',
      width: SLIDE_W,
      height: SLIDE_H,
      fontEmbedCSS,
      filter: (el) => !(el.classList && el.classList.contains('no-print')),
    });
    if (i > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, SLIDE_W, SLIDE_H);
    // yield to the event loop so the progress label can paint between slides
    await new Promise((r) => setTimeout(r, 0));
  }

  const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120).trim();
  pdf.save(`${safe || 'Weekly Checkpoint'}.pdf`);
}
