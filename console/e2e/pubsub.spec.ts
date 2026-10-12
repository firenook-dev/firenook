// Pub/Sub's Topics page against a real engine (project `messaging`): the
// seeded topics and the fixture's functions are read, never changed; every
// journey that changes something makes its own topic or subscription
// (`j-<id>-<random>`) and deletes it in `finally`.

import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { readDownload } from './support/downloads'
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
  waitForJob,
} from './support/messaging'
import { ownerFetch } from './support/api'

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

/** Writes `text` into the composer's data editor, replacing what is there. */
async function writeData(page: Page, text: string) {
  const editor = page.getByTestId('pubsub-composer').locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

test('J-PS-05 copies with templates: the engine’s preview, a job, and the rows that follow', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps05')
  try {
    await createTopic(engine, topic)
    await openTopics(page, engine.origin, `topic=${topic}`)
    await page.keyboard.press('n')
    await expect(page.getByTestId('pubsub-composer')).toBeVisible()
    await writeData(page, '{"n":"{{i}}"}')
    await page.getByTestId('composer-repeat').fill('50')
    // Message 1 as the engine would send it.
    await expect(page.getByTestId('composer-preview')).toHaveText('Message 1: {"n":"1"}')
    await page.getByTestId('composer-publish').click()
    await expect(page.getByTestId('composer-problems')).toContainText(
      `Published 50 messages to ${topic}`,
      {
        timeout: 20_000,
      },
    )
    await expect(page.getByTestId('pubsub-message-count')).toHaveText('50 messages')
    await expect(page.getByTestId('pubsub-topic-published')).toHaveText('50')
    const page1 = await consoleCall<{ items: { data: { text: string } }[] }>(
      engine,
      'GET',
      `/pubsub/messages?topic=${enc(topicName(engine, topic))}&limit=100`,
    )
    expect(page1.items.map((row) => JSON.parse(row.data.text).n).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index + 1)),
    )

    // Scrolled away, what arrives waits above, counted.
    await page.getByTestId('pubsub-composer-close').click()
    const scroller = page.getByTestId('pubsub-message-table-scroll')
    await scroller.evaluate((element) => {
      element.scrollTop = 400
    })
    await publishOverPort(engine, topic, [
      { data: { n: 'a' } },
      { data: { n: 'b' } },
      { data: { n: 'c' } },
    ])
    const pill = page.getByTestId('new-above')
    await expect(pill).toHaveText('3 new · Show')
    await pill.click()
    await expect(page.getByTestId('pubsub-message-count')).toHaveText('53 messages')
    await expect(scroller).toHaveJSProperty('scrollTop', 0)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-22 an export publishes back from a file', async ({ page, engine }) => {
  const topic = uniqueId('ps22')
  try {
    await createTopic(engine, topic)
    await openTopics(page, engine.origin, `topic=orders&q=${enc('key:cust-1')}`)
    await expect(page.getByTestId('pubsub-message-count')).toHaveText(
      /^\d+ messages · of \d+ kept$/,
    )
    const matched = Number(
      (await page.getByTestId('pubsub-message-count').innerText()).split(' ')[0],
    )
    await page.getByTestId('pubsub-export').click()
    await expect(page.getByTestId('pubsub-export-dialog-scope')).toContainText(
      'matching key:cust-1',
    )
    const download = page.waitForEvent('download')
    await page.getByTestId('pubsub-export-dialog-confirm').click()
    const file = await download
    const text = await readDownload(file)
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(matched)
    const exported = lines.map(
      (line) =>
        JSON.parse(line) as {
          data: string
          attributes: Record<string, string>
          orderingKey: string
        },
    )
    expect(exported.every((line) => line.orderingKey === 'cust-1')).toBe(true)

    await openTopics(page, engine.origin, `topic=${topic}&new=message`)
    await page.getByTestId('pubsub-publish-file-input').setInputFiles({
      name: 'orders.ndjson',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(text),
    })
    await expect(page.getByTestId('composer-file')).toContainText(
      `${matched} messages from orders.ndjson`,
    )
    await page.getByTestId('composer-file-publish').click()
    await expect(page.getByTestId('pubsub-message-count')).toHaveText(`${matched} messages`, {
      timeout: 20_000,
    })
    // The same bytes, attributes and keys, read back the way they were exported.
    const exportOf = async (id: string) => {
      const response = await ownerFetch(
        engine,
        `/pubsub/messages:export?topic=${enc(topicName(engine, id))}&format=ndjson`,
      )
      return (await response.text())
        .trim()
        .split('\n')
        .map((line) => {
          const entry = JSON.parse(line) as {
            data: string
            attributes: Record<string, string>
            orderingKey: string | null
          }
          return JSON.stringify([entry.data, entry.attributes, entry.orderingKey ?? null])
        })
        .toSorted()
    }
    expect(await exportOf(topic)).toEqual(
      exported
        .map((line) => JSON.stringify([line.data, line.attributes, line.orderingKey ?? null]))
        .toSorted(),
    )
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-23 an interval job outlives the composer and the tab', async ({ page, engine }) => {
  const topic = uniqueId('ps23')
  try {
    await createTopic(engine, topic)
    await openTopics(page, engine.origin, `topic=${topic}&new=message`)
    await writeData(page, '{"tick":"{{i}}"}')
    await page.getByTestId('composer-repeat').fill('20')
    await page.getByRole('combobox', { name: 'How often' }).click()
    await page.getByRole('option', { name: 'every 100 ms' }).click()
    await page.getByTestId('composer-publish').click()
    await expect(page.getByTestId('composer-job-progress')).toContainText('of 20 · every 100 ms')
    await page.getByTestId('pubsub-composer-close').click()

    const strip = page.getByTestId('pubsub-job')
    await expect(strip).toContainText(`Publishing 20 messages to ${topic}`)
    await expect(page.getByTestId('nav-badge-pubsub')).toBeVisible()
    const jobId = await strip.getAttribute('data-job')
    await page.reload()
    await expect(strip).toContainText(`Publishing 20 messages to ${topic}`)
    await strip.getByTestId('pubsub-job-stop').click()
    await expect(strip).toHaveCount(0)
    const stopped = await waitForJob(engine, jobId ?? '')
    expect(stopped.state).toBe('cancelled')
    expect(stopped.done).toBeGreaterThan(0)
    expect(stopped.done).toBeLessThan(20)
    await expect(page.getByTestId('pubsub-message-count')).toHaveText(
      `${stopped.done} ${stopped.done === 1 ? 'message' : 'messages'}`,
    )
    await expect(page.getByTestId('pubsub-topic-published')).toHaveText(String(stopped.done))
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-16b the palette opens the composer on a topic', async ({ page, engine }) => {
  await openTopics(page, engine.origin, 'topic=orders')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('publish')
  await page.getByRole('option', { name: 'Publish to orders' }).click()
  await expect(page).toHaveURL(/new=message/)
  await expect(page.getByTestId('pubsub-composer')).toBeVisible()
})

test('PS-14/16 a message is published again, as it is or edited, and copied as code', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps14b')
  try {
    await createTopic(engine, topic)
    const [first] = (
      await publishOverPort(engine, topic, [
        { data: { orderId: 'o_1' }, attributes: { region: 'eu' }, orderingKey: 'cust-1' },
        { data: { orderId: 'o_2' } },
        { data: { orderId: 'o_3' } },
      ])
    ).messageIds
    await openTopics(page, engine.origin, `topic=${topic}`)
    const rows = page.getByTestId('pubsub-message-table').getByTestId('data-row')
    await expect(rows).toHaveCount(3)

    // The inspector's Code: this message's bytes, attributes and key, at the engine's address.
    await page.getByTestId('pubsub-message-table').locator(`tr[data-key="${first}"]`).click()
    await expect(page.getByTestId('pubsub-message-inspector')).toBeVisible()
    await page.getByTestId('message-code').click()
    const code = page.getByTestId('message-code-popover')
    await expect(code).toContainText(
      `process.env.PUBSUB_EMULATOR_HOST ??= "${portUrl(engine, 'pubsub').replace('http://', '')}"`,
    )
    await expect(code).toContainText('orderId: "o_1"')
    await expect(code).toContainText('region: "eu"')
    await expect(code).toContainText('orderingKey: "cust-1"')
    await page.keyboard.press('Escape')

    // `r` asks first, then publishes the cursor row again.
    await page.keyboard.press('r')
    await expect(page.getByTestId('publish-again')).toContainText('Publish again')
    await page.getByTestId('publish-again-confirm').click()
    await expect(rows).toHaveCount(4, { timeout: 10_000 })

    // Two ticked rows, again, from the selection bar.
    await rows.nth(1).locator('td[data-check] [role="checkbox"]').click()
    await rows.nth(2).locator('td[data-check] [role="checkbox"]').click()
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
    await page.getByTestId('pubsub-selection-again').click()
    await page.getByTestId('publish-again-confirm').click()
    await expect(rows).toHaveCount(6, { timeout: 10_000 })
    await expect(page.getByTestId('pubsub-selection')).toHaveCount(0)

    // Shift+R: the composer, filled with the message, attributes and key.
    await page.getByTestId('pubsub-message-table').locator(`tr[data-key="${first}"]`).click()
    await page.keyboard.press('Shift+R')
    await expect(page).toHaveURL(new RegExp(`prefill=%22?${first}`))
    await expect(page.getByTestId('composer-ordering-key')).toHaveValue('cust-1')
    await expect(page.getByTestId('pubsub-composer').locator('.cm-content')).toContainText(
      '"orderId": "o_1"',
    )
  } finally {
    await deleteTopic(engine, topic)
  }
})
