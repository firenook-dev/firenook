import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The code under test is compiled the way the build compiles it: the React
  // compiler memoizes what a component reads while it renders, and a test of
  // the uncompiled source cannot see a read it would keep too long (a
  // mutable store's figures, cached by the store's identity).
  plugins: [react({ compiler: true })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
})
