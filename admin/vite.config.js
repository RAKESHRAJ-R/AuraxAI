import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin console is served by the Express server under the /admin/ path
// (express.static on admin/dist), so the build must use that base. In dev,
// `npm run dev` proxies /api and /invoices to the running bot on port 3000.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
      '/invoices': 'http://localhost:3000',
    },
  },
});
