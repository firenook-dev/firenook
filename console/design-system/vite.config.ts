import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The design-system preview app: one page that renders a single card of the
// Firenook component library (real Kumo components under the Firenook theme)
// for the capture script in ../scripts/design-system/build.mjs.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  server: { port: 5174 },
  build: {
    target: 'es2023',
    outDir: fileURLToPath(new URL('../.design-system/site', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
})
