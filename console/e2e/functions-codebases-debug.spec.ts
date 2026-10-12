import { expect, test } from './fixtures'
import { readClipboard } from './support/clipboard'
import { codebaseOf } from './support/compute'
import { statusOf } from './support/shell'

// The debug port (compute spec §9.3, 27), on an engine of its own started
// with --inspect-functions: the codebase view says the port and copies the
// address chrome://inspect takes. No mocked API.

test.use({ engineOptions: { args: ['--inspect-functions'] } })

test('the debug chip says the inspector port and copies its chrome://inspect address', async ({
  page,
  engine,
}) => {
  const codebase = await codebaseOf(engine, 'default')
  expect(codebase.worker.inspectPort).not.toBeNull()
  const port = codebase.worker.inspectPort!
  const functions = (await statusOf(engine)).services.find(
    (service) => service.name === 'functions',
  )
  await page.goto(`${engine.origin}/console/functions?codebase=default`)
  const chip = page.getByTestId('codebase-debug')
  await expect(chip).toContainText(`Debug ${port}`)
  await chip.click()
  await page.getByTestId('codebase-debug-copy').click()
  await expect.poll(() => readClipboard(page)).toBe(`${functions!.host}:${port}`)
})
