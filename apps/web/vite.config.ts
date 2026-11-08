import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the browser talks to Vite (5173) and Vite proxies /api to the API (8787), so the app is
// always same-origin and no URL is hard-coded in components. Prod: the API serves dist/ itself.
const api = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: false } } },
  preview: { port: 4173, proxy: { '/api': { target: api, changeOrigin: false } } },
  build: { outDir: '../../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 }
})
