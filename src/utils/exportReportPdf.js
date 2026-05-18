// ============================================================
// Professional PDF export for report dashboards.
//
// Why a print window (structured rendering) and NOT a screenshot:
//   The old export copied the report's innerHTML into a blank
//   window with none of the app's CSS, so every card / grid / flex
//   layout collapsed into stretched rows and the theme colours were
//   lost. A screenshot approach (html2canvas) would fix the layout
//   but rasterises everything — blurry text, blurry charts, huge
//   files, no selectable text.
//
//   This exporter instead renders the REAL report DOM into a print
//   window with the app's REAL stylesheets, then opens the browser
//   print dialog ("Save as PDF"). The result is a true vector PDF:
//   crisp text and charts (Recharts SVG renders natively), correct
//   cards / grids / spacing / typography, small file size, and the
//   layout matches the dashboard exactly.
//
//   The page is forced to LIGHT theme + landscape A4 so multi-column
//   dashboard layouts and wide stat grids fit without being squashed.
// ============================================================

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/**
 * Export a report view to PDF via the browser print dialog.
 *
 * @param {HTMLElement} node  The report canvas element (printRef.current).
 * @param {object}      opts
 * @param {string}      opts.title  Document title / PDF filename hint.
 */
export function exportReportToPdf(node, { title = 'Report' } = {}) {
  if (!node) return;

  // 1. Clone EVERY stylesheet the app currently uses (Bootstrap,
  //    bootstrap-icons, design tokens, global + component CSS). This
  //    is what makes the export look like the dashboard — without it
  //    className-based layout has no rules and collapses.
  const styleTags = [];
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => {
    styleTags.push(el.outerHTML);
  });

  // 2. Snapshot the report canvas. Inline var(--token) references in
  //    the markup resolve against the light-theme tokens below.
  const reportHtml = node.outerHTML;

  // 3. Print-only stylesheet — light theme, landscape page, clean
  //    canvas chrome, sensible page breaks, colour-accurate output.
  const printCss = `
    html { color-scheme: light; }
    body {
      margin: 0;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    /* Centered document column. Landscape A4 printable width is
       ~1030px @96dpi — 1000px fits with no scaling, so dashboard
       grids and charts keep their real proportions. */
    .wx-export-shell {
      width: 1000px;
      margin: 0 auto;
      padding: 20px;
    }
    /* The in-app canvas has a tinted background, border and rounded
       corners for the screen — strip them for a clean white page. */
    .wx-export-shell .report-canvas {
      background: #ffffff !important;
      border: none !important;
      border-radius: 0 !important;
      padding: 0 !important;
    }
    /* Drop screen-only controls (action buttons, popovers, etc.). */
    .no-print, .no-print * { display: none !important; }
    /* Keep cards, stat tiles and chart blocks whole across page
       breaks where they reasonably fit; tall blocks still break. */
    .wx-export-shell .card,
    .wx-export-shell .recharts-responsive-container {
      break-inside: avoid;
    }
    .wx-export-shell h1, .wx-export-shell h2,
    .wx-export-shell h3, .wx-export-shell h4,
    .wx-export-shell h5, .wx-export-shell h6 {
      break-after: avoid;
    }
    /* Media never overflows the page; charts keep aspect ratio. */
    .wx-export-shell img,
    .wx-export-shell svg { max-width: 100%; }
    .wx-export-shell table { width: 100%; }
    @page { size: A4 landscape; margin: 12mm; }
    @media print {
      .wx-export-shell { width: auto; padding: 0; }
    }
  `;

  const win = window.open('', '_blank', 'width=1180,height=900');
  if (!win) {
    alert('Please allow pop-ups for this site to export the PDF.');
    return;
  }

  // data-theme=light forces light design tokens; data-bs-theme keeps
  // Bootstrap components light too.
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html lang="en" data-theme="light" data-bs-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  ${styleTags.join('\n  ')}
  <style>${printCss}</style>
</head>
<body>
  <div class="wx-export-shell">${reportHtml}</div>
  <script>
    // Wait for linked stylesheets + web fonts to finish, then open
    // the print dialog. Closing after print keeps things tidy.
    (function () {
      function go() {
        var fontsReady = (document.fonts && document.fonts.ready)
          ? document.fonts.ready : Promise.resolve();
        fontsReady.then(function () {
          setTimeout(function () { window.focus(); window.print(); }, 250);
        });
      }
      if (document.readyState === 'complete') go();
      else window.addEventListener('load', go);
      window.onafterprint = function () { window.close(); };
    })();
  </script>
</body>
</html>`);
  win.document.close();
}
