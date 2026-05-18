// ============================================================
// Report PDF export — single continuous page.
//
// Architecture (rewritten):
//   Earlier versions handed the report to the browser's print
//   engine. The print engine ALWAYS paginates — it sliced cards,
//   charts and sections across A4 page boundaries, and the
//   "one giant @page size" trick proved unreliable across browsers.
//
//   This version removes the browser print engine entirely:
//     1. The live report DOM is rendered to a single raster image
//        with html-to-image. html-to-image uses an SVG <foreignObject>,
//        i.e. the REAL browser renderer — so every modern CSS feature
//        (color-mix, gradients, fl/grid) and the Recharts SVG charts
//        render exactly as on the dashboard. Captured at 2x device
//        pixels so text and charts stay sharp.
//     2. jsPDF builds a PDF with ONE page whose dimensions equal the
//        whole report. The image is placed on that single page.
//
//   Result: a true single continuous page — it is structurally
//   impossible for a section / card / chart / table to be split,
//   because there are no page boundaries. It opens as one long
//   scrollable page in any PDF viewer and downloads directly (no
//   print dialog).
//
//   Charts capture at their real on-dashboard size, so they keep
//   correct scaling / aspect ratio with no overflow.
//
//   The export reflects whatever theme the app is in (light/dark) —
//   most users are on light; a light document is the clean default.
// ============================================================

// Keep the raster within the browser's ~16384px canvas limit even
// for very long reports — pixelRatio scales down past this.
const MAX_CANVAS_PX = 14000;

/**
 * Export a report view to a single-page PDF and download it.
 *
 * @param {HTMLElement} node  The report canvas element (printRef.current).
 * @param {object}      opts
 * @param {string}      opts.title  Document title / PDF filename.
 */
export async function exportReportToPdf(node, { title = 'Report' } = {}) {
  if (!node) return;

  // Lazy-load the heavy libs only when the user actually exports.
  const [htmlToImage, jspdf] = await Promise.all([
    import('html-to-image'),
    import('jspdf'),
  ]);
  const JsPDF = jspdf.jsPDF || jspdf.default;

  // Make sure web fonts are ready so the first capture isn't missing
  // glyphs / icons.
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }

  const cssW = Math.ceil(node.scrollWidth);
  const cssH = Math.ceil(node.scrollHeight);

  // 2x for sharpness, scaled down on tall reports so the raster
  // stays under the browser's canvas-size limit.
  const pixelRatio = Math.min(2, MAX_CANVAS_PX / Math.max(cssW, cssH, 1));

  // Render the report DOM to a canvas. The .no-print filter drops
  // screen-only controls; cacheBust avoids stale cached images.
  // An opaque white backgroundColor guarantees no transparent
  // pixels (which would turn black once embedded as JPEG).
  const canvas = await htmlToImage.toCanvas(node, {
    pixelRatio,
    cacheBust: true,
    backgroundColor: '#ffffff',
    filter: (el) => !(el.classList && el.classList.contains('no-print')),
  });

  // One PDF page sized exactly to the whole report — page
  // dimensions in CSS px (canvas px divided back by pixelRatio).
  const pdfW = Math.max(1, Math.round(canvas.width / pixelRatio));
  const pdfH = Math.max(1, Math.round(canvas.height / pixelRatio));
  const pdf = new JsPDF({
    unit: 'px',
    format: [pdfW, pdfH],
    orientation: 'portrait',
  });
  // Embed as JPEG, not PNG: jsPDF stores a JPEG verbatim (DCTDecode),
  // whereas its PNG path re-decodes the image and corrupts large
  // captures into rainbow scanline garbage. Quality 0.95 keeps text
  // and charts crisp at the 2x capture scale.
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pdfW, pdfH);

  const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120).trim();
  pdf.save(`${safe || 'Report'}.pdf`);
}
