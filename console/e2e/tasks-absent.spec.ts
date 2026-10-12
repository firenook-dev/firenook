// J-TK-12 (messaging spec §9.3): an engine without Functions has no Cloud
// Tasks and no Pub/Sub; both pages say why and how to turn them on. It
// starts an engine of its own (the `data` profile, Firestore and Auth), so
// its file holds no worker engine: one engine at a time on the host.

import { dedicated, expect } from './fixtures'

dedicated.use({ workerEngine: false })

dedicated(
  'J-TK-12 Cloud Tasks and Pub/Sub say they are not running, with the fix',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('data')
    await page.goto(`${engine.origin}/console/tasks`)
    const absent = page.getByTestId('service-not-running')
    await expect(absent).toBeVisible()
    await expect(page.getByText('Cloud Tasks is not running')).toBeVisible()
    await expect(page.getByTestId('section-fixes')).toBeVisible()
    await expect(page.getByTestId('tasks-page')).toHaveCount(0)

    await page.goto(`${engine.origin}/console/pubsub`)
    await expect(page.getByTestId('service-not-running')).toBeVisible()
    await expect(page.getByText('Pub/Sub is not running')).toBeVisible()
    await expect(page.getByTestId('section-fixes')).toBeVisible()
  },
)
