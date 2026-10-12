// Pub/Sub's Topics page against a real engine (project `messaging`): the
// seeded topics and the fixture's functions are read, never changed; every
// journey that changes something makes its own topic or subscription
// (`j-<id>-<random>`) and deletes it in `finally`.

import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { dropLive, restoreLive } from './support/live'
import { cutRings, paintOf } from './support/look'
import {
  type SubscriptionDetailView,
  type TopicIndexView,
  OTHER_PROJECT,
  consoleCall,
  createSubscription,
  createTopic,
  deleteTopic,
  portUrl,
  publishOverPort,
  subscriptionName,
  topicName,
  uniqueId,
} from './support/messaging'

const enc = encodeURIComponent

// The section shows to a browser that asks for a preview until every one of
// its pages is built; these journeys are that browser.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('firenook.console.preview', 'pubsub'))
})

/** The Topics page at `search` (`topic=orders&view=settings`). */
async function openTopics(page: Page, origin: string, search = '') {
  await page.goto(`${origin}/console/pubsub${search ? `?${search}` : ''}`)
  await expect(page.getByTestId('pubsub-page')).toBeVisible()
}

/** A tree row by its label. */
const treeRow = (page: Page, label: string) =>
  page.getByTestId('pubsub-tree').getByRole('treeitem', { name: label, exact: true })

/** Opens a tree row's children. */
async function expand(page: Page, label: string) {
  const row = treeRow(page, label)
  if ((await row.getAttribute('aria-expanded')) !== 'true')
    await row.getByTestId('panel-tree-toggle').click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
}

test('J-PS-01 topics at a glance: the tree, its figures, and the groups', async ({
  page,
  engine,
}) => {
  await openTopics(page, engine.origin)
  const index = await consoleCall<TopicIndexView>(engine, 'GET', '/pubsub/topics')
  const behind = (id: string) => {
    const topic = index.items.find((item) => item.id === id)
    const backlogs = (topic?.subscriptions ?? [])
      .filter((subscription) => subscription.managed !== 'functions')
      .map((subscription) => subscription.counters.backlog)
    return backlogs.length === 0 ? undefined : Math.max(...backlogs)
  }
  for (const id of ['orders', 'payments', 'audit-log', 'orders-dead'])
    await expect(treeRow(page, id)).toBeVisible()

  // A topic's figure is its most-behind subscription's backlog, never a sum.
  await expect(treeRow(page, 'orders')).toContainText(String(behind('orders')))
  await expect(treeRow(page, 'payments')).toContainText(String(behind('payments')))
  // No subscription of its own, no figure.
  await expect(treeRow(page, 'audit-log')).toHaveText('audit-log')

  await expand(page, 'orders')
  for (const id of ['orders-worker', 'orders-filtered', 'onOrderPlaced'])
    await expect(treeRow(page, id)).toBeVisible()
  // The functions' own subscription folds into its function's row.
  await expect(treeRow(page, 'emulator-sub-orders')).toHaveCount(0)

  await expand(page, 'Function schedules')
  await expect(treeRow(page, 'firebase-schedule-nightlyCleanup')).toBeVisible()
  await expect(treeRow(page, 'firebase-schedule-weeklyDigest')).toBeVisible()

  // The other project is data in the tree; the warning is the shell's banner.
  await expect(treeRow(page, OTHER_PROJECT)).toBeVisible()
  await expect(page.getByTestId('banner-foreign-project')).toContainText(OTHER_PROJECT)
  await expect(page.getByTestId('pubsub-body')).not.toContainText(OTHER_PROJECT)

  // The landing's cards: the busiest topic first, with the function it triggers.
  const card = page
    .getByTestId('pubsub-topic-card')
    .filter({ hasText: /^orders/ })
    .first()
  await expect(card).toContainText(`${behind('orders')} behind`)
  await expect(card).toContainText('onOrderPlaced')
  await card.getByRole('button', { name: 'Open orders' }).click()
  await expect(page).toHaveURL(/topic=orders/)
  await expect(page.getByTestId('pubsub-message-table')).toBeVisible()
})

test('J-PS-02 a topic is created with its subscription, and deleted with it', async ({
  page,
  engine,
}) => {
  const id = uniqueId('ps02')
  try {
    await openTopics(page, engine.origin)
    await page.keyboard.press('n')
    const dialog = page.getByTestId('create-topic')
    await expect(dialog).toBeVisible()
    await page.getByTestId('create-topic-id').fill('x')
    await expect(page.getByTestId('create-topic-id-error')).toHaveText(
      'An id has at least 3 characters.',
    )
    await page.getByTestId('create-topic-id').fill(id)
    await expect(page.getByTestId('create-topic-name')).toHaveText(topicName(engine, id))
    await page.getByTestId('create-topic-submit').click()
    await expect(dialog).toBeHidden()

    // Both appear without a reload: the counters topic says the topics changed.
    await expect(page).toHaveURL(new RegExp(`topic=${id}`))
    await expand(page, id)
    await expect(treeRow(page, `${id}-sub`)).toBeVisible()

    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByTestId('topic-delete').click()
    const confirm = page.getByTestId('topic-delete-confirm')
    await expect(confirm).toContainText(`${id}-sub`)
    await confirm.getByRole('checkbox').check()
    await page.getByTestId('topic-delete-confirm-confirm').click()
    await expect(confirm).toBeHidden()
    await expect(treeRow(page, id)).toHaveCount(0)
    await expect(treeRow(page, `${id}-sub`)).toHaveCount(0)
    const index = await consoleCall<TopicIndexView>(engine, 'GET', '/pubsub/topics')
    expect(index.detached.map((subscription) => subscription.id)).not.toContain(`${id}-sub`)
  } finally {
    await deleteTopic(engine, id)
  }
})

test('J-PS-12 a subscription filter says where it fails, and what it passes', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps12')
  const subscription = `${topic}-eu`
  try {
    await createTopic(engine, topic)
    await publishOverPort(engine, topic, [
      { data: { n: 1 }, attributes: { region: 'eu' } },
      { data: { n: 2 }, attributes: { region: 'us' } },
    ])
    await openTopics(page, engine.origin, `topic=${topic}&new=subscription`)
    await page.getByTestId('create-subscription-id').fill(subscription)
    const filter = page.getByTestId('create-subscription-filter-input')
    await filter.fill('attributes.region = ')
    await expect(page.getByTestId('attributes-filter-check')).toContainText(/, at \d+/)
    await expect(page.getByTestId('create-subscription-filter')).toHaveAttribute('data-invalid', '')
    await filter.fill('attributes.region = "eu"')
    await expect(page.getByTestId('attributes-filter-check')).toHaveText(
      'Valid · passes 1 of the last 2 messages',
    )
    await page.getByTestId('create-subscription-submit').click()
    await expect(page).toHaveURL(new RegExp(`subscription=${subscription}`))

    // Published after it exists: only the eu one is tracked there.
    const [eu, us] = (
      await publishOverPort(engine, topic, [
        { data: { n: 3 }, attributes: { region: 'eu' } },
        { data: { n: 4 }, attributes: { region: 'us' } },
      ])
    ).messageIds
    await openTopics(page, engine.origin, `topic=${topic}`)
    const row = (id: string | undefined) =>
      page.getByTestId('pubsub-message-table').locator(`tr[data-key="${id}"]`)
    await expect(row(us).locator('[data-state="filtered"]')).toBeVisible()
    await expect(row(eu).locator('[data-state="available"]')).toBeVisible()
    await row(us).getByTestId('delivery-marks').hover()
    await expect(page.locator('.kumo-tooltip-popup')).toContainText(`${subscription}: filtered out`)

    // The same text in the message list's expression field: the same matches.
    await page.getByTestId('pubsub-expr-open').click()
    await page.getByTestId('pubsub-expr-input').fill('attributes.region = "eu"')
    await expect(page.getByTestId('pubsub-message-count')).toHaveText('2 messages · of 4 kept')
    await expect(page).toHaveURL(/expr=/)
    await expect(row(eu)).toBeVisible()
    await expect(row(us)).toHaveCount(0)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-14 settings save what can change, and say why the rest cannot', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps14')
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, `${topic}-worker`, topic, { ordering: true })
    await openTopics(
      page,
      engine.origin,
      `topic=${topic}&subscription=${topic}-worker&view=settings`,
    )
    await page.getByTestId('subscription-ack-deadline').fill('30')
    await expect(page.getByTestId('subscription-save')).toBeEnabled()
    await page.getByTestId('subscription-save').click()
    await expect
      .poll(
        async () =>
          (
            await consoleCall<SubscriptionDetailView>(
              engine,
              'GET',
              `/pubsub/subscription?name=${enc(subscriptionName(engine, `${topic}-worker`))}`,
            )
          ).subscription.ackDeadlineSeconds,
      )
      .toBe(30)
    const settings = page.getByTestId('pubsub-subscription-settings')
    await expect(settings).toContainText(
      'Message ordering is fixed when the subscription is created.',
    )
    await expect(settings).toContainText(
      'The emulator cannot change a filter; create a new subscription.',
    )

    // A topic keeping an hour of messages hands them to a subscription created later.
    await openTopics(page, engine.origin, `topic=${topic}&view=settings`)
    await page.getByTestId('topic-retention-switch').click()
    await page.getByTestId('topic-retention-duration-amount').fill('1')
    await page.getByRole('combobox', { name: 'Keep messages for, unit' }).click()
    await page.getByRole('option', { name: 'hours' }).click()
    await page.getByTestId('topic-retention-save').click()
    await expect(page.getByTestId('topic-retention-save')).toBeDisabled()
    await publishOverPort(engine, topic, [{ data: { early: 1 } }, { data: { early: 2 } }])
    await createSubscription(engine, `${topic}-late`, topic)
    const late = await consoleCall<SubscriptionDetailView>(
      engine,
      'GET',
      `/pubsub/subscription?name=${enc(subscriptionName(engine, `${topic}-late`))}`,
    )
    expect(late.subscription.summary.counters.backlog).toBe(2)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-16 the palette finds a subscription and offers this topic’s actions', async ({
  page,
  engine,
}) => {
  await openTopics(page, engine.origin)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('orders-wor')
  await page
    .getByRole('option', { name: /orders-worker/ })
    .first()
    .click()
  await expect(page).toHaveURL(/subscription=orders-worker/)
  await expect(page).toHaveURL(/topic=orders/)
  await expect(page.getByTestId('pubsub-scope')).toContainText('orders-worker')

  await openTopics(page, engine.origin, 'topic=orders')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('new subscription')
  await page.getByRole('option', { name: 'New subscription on orders' }).click()
  await expect(page.getByTestId('create-subscription')).toBeVisible()
})

test('J-PS-17 a dropped channel is said once, and the table catches up after', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps17')
  try {
    await createTopic(engine, topic)
    await publishOverPort(engine, topic, [{ data: { n: 1 } }])
    await openTopics(page, engine.origin, `topic=${topic}`)
    const rows = page.getByTestId('pubsub-message-table').getByTestId('data-row')
    await expect(rows).toHaveCount(1)
    const badge = page.getByTestId('engine-badge')
    await dropLive(page)
    await expect(badge).toHaveText('reconnecting', { timeout: 3_000 })
    // Said by the engine badge, and nowhere on this page.
    await expect(page.getByTestId('pubsub-live')).toHaveCount(0)
    await publishOverPort(engine, topic, [{ data: { n: 2 } }])
    await restoreLive(page)
    await expect(badge).toHaveText(/^engine /, { timeout: 15_000 })
    await expect(rows).toHaveCount(2, { timeout: 10_000 })
  } finally {
    await deleteTopic(engine, topic)
  }
})

/** A box's right edge; Playwright reports position and size, not edges. */
const edge = (box: { x: number; width: number } | null) => (box ? box.x + box.width : Number.NaN)

/** Every rendered run of text under `root`, as `<size> <face>`. */
const scale = (root: Locator) =>
  root.first().evaluate((element) => {
    const found = new Set<string>()
    for (const el of element.querySelectorAll('*')) {
      const own = [...el.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent?.trim() ?? '')
        .join('')
      if (!own) continue
      const style = el.ownerDocument.defaultView!.getComputedStyle(el)
      found.add(`${style.fontSize} ${/mono|plex/i.test(style.fontFamily) ? 'mono' : 'sans'}`)
    }
    return [...found].toSorted()
  })

test('J-PS-19 one type scale, and toolbar groups that never overlap', async ({ page, engine }) => {
  await openTopics(page, engine.origin, 'topic=orders&message=1')
  await expect(page.getByTestId('pubsub-message-inspector')).toBeVisible()
  // A table row: values 12 px mono, the chips' and marks' detail 11 px, the
  // relative time the only sans.
  const row = page.getByTestId('pubsub-message-table').getByTestId('data-row').first()
  for (const size of await scale(row))
    expect(['11px mono', '12px mono', '12px sans']).toContain(size)
  // A tree row: 12 px mono names, 11 px mono figures.
  for (const size of await scale(page.getByTestId('panel-tree-node')))
    expect(['10px mono', '11px mono', '12px mono']).toContain(size)
  // An inspector field row: 13 px sans names, 12 px mono values.
  await page.getByRole('tab', { name: /Attributes/ }).click()
  expect(await scale(page.getByTestId('pubsub-message-attributes'))).toEqual([
    '12px mono',
    '13px sans',
  ])
  // Toolbar chrome is 12 px.
  for (const size of await scale(page.getByTestId('pubsub-topic-tabs')))
    expect(['11px mono', '12px mono', '12px sans']).toContain(size)

  for (const width of [1440, 1280, 1152, 1024]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.getByTestId('pubsub-message-table')).toBeVisible()
    const scope = await page.getByTestId('pubsub-scope').boundingBox()
    const newMenu = await page.getByTestId('pubsub-new-menu').boundingBox()
    expect(edge(scope)).toBeLessThanOrEqual((newMenu?.x ?? 0) + 1)
    expect(edge(newMenu)).toBeLessThanOrEqual(width)
    const overflow = await page
      .getByTestId('pubsub-row-one')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  }

  // The panel's toggle is one spot, in the panel and in the toolbar.
  await page.setViewportSize({ width: 1440, height: 800 })
  const inPanel = await page.getByTestId('panel-toggle').boundingBox()
  await page.getByTestId('panel-toggle').click()
  const inToolbar = await page.getByTestId('panel-toggle').boundingBox()
  expect(Math.abs((inPanel?.x ?? 0) - (inToolbar?.x ?? 0))).toBeLessThanOrEqual(0.5)
  await page.getByTestId('panel-toggle').click()
})

for (const scheme of ['light', 'dark'] as const)
  test(`J-PS-20 every control hovers a visible step, and no ring is cut (${scheme})`, async ({
    page,
    engine,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    const toward = scheme === 'light' ? -1 : 1
    const steps: Record<string, number> = {}
    const measure = async (name: string, control: Locator) => {
      await page.mouse.move(700, 895)
      await page.waitForTimeout(120)
      const rest = await paintOf(control)
      await control.hover()
      await page.waitForTimeout(160)
      steps[name] = toward * ((await paintOf(control)) - rest)
    }
    await openTopics(page, engine.origin)
    await measure('topic card', page.getByTestId('pubsub-topic-card').first())
    await measure('tree row', treeRow(page, 'audit-log'))
    await measure('tree arrow', treeRow(page, 'orders').getByTestId('panel-tree-toggle'))
    await openTopics(page, engine.origin, 'topic=orders')
    const rows = page.getByTestId('pubsub-message-table').getByTestId('data-row')
    await expect(rows.first()).toBeVisible()
    await rows.nth(0).hover()
    await measure('open, white row', rows.nth(0).getByTestId('open-row'))
    await rows.nth(1).hover()
    await measure('open, zebra row', rows.nth(1).getByTestId('open-row'))
    await measure('ghost button', page.getByTestId('pubsub-expr-open'))
    await measure('path segment', page.getByTestId('scope-project'))
    for (const [name, step] of Object.entries(steps))
      expect
        .soft(step, `${name}: ${scheme === 'light' ? 'darker' : 'lighter'} on hover`)
        .toBeGreaterThanOrEqual(6)

    // No frame or focus ring is cut by the box that clips it, at rest or in a Tab walk.
    expect(await cutRings(page)).toEqual([])
    const cut = new Set<string>()
    for (let step = 0; step < 16; step += 1) {
      await page.keyboard.press('Tab')
      for (const ring of await cutRings(page, true)) cut.add(ring)
    }
    expect([...cut]).toEqual([])
  })

test('J-PS-21 a refused publish is named, with the topic it probably meant', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps21')
  const typo = topic.slice(0, -1)
  try {
    await createTopic(engine, topic)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(
        `${portUrl(engine, 'pubsub')}/v1/projects/${engine.project}/topics/${typo}:publish`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ data: 'e30=' }] }),
        },
      )
      expect(response.status).toBe(404)
    }
    // The nav counts it on Topics until Topics is looked at.
    await page.goto(`${engine.origin}/console/`)
    await expect(page.getByTestId('nav-badge-pubsub-topics')).toBeVisible()
    await openTopics(page, engine.origin)
    const banner = page
      .getByTestId('pubsub-refused-banner')
      .filter({ hasText: topicName(engine, typo) })
    await expect(banner).toHaveText(
      new RegExp(
        `tried to publish to ${topicName(engine, typo)} 2 times; it does not exist\\. Did you mean ${topic}\\?`,
      ),
    )
    await banner.getByTestId('pubsub-refused-create').click()
    await expect(page.getByTestId('create-topic-id')).toHaveValue(typo)
    await page.keyboard.press('Escape')
    await banner.getByTestId('pubsub-refused-open').click()
    await expect(page).toHaveURL(new RegExp(`topic=${topic}`))
  } finally {
    await deleteTopic(engine, topic)
  }
})
