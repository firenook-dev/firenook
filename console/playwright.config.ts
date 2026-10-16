import { defineConfig, devices } from '@playwright/test'
import type { EngineProfile } from './e2e/fixtures'

// The end-to-end suite runs against real engines, never a mocked API: each
// project starts one per worker with its profile (`e2e/fixtures.ts`,
// `scripts/profiles/`). A spec file's name is its project, every pattern
// anchored at a path separator and the end, so `storage-rules.spec.ts`
// belongs to `storage` alone. FIRENOOK_BINARY points at the engine to test.

const project = (name: string, testMatch: RegExp, profile: EngineProfile) => ({
  name,
  testMatch,
  use: { ...devices['Desktop Chrome'], profile },
})

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Engines are per worker, so CI may pass --workers=2.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The console copies things people paste elsewhere — an index entry, a
    // query as code — so a journey has to be able to read back what it put
    // on the clipboard.
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    project('data', /[\\/](console(-gate)?|firestore|rules)\.spec\.ts$/, 'data'),
    project('auth', /[\\/]auth(-[\w-]+)?\.spec\.ts$/, 'auth'),
    project('storage', /[\\/]storage(-[\w-]+)?\.spec\.ts$/, 'storage'),
    project('compute', /[\\/](functions|extensions|eventarc)(-[\w-]+)?\.spec\.ts$/, 'compute'),
    project('messaging', /[\\/](pubsub|tasks)(-[\w-]+)?\.spec\.ts$/, 'messaging'),
    project('observe', /[\\/](logs|overview)(-[\w-]+)?\.spec\.ts$/, 'observe'),
    project('shell', /[\\/]shell(-[\w-]+)?\.spec\.ts$/, 'all'),
  ],
})
