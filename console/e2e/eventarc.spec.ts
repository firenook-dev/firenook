import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { ownerFetch } from './support/api'

// Eventarc's journeys (compute spec §9.3, 34–37) against the `compute`
// profile's engine: the greeter extension publishes `test.greeter.v1.greeted`
// on its channel through the Admin SDK, and the shared codebase's `onGreeted`
// and `onGreetedVip` (the latter filtered to `greetings/vip-1`) listen for
// it. Each journey makes its own events, named so no other journey's match.
// Never a mocked API.

/** The greeter's HTTP function, as an app calls it; it publishes one event. */
async function greet(engine: Engine, name: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${engine.ports.functions}/${engine.project}/us-central1/ext-greeter-greet?name=${encodeURIComponent(name)}`,
  )
  expect(response.status).toBe(200)
  await response.arrayBuffer()
}

const channelOf = (engine: Engine) =>
  `projects/${engine.project}/locations/us-central1/channels/firebase`

/** A name no other journey's events carry. */
const unique = (stem: string) => `${stem}-${Date.now().toString(36)}`

/** The feed's row for the event with this subject. */
const rowWithSubject = (page: Page, subject: string) =>
  page.getByTestId('event-cells').filter({ hasText: subject })

test('an extension’s event reaches its handler live, with the trace of who got it and who did not', async ({
  page,
  engine,
}) => {
  const name = unique('ada')
  await page.goto(`${engine.origin}/console/eventarc`)
  await expect(page.getByTestId('events-toolbar')).toBeVisible()
  await greet(engine, name)
  const row = rowWithSubject(page, `greetings/${name}`)
  // Live: no reload, and its deliveries settle in place.
  await expect(row).toBeVisible()
  await expect(row.getByTestId('event-type')).toHaveText('test.greeter.v1.greeted')
  await expect(row).toContainText('greeter (extension)')
  await expect(row.getByTestId('event-deliveries')).toHaveText('1 delivered · 1 filtered out')

  await row.click()
  await expect(page).toHaveURL(/event=/)
  const detail = page.getByTestId('event-detail')
  await expect(detail.getByTestId('event-origin')).toContainText('from greeter')
  const delivered = detail.locator(
    '[data-testid="delivery"][data-function="us-central1-onGreeted"]',
  )
  await expect(delivered.getByTestId('delivery-outcome')).toContainText('Succeeded')
  await expect(delivered.getByTestId('delivery-invocation')).toContainText('#')
  // The invocation opens in Functions once that section is built; until then it is plain text.
  const invocationLink = delivered.getByTestId('delivery-invocation-link')
  if ((await invocationLink.count()) > 0) {
    await invocationLink.click()
    await expect(page).toHaveURL(/\/functions\/invocations\?invocation=/)
    await page.goBack()
  }
  const filtered = detail.locator(
    '[data-testid="delivery"][data-function="us-central1-onGreetedVip"]',
  )
  await expect(filtered.getByTestId('delivery-filtered')).toContainText('Filtered out')
  await expect(filtered.getByTestId('delivery-filtered')).toContainText(
    `subject is greetings/${name}, the trigger wants greetings/vip-1`,
  )
  await expect(detail.getByTestId('event-attribute-subject')).toContainText(`greetings/${name}`)
  await expect(detail.getByTestId('event-data')).toContainText(name)
})

test('publish a typo, see it unheard with the type it meant, then edit, fix and deliver it', async ({
  page,
  engine,
}) => {
  const subject = unique('greetings/typo')
  await page.goto(`${engine.origin}/console/eventarc`)
  await expect(page.getByTestId('events-toolbar')).toBeVisible()
  await page.keyboard.press('n')
  const drawer = page.getByTestId('publish-drawer')
  await expect(drawer).toBeVisible()
  await expect(page).toHaveURL(/new=event/)
  // One brand-filled action on screen: the drawer's Publish, not the toolbar's.
  await expect(page.getByTestId('events-publish')).not.toHaveAttribute('data-primary')
  await expect(page.getByTestId('publish-channel-input')).toHaveValue(channelOf(engine))
  await page.getByTestId('publish-type-input').fill('test.greeter.v1.greetd')
  await page.getByTestId('publish-subject-input').fill(subject)
  await expect(page.getByTestId('publish-preview-nobody')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')

  // Published, and open: nobody listens, and the near miss is named.
  const detail = page.getByTestId('event-detail')
  await expect(detail.getByTestId('deliveries-unheard')).toContainText(
    'No trigger listens for test.greeter.v1.greetd on this channel.',
  )
  await expect(detail.getByTestId('near-miss')).toHaveText('test.greeter.v1.greeted')
  await expect(rowWithSubject(page, subject).getByTestId('event-deliveries')).toHaveText('Unheard')

  // Edit and publish (Shift+R): the drawer filled from the event.
  await page.locator('body').click({ position: { x: 700, y: 600 } })
  await page.keyboard.press('Shift+R')
  await expect(drawer).toBeVisible()
  await expect(page.getByTestId('publish-type-input')).toHaveValue('test.greeter.v1.greetd')
  await expect(page.getByTestId('publish-subject-input')).toHaveValue(subject)
  await page.getByTestId('publish-type-input').fill('test.greeter.v1.greeted')
  await page.getByTestId('publish-subject-input').fill('greetings/vip-1')
  // The engine's matcher agrees before anything is sent: both would get it.
  const preview = page.getByTestId('publish-preview-row')
  await expect(preview).toHaveCount(2)
  await expect(page.locator('[data-testid="publish-preview-row"][data-fires]')).toHaveCount(2)
  // Change the subject and the filtered handler drops out of the preview.
  await page.getByTestId('publish-subject-input').fill('greetings/someone')
  await expect(page.locator('[data-testid="publish-preview-row"][data-fires]')).toHaveCount(1)
  await expect(
    page.locator('[data-testid="publish-preview-row"][data-function="us-central1-onGreetedVip"]'),
  ).toContainText('subject is greetings/someone, it wants greetings/vip-1')
  await page.getByTestId('publish-subject-input').fill('greetings/vip-1')
  await expect(page.locator('[data-testid="publish-preview-row"][data-fires]')).toHaveCount(2)
  await page.getByTestId('publish-send').click()
  await expect(
    detail.locator('[data-testid="delivery"] [data-testid="delivery-outcome"]'),
  ).toHaveCount(2)
  await expect(detail.getByTestId('delivery-filtered')).toHaveCount(0)

  // `e`: failed deliveries only, written into the filter.
  await page.locator('body').click({ position: { x: 700, y: 600 } })
  await page.keyboard.press('e')
  await expect(page).toHaveURL(/q=delivery%3Afailed/)
  await expect(page.getByTestId('events-filter')).toContainText('delivery:failed')
})

test('replay publishes an event again with a new id, behind a confirmation from the keyboard', async ({
  page,
  engine,
}) => {
  const name = unique('grace')
  await greet(engine, name)
  await page.goto(
    `${engine.origin}/console/eventarc?q=${encodeURIComponent(`subject:greetings/${name}`)}`,
  )
  const rows = page.getByTestId('event-cells')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  await page.locator('body').click({ position: { x: 700, y: 600 } })
  await page.keyboard.press('r')
  const confirm = page.getByTestId('event-replay-confirm')
  await expect(confirm).toContainText('again with a new id')
  await page.getByTestId('event-replay-confirm-confirm').click()
  await expect(confirm).toBeHidden()
  // The filter keeps both: the original and its replay, which links back to it.
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('event-replay-of')).toBeVisible()
  const events = (await (
    await ownerFetch(
      engine,
      `/eventarc/events?q=${encodeURIComponent(`subject:greetings/${name}`)}`,
    )
  ).json()) as { page: { items: { eventId: string; origin: string }[] } }
  const [replayed, first] = events.page.items
  expect(replayed?.origin).toBe('replay')
  expect(replayed?.eventId).not.toBe(first?.eventId)
})

test('channels show who publishes what to whom, and what does not line up', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/eventarc/channels`)
  const channel = page.locator(`[data-testid="channel-flow"][data-channel="${channelOf(engine)}"]`)
  await expect(channel).toBeVisible()
  const publisher = channel.locator('[data-testid="channel-publisher"][data-instance="greeter"]')
  await expect(publisher.locator('[data-type="test.greeter.v1.greeted"]')).toHaveAttribute(
    'data-allowed',
    '',
  )
  await expect(publisher.locator('[data-type="test.greeter.v1.failed"]')).toContainText(
    'declared, not allowed',
  )
  await expect(
    channel.locator('[data-testid="channel-subscriber"][data-function="us-central1-onGreeted"]'),
  ).toContainText('test.greeter.v1.greeted')
  await expect(
    channel.locator('[data-testid="channel-subscriber"][data-function="us-central1-onGreetedVip"]'),
  ).toContainText('subject=greetings/vip-1')
  await expect(
    channel.locator('[data-testid="channel-warning"][data-kind="not-allowed"]'),
  ).toHaveText(
    'test.greeter.v1.failed is declared by greeter but not allowed, so it is never published.',
  )
  // The publisher is a link into Extensions.
  await publisher.getByTestId('channel-publisher-link-link').click()
  await expect(page).toHaveURL(/\/console\/extensions\?instance=greeter/)
})

test('without alert delivery there is no Alerts page', async ({ page, engine }) => {
  const snapshot = (await (await ownerFetch(engine, '/eventarc/channels')).json()) as {
    alertsDelivered: boolean
  }
  expect(snapshot.alertsDelivered).toBe(false)
  await page.goto(`${engine.origin}/console/eventarc`)
  await expect(page.getByTestId('nav-page-events')).toBeVisible()
  await expect(page.getByTestId('nav-page-channels')).toBeVisible()
  await expect(page.locator('[data-testid^="nav-page-alerts"]')).toHaveCount(0)
  const response = await page.goto(`${engine.origin}/console/eventarc/alerts`)
  expect(response?.ok()).toBe(true)
  await expect(page.getByText('Nothing at this address')).toBeVisible()
})
