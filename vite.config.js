import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// ── Demo branding ───────────────────────────────────────────────────────────
// Renames the product at BUILD time for demo deployments, so a sales demo can
// be walked through without the company's name on screen.
//
// Why a build plugin instead of an APP_NAME constant threaded through the JSX:
// the name appears in ~57 places as plain display text, and rewriting every one
// of them would mean 24 files of production diff — and a permanent risk that a
// future edit reintroduces a hardcoded name. A build-time swap leaves the
// source, and therefore the production bundle, byte-for-byte as it was. If the
// demo is never built, this plugin never runs.
//
// It is deliberately a dumb, case-sensitive string replace over src/ only.
// That is safe here because every functional use of the name is lowercase
// (`wurxos-theme`, `wurxos.sidebar.collapsed`, the `wurxos-nav` postMessage
// type, `https://wurxos.web.app`) and therefore matches none of these tokens.
// Verified before writing this; keep it that way — if a MixedCase form of the
// name ever becomes a storage key or a message type, this would rename it and
// silently break state persistence.
//
// Order matters: longest first, so 'Wurx Media' is consumed before the bare
// 'Wurx' rule can bite off its first word.
const BRAND_TOKENS = [
  ['WurxMediaHub', 'MeridianHub'],
  ['Wurx Media',   'Meridian Media'],
  ['WurxCrew',     'MeridianCrew'],
  ['WurxOS',       'OpsDeck'],
  ['Wurx',         'Meridian'],
];

// The real logo is a binary asset in public/ and would otherwise be copied
// into the demo bundle and reachable at its usual URL. Demo builds point every
// reference at the SVG instead, and the binaries are deleted from the output.
const LOGO_SWAPS = [
  ['/Logo.png', '/logo.svg'],
];

const DEMO_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="OpsDeck">
  <rect width="512" height="512" rx="112" fill="#141414"/>
  <g fill="none" stroke="#c2704e" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">
    <path d="M256 108 408 190 256 272 104 190 Z"/>
    <path d="M104 256 256 338 408 256" opacity="0.72"/>
    <path d="M104 322 256 404 408 322" opacity="0.44"/>
  </g>
</svg>
`;

function applyTokens(text) {
  let out = text;
  for (const [from, to] of BRAND_TOKENS) out = out.split(from).join(to);
  for (const [from, to] of LOGO_SWAPS) out = out.split(from).join(to);
  return out;
}

function demoBranding(enabled) {
  if (!enabled) return null;
  return {
    name: 'demo-branding',
    // 'pre' so the swap happens on raw source, before the React plugin turns
    // JSX text into string literals. Nothing downstream can tell the
    // difference from a file that always said OpsDeck.
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!/\.(jsx?|css)$/.test(file)) return null;
      if (!file.includes('/src/') && !file.includes('\\src\\')) return null;
      const out = applyTokens(code);
      return out === code ? null : { code: out, map: null };
    },
    transformIndexHtml(html) {
      // favicon.ico is binary and cannot be token-swapped, so it is dropped
      // from the output. Remove the <link> to it as well: the SPA catch-all
      // would otherwise answer /favicon.ico with index.html, and the browser
      // spends a request discovering that HTML is not an icon. The SVG icon
      // link that follows is the real one.
      return applyTokens(html).replace(
        /\s*<link rel="icon" type="image\/x-icon"[^>]*>/,
        '',
      );
    },
    // public/ is copied verbatim by Vite, so the real brand assets and the
    // real manifest land in the output untouched by the transforms above.
    // Rewrite the manifest and drop the binaries once the copy has happened.
    closeBundle() {
      const dist = path.resolve('dist');
      if (!fs.existsSync(dist)) return;

      const manifest = path.join(dist, 'manifest.webmanifest');
      if (fs.existsSync(manifest)) {
        const m = JSON.parse(applyTokens(fs.readFileSync(manifest, 'utf8')));
        // Every icon becomes the demo SVG — the PNG it used to point at is
        // about to be deleted, and a manifest referencing a missing icon makes
        // the browser refuse to install the app at all.
        m.icons = [{ src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }];
        fs.writeFileSync(manifest, JSON.stringify(m, null, 2));
      }

      fs.writeFileSync(path.join(dist, 'logo.svg'), DEMO_LOGO_SVG);
      // favicon.ico is binary and cannot be swapped the same way. Removing it
      // is fine: index.html declares the SVG icon too, and browsers that fall
      // back to /favicon.ico simply get a 404 and show their default.
      for (const f of ['Logo.png', 'favicon.ico']) {
        const p = path.join(dist, f);
        if (fs.existsSync(p)) fs.rmSync(p);
      }

      // sw.js ships from public/ and may name the app in its cache keys or
      // notification text; run it through the same swap.
      const sw = path.join(dist, 'sw.js');
      if (fs.existsSync(sw)) fs.writeFileSync(sw, applyTokens(fs.readFileSync(sw, 'utf8')));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite does not put .env values on process.env, so read them explicitly.
  const env = loadEnv(mode, process.cwd(), '');
  const isDemo = env.VITE_DEMO_MODE === 'true';

  return {
    plugins: [react(), demoBranding(isDemo)].filter(Boolean),
    server: {
      port: 3000,
      open: true,
    },
    build: {
      rollupOptions: {
        output: {
          // Split the STABLE framework libraries into their own cached chunks so a
          // routine app-code deploy doesn't bust their content hash and force
          // returning staff to re-download React/Router/Query/Supabase every time.
          // IMPORTANT: only the framework libs are named here — everything else
          // (recharts, xlsx, jspdf, pdfjs, docx, …) is left to Rollup's default
          // splitting so the existing dynamic-import()/lazy chunks stay intact.
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('@supabase')) return 'supabase';
            if (id.includes('@tanstack')) return 'react-vendor';
            if (id.includes('node_modules/react-router')) return 'react-vendor';
            if (id.includes('node_modules/react-dom')) return 'react-vendor';
            if (id.includes('node_modules/react/')) return 'react-vendor';
            if (id.includes('node_modules/scheduler')) return 'react-vendor';
            // everything else falls through to default chunking
          },
        },
      },
    },
  };
});
