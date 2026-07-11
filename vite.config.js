import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
});
