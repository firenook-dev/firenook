// The kit's harness (`e2e/kit-harness/`): built once for the perf journeys
// that measure FeedList and JsonView on a page of their own and the theme's
// contrast journeys, and
// served from that build under the engine's own `/console/`, so the page
// takes the console's fonts from the engine and runs at its origin. Only
// the harness's own files are served this way; nothing of the console API
// is touched, let alone mocked.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

export type { FeedRun, JsonRun, KitHarness, ThemeRun } from '../kit-harness/runs'

/** Where the harness is served, beside the console it borrows fonts from. */
export const KIT_BASE = '/console/__kit/'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

export interface KitBuild {
  directory: string
  remove(): void
}

/**
 * Builds the harness in production mode with the console's own plugins
 * (the React compiler, Tailwind, the icon weights, the `@` alias) into a
 * fresh directory.
 */
export async function buildKitHarness(): Promise<KitBuild> {
  const [{ build }, { default: react }, { default: tailwindcss }, { iconWeights }] =
    await Promise.all([
      import('vite'),
      import('@vitejs/plugin-react'),
      import('@tailwindcss/vite'),
      import('../../scripts/icon-weights.mjs'),
    ])
  const directory = mkdtempSync(join(tmpdir(), 'firenook-kit-'))
  await build({
    configFile: false,
    root: fileURLToPath(new URL('../kit-harness/', import.meta.url)),
    base: KIT_BASE,
    publicDir: false,
    // Its stylesheet names the console's fonts by the URL the engine serves
    // them at, which a build of this folder cannot resolve and need not.
    logLevel: 'error',
    mode: 'production',
    plugins: [react({ compiler: true }), tailwindcss(), iconWeights()],
    resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
    build: { target: 'es2023', outDir: directory, emptyOutDir: true, sourcemap: false },
  })
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) }
}

/** Opens a view of the harness (`feed`, `json`, `theme`) at the engine's origin and waits for it. */
export async function openKitHarness(
  page: Page,
  origin: string,
  kit: KitBuild,
  view: 'feed' | 'json' | 'theme',
  mode: 'light' | 'dark' = 'light',
): Promise<void> {
  const root = resolve(kit.directory)
  await page.route(`${origin}${KIT_BASE}**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(KIT_BASE.length)
    const file = resolve(root, path === '' ? 'index.html' : decodeURIComponent(path))
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    await route.fulfill({
      body: readFileSync(file),
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
    })
  })
  await page.goto(`${origin}${KIT_BASE}?view=${view}&mode=${mode}`)
  await page.waitForFunction(
    () => (globalThis as unknown as { __kit?: { ready: boolean } }).__kit?.ready === true,
  )
}
