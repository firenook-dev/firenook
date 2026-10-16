import { expect, test } from './fixtures'
import { functionId, finishedInvocation } from './support/compute'

// A function whose service is not running (compute spec §9.3, 26), on an
// engine of its own without Storage and Pub/Sub: the page says which
// section it needs and how to start it, Run now still runs a schedule
// directly, and a Pub/Sub function can still be sent an event. (Auth runs:
// the shared Firestore seeder creates the seed people there.) No mocked API.

test.use({ engineOptions: { only: 'functions,firestore,auth' } })

test('a function whose service is not running says what it needs, and still runs here', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/functions?function=${functionId('onUpload')}`)
  const storage = page.getByTestId('function-requires')
  await expect(storage).toBeVisible()
  await expect(storage).toContainText('Storage')
  await expect(page.getByTestId('problem-no-service')).toBeVisible()

  // A schedule: Pub/Sub would run it on time; Run now calls it directly.
  await page.goto(`${engine.origin}/console/functions?function=${functionId('nightly')}&tab=run`)
  await expect(page.getByTestId('schedule-requires')).toContainText('Pub/Sub')
  await page.getByTestId('schedule-run').click()
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded')
  const run = await finishedInvocation(
    engine,
    'nightly',
    (invocation) => invocation.origin === 'console',
  )
  expect(run.summary).toBe('scheduled tick')

  // A Pub/Sub function: sending to it alone is the primary; publishing needs Pub/Sub.
  await page.goto(`${engine.origin}/console/functions?function=${functionId('onEmail')}&tab=run`)
  await expect(page.getByTestId('event-for-real-requires')).toContainText('Pub/Sub')
  await expect(page.getByTestId('event-publish')).toHaveCount(0)
  const send = page.getByTestId('event-send')
  await expect(send).toContainText('Send to this function only')
  await page.getByTestId('event-data').fill('{"data": {"to": "ada@example.test"}}')
  await send.click()
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded')
  await expect(page.getByTestId('run-logs')).toContainText('email to ada@example.test')
})
