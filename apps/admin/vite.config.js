import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The console has two deploy targets and they need different `base` values:
//
//   Vercel (primary)   → served at the domain root      → base '/',       outDir 'dist'
//   Express (fallback) → served under /admin on the bot → base '/admin/', outDir 'dist-express'
//
// `npm run build:express` selects the second via `vite build --mode express` — a built-in
// flag, so no cross-env dependency is needed to set it on Windows. Everything else
// (dev server, `npm run build`, Vercel) gets the root build. src/main.jsx reads the chosen
// value back via import.meta.env.BASE_URL for the router basename, so the two stay in sync.
export default defineConfig(({ mode }) => {
  const expressTarget = mode === 'express';

  // In dev, VITE_API_BASE_URL is normally left empty so the proxy below handles /api.
  // Set VITE_DEV_API_PROXY to develop the UI against a bot running somewhere else.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const devApiTarget = env.VITE_DEV_API_PROXY || 'http://localhost:3000';

  return {
    base: expressTarget ? '/admin/' : '/',
    plugins: [react()],
    build: {
      outDir: expressTarget ? 'dist-express' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      port: 5174,
      proxy: {
        '/api': devApiTarget,
        '/invoices': devApiTarget,
      },
    },
  };
});
