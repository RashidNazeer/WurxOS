// ============================================================
// Weekly Checkpoint PDF export — one landscape page per slide (16:9 deck).
//
// Each ".ckpt-slide" node inside the deck is rendered to a raster at 2x with
// html-to-image (the real browser renderer, so gradients / charts / fonts
// match the preview exactly), then placed full-bleed on its own 1280×720
// landscape PDF page. The slides are authored at exactly SLIDE_W×SLIDE_H so a
// slide can never be split across a page boundary.
// ============================================================

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export async function exportCheckpointToPdf(container, { title = 'Weekly Checkpoint' } = {}) {
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

  const pdf = new JsPDF({ unit: 'px', format: [SLIDE_W, SLIDE_H], orientation: 'landscape' });

  for (let i = 0; i < slides.length; i++) {
    const node = slides[i];
    // Capture at the slide's authored size (2x for sharpness). Ancestor CSS
    // transforms on the preview don't affect the node's own box, so this is
    // always full-resolution regardless of how small the preview is scaled.
    const canvas = await htmlToImage.toCanvas(node, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#ffffff',
      width: SLIDE_W,
      height: SLIDE_H,
      filter: (el) => !(el.classList && el.classList.contains('no-print')),
    });
    if (i > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, SLIDE_W, SLIDE_H);
  }

  const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120).trim();
  pdf.save(`${safe || 'Weekly Checkpoint'}.pdf`);
}
