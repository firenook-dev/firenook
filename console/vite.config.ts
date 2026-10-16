import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { type Plugin, defineConfig } from 'vite'
import { iconWeights } from './scripts/icon-weights.mjs'

/**
 * A gzip copy beside every script, stylesheet and SVG over 1 KB, which the
 * engine serves to a browser that accepts it (`serve` in console-front).
 * Over loopback the cost of 1.6 MB of uncompressed assets is parse time;
 * through `--allowed-hosts`, a tunnel or a container it is a transfer.
 * Compressed once here, at the highest level, rather than on each request.
 */
function precompress(): Plugin {
  return {
    name: 'firenook-precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir
      if (!dir) return
      for (const file of Object.keys(bundle)) {
        if (!/\.(?:js|css|svg)$/.test(file)) continue
        const path = join(dir, file)
        const data = readFileSync(path)
        if (data.length < 1024) continue
        writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }))
      }
    },
  }
}

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
    iconWeights(),
    precompress(),
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
