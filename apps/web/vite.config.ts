import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // During development the Combray server runs on :8080. Keep the Host header: the server only
    // answers its own host names (COMBRAY_PUBLIC_URL), and Vite's string shorthand rewrites it.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
});
