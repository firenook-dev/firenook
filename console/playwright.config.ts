import { defineConfig, devices } from '@playwright/test'

// The end-to-end suite runs against a real engine started by e2e/engine.ts,
// never against a mocked API. FIRENOOK_BINARY points at the engine to test.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/engine.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The console copies things people paste elsewhere — an index entry, a
    // query as code — so a journey has to be able to read back what it put
    // on the clipboard.
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
