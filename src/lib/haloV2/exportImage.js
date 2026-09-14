// ============================================================
// Halo V2 - the one-pager as a PNG.
//
// The PDF export already exists and rasterises the same off-screen document.
// PNG is here because the realistic path for a one-pager is a Slack message or
// a slide, and a PDF has to be opened, screenshotted and cropped before it can
// be either. Same node, same capture, no page wrapper.
//
// html-to-image is lazy-loaded so the portal bundle does not carry it for
// clients who never export.
// ============================================================

export async function exportNodeToPng(node, { filename = 'Halo V2', pixelRatio = 2 } = {}) {
  if (!node) return;
  const { toPng } = await import('html-to-image');
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* fonts are best effort */ }
  }
  const dataUrl = await toPng(node, {
    pixelRatio,
    cacheBust: true,
    backgroundColor: '#ffffff',
    filter: (el) => !(el.classList && el.classList.contains('no-print')),
  });
  const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120).trim() || 'Halo V2';
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${safe}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
