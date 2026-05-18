// ============================================================
// Professional PDF export for report dashboards.
//
// Why a print window (structured rendering) and NOT a screenshot:
//   The old export copied the report's innerHTML into a blank
//   window with none of the app's CSS, so every card / grid / flex
//   layout collapsed into stretched rows. A screenshot approach
//   (html2canvas) would fix layout but rasterises everything —
//   blurry text and charts, huge files, no selectable text.
//
//   This exporter renders the REAL report DOM into a print window
//   with the app's REAL stylesheets, then opens the print dialog
//   ("Save as PDF"). True vector output: crisp text + charts
//   (Recharts SVG renders natively), correct cards / grids /
//   spacing, small file, matches the dashboard.
//
// Pagination — single continuous page:
//   This PDF is for digital viewing/sharing, not physical printing.
//   So instead of slicing the report into A4 pages (which cuts
//   cards and sections in half at page boundaries), we measure the
//   rendered report and set the @page size to ONE page exactly as
//   tall as the content. The result is a single continuous page
//   that scrolls smoothly in any PDF viewer — nothing is ever split.
//
//   Reports taller than the PDF page ceiling (~200in) fall back to
//   A4 landscape with break-inside rules that keep cards/charts
//   whole — a rare case for an extremely long report.
//
//   The page is forced to LIGHT theme for a clean document.
// ============================================================

// PDF pages cannot exceed ~200 inches (the PDF spec ceiling). At
// 96dpi that's ~19200px — stay just under it.
const MAX_PAGE_PX = 19000;

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
  //    bootstrap-icons, design tokens, global + component CSS) so
  //    the export renders with identical layout to the dashboard.
  const styleTags = [];
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => {
    styleTags.push(el.outerHTML);
  });

  // 2. Snapshot the report canvas. Inline var(--token) references
  //    resolve against the light-theme tokens below.
  const reportHtml = node.outerHTML;

  // 3. Print-only stylesheet — light theme, clean canvas chrome.
  //    Note: no @page rule here — it is added dynamically once we
  //    have measured the content (see the inline script below).
  const printCss = `
    html { color-scheme: light; }
    body {
      margin: 0;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    /* Fixed-width document column so the export is deterministic
       regardless of the exporting user's screen size. */
    .wx-export-shell {
      width: 1000px;
      margin: 0 auto;
      padding: 24px;
      background: #ffffff;
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
    .wx-export-shell img,
    .wx-export-shell svg { max-width: 100%; }
    .wx-export-shell table { width: 100%; }
    /* Page-break safety — only relevant for the rare multi-page
       fallback (a report too tall for one PDF page). Keeps cards,
       chart blocks and headings from being cut in half. */
    .wx-export-shell .card,
    .wx-export-shell .recharts-responsive-container {
      break-inside: avoid;
    }
    .wx-export-shell h1, .wx-export-shell h2, .wx-export-shell h3,
    .wx-export-shell h4, .wx-export-shell h5, .wx-export-shell h6 {
      break-after: avoid;
    }
    /* Safety-net default page — overridden by the measured size. */
    @page { size: A4 landscape; margin: 12mm; }
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
    (function () {
      var MAX = ${MAX_PAGE_PX};
      // Size the PDF to a SINGLE continuous page exactly as tall as
      // the report, so nothing is ever split across pages. If the
      // report is taller than the PDF ceiling, keep the safety-net
      // A4 page (break-inside rules keep blocks intact).
      function setPageSize() {
        var shell = document.querySelector('.wx-export-shell');
        if (!shell) return;
        var w = Math.ceil(shell.scrollWidth);
        var h = Math.ceil(shell.scrollHeight) + 4;
        if (h > MAX) return; // too tall — fall back to the A4 default
        var st = document.createElement('style');
        st.textContent = '@page { size: ' + w + 'px ' + h + 'px; margin: 0; }';
        document.head.appendChild(st);
      }
      function go() {
        var fontsReady = (document.fonts && document.fonts.ready)
          ? document.fonts.ready : Promise.resolve();
        fontsReady.then(function () {
          // Let linked CSS + charts settle, measure, then print.
          setTimeout(function () {
            setPageSize();
            window.focus();
            window.print();
          }, 300);
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
