import { dedicated, expect } from './fixtures'
import { pasteRules, putFile, upload } from './support/storage'

// The two other shapes `firebase.json` can give Storage's rules, each in an
// engine of its own (one at a time on the host): one rules file for every
// bucket, and no storage section at all in a demo project, where the
// emulator serves its open default rules.

dedicated.use({ workerEngine: false })

const SINGLE = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /shared/{file} {',
  '      allow read, write: if request.auth != null;',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

dedicated(
  'one rules file governs every bucket, and an Apply changes the verdict in each',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('storage', {
      only: 'storage,auth',
      seed: false,
      project: 'demo-console-storage-single',
      fixtureEnv: { STORAGE_RULES_MODE: 'single' },
    })
    const buckets = [`${engine.project}.appspot.com`, `${engine.project}-media`]
    // A bucket exists by being written to.
    await putFile(engine, {
      bucket: buckets[1] ?? '',
      name: 'banners/a.png',
      size: 64,
      contentType: 'image/png',
    })

    await page.goto(`${engine.origin}/console/storage/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('service firebase.storage')
    const chip = page.getByTestId('rules-all-buckets')
    await expect(chip).toContainText('All buckets')
    await expect(chip).toContainText('2 buckets')
    await expect(page.getByTestId('rules-bucket')).toHaveCount(0)
    await chip.hover()
    for (const bucket of buckets) await expect(page.getByText(`gs://${bucket}`)).toBeVisible()

    // An anonymous upload to either bucket: refused, then allowed by one Apply.
    const anonymous = (bucket: string) =>
      upload(engine, { bucket, name: 'shared/x.txt', size: 8, contentType: 'text/plain' })
    for (const bucket of buckets) expect((await anonymous(bucket)).status).toBe(403)
    await pasteRules(page, SINGLE.replace('if request.auth != null', 'if true'))
    await page.getByTestId('rules-apply').hover()
    await expect(page.getByText('In force for every bucket from the next request')).toBeVisible()
    await page.getByTestId('rules-apply').click()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
    for (const bucket of buckets)
      await expect.poll(async () => (await anonymous(bucket)).status).toBe(200)
  },
)

dedicated(
  'a demo project without a storage section says its rules are open, and has no file to save',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('storage', {
      only: 'storage,auth',
      seed: false,
      project: 'demo-console-storage-open',
      fixtureEnv: { STORAGE_RULES_MODE: 'none' },
    })
    await page.goto(`${engine.origin}/console/storage/rules`)
    const banner = page.getByTestId('rules-open-default')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('anyone can read and write every file')
    await expect(banner).toContainText('"storage": { "rules": "storage.rules" }')
    await expect(page.getByTestId('rules-source')).toContainText('allow read, write;')
    await expect(page.getByTestId('rules-save')).toBeDisabled()
    await expect(page.getByTestId('rules-toolbar')).toContainText('Open default rules')
  },
)

dedicated(
  'an engine that records no decisions says so where they would be',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('storage', {
      only: 'storage,auth',
      seed: false,
      project: 'demo-console-storage-quiet',
      args: ['--no-diagnostics'],
    })
    await page.goto(`${engine.origin}/console/storage/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('service firebase.storage')
    await expect(page.getByTestId('decisions-empty')).toHaveText(
      'Rules decisions are off: the suite was started with --no-diagnostics.',
    )
    // Coverage counts nothing either, and the toggle says so rather than failing.
    await expect(page.getByTestId('rules-coverage')).toBeVisible()
    await expect(page.getByTestId('query-error')).toHaveCount(0)
  },
)
