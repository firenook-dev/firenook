import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The console is served by the engine under /console on the Emulator UI port.
// In development Vite serves the app itself and proxies the console API and
// its live channel to a running engine; set FIRENOOK_UI_ORIGIN to point at it.
const engine = process.env.FIRENOOK_UI_ORIGIN ?? 'http://127.0.0.1:4000'

export default defineConfig({
  base: '/console/',
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/console/api': { target: engine, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2023',
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    // Hashed asset names let the engine serve them as immutable.
    assetsDir: 'assets',
  },
})
