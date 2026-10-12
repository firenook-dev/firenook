import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The sections as one console (project `shell`, profile `all`, every
// service, fixture and seeder): ⌘K finds what every section holds and opens
// it where that section shows it, and the Overview has a card for every
// section the engine runs, with the figures that section counts and a link
// into it. Each section's own journeys go deep; these check the seams.

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the worker engine did not start')
  return value
}

/** Searches ⌘K from the Overview (no page of its own offers anything) and opens a hit. */
async function openFromPalette(page: Page, text: string, group: string, title: string) {
  await page.goto(`${origin()}/console`)
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByTestId('palette-input')
  await expect(input).toBeVisible()
  await input.fill(text)
  // The engine's hits arrive under the label of what they are.
  const section = page.getByRole('group', { name: group })
  const hit = section.getByRole('option', { name: new RegExp(`^${title}`) }).first()
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(input).toBeHidden()
}

test('⌘K finds what every section holds, and opens it where that section shows it', async ({
  page,
}) => {
  await openFromPalette(page, 'users', 'Collections', 'users')
  await expect(page).toHaveURL(/\/console\/firestore\?.*path=users/)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()

  await openFromPalette(page, 'ada@example', 'Users', 'ada@example.test')
  await expect(page).toHaveURL(/\/console\/auth\?.*user=u_k65eq/)
  await expect(page.getByTestId('user-inspector')).toContainText('ada@example.test')

  await openFromPalette(page, 'q3.pdf', 'Objects', 'reports/q3.pdf')
  await expect(page).toHaveURL(/\/console\/storage\?/)
  await expect(page.getByTestId('file-inspector')).toContainText('q3.pdf')

  await openFromPalette(page, 'onOrderCreated', 'Functions', 'onOrderCreated')
  await expect(page).toHaveURL(/\/console\/functions\?.*function=us-central1-onOrderCreated/)
  await expect(page.getByTestId('function-name')).toHaveText('onOrderCreated')

  await openFromPalette(page, 'greeter', 'Extensions', 'Greeter')
  await expect(page).toHaveURL(/\/console\/extensions\?.*instance=greeter/)
  await expect(page.getByTestId('instance-view')).toBeVisible()

  await openFromPalette(page, 'audit-log', 'Topics', 'audit-log')
  await expect(page).toHaveURL(/\/console\/pubsub\?.*topic=audit-log/)
  await expect(
    page.locator('[data-testid="panel-tree-node"][aria-current="location"]'),
  ).toContainText('audit-log')

  await openFromPalette(page, 'sendEmail', 'Task queues', 'sendEmail')
  await expect(page).toHaveURL(/\/console\/tasks\?.*queue=sendEmail/)
  await expect(page.getByTestId('queue-field-id')).toHaveText('sendEmail')
})

test('the Overview has a card for every running section, with its figures and a way in', async ({
  page,
}) => {
  await page.goto(`${origin()}/console`)
  const cards = page.getByTestId('overview-cards')
  await expect(cards).toBeVisible()
  const running = ['firestore', 'auth', 'storage', 'functions', 'extensions', 'pubsub', 'tasks']
  for (const id of running) {
    const card = cards.getByTestId(`overview-card-${id}`)
    await expect(card, id).toBeVisible()
    await expect(card).toHaveAttribute('data-state', 'ready')
    // What the section counts, from the engine's own summary.
    await expect(card.getByTestId(`overview-card-${id}-figures`), id).toBeVisible()
    // The title leads into the section.
    await expect(card.getByRole('link').first()).toHaveAttribute(
      'href',
      new RegExp(`^/console/${id}$`),
    )
  }
  // And it goes there.
  await cards.getByTestId('overview-card-pubsub').getByRole('link').first().click()
  await expect(page).toHaveURL(/\/console\/pubsub$/)
})
