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
  type MessageDetailView,
  type SchemaDetailView,
  type SubscriptionDetailView,
  type TopicDetailView,
  type TopicIndexView,
  OTHER_PROJECT,
  consoleCall,
  createSubscription,
  createTopic,
  deleteTopic,
  functionUrl,
  holdPull,
  nackOverPort,
  portUrl,
  publishOverPort,
  schemaName,
  subscriptionName,
  topicName,
  uniqueId,
  waitForJob,
} from './support/messaging'
import { ownerFetch } from './support/api'

const enc = encodeURIComponent

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

  // The panel's toggle is one spot, in the panel and in the toolbar. Below
  // 1280 px the panel stood aside for the open inspector; it is back once
  // the window is wide again, and only then is its toggle measured.
  await page.setViewportSize({ width: 1440, height: 800 })
  await expect(page.getByTestId('section-panel')).toBeVisible()
  const inPanel = await page.getByTestId('panel-toggle').boundingBox()
  await page.getByTestId('panel-toggle').click()
  const inToolbar = await page.getByTestId('panel-toggle').boundingBox()
  expect(Math.abs((inPanel?.x ?? 0) - (inToolbar?.x ?? 0))).toBeLessThanOrEqual(0.5)
  await page.getByTestId('panel-toggle').click()
})

/**
 * Waits until every colour transition the page is running has finished: a
 * hover's ink fades in and out, so its colour is read once it has settled,
 * not after a guessed time. Endless animations (a breathing dot) are left.
 */
const transitionsDone = (control: Locator) =>
  control.evaluate((el) => {
    // This file is typed for Node; the page's animations as far as they are used.
    const running = (
      el.ownerDocument as unknown as {
        getAnimations(): { constructor: { name: string }; finished: Promise<unknown> }[]
      }
    ).getAnimations()
    return Promise.all(
      running
        .filter((animation) => animation.constructor.name === 'CSSTransition')
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => undefined)
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
      await transitionsDone(control)
      const rest = await paintOf(control)
      await control.hover()
      await transitionsDone(control)
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

    // Another journey's job may still run: this topic's is the one.
    const strip = page.getByTestId('pubsub-job').filter({ hasText: topic })
    await expect(strip).toContainText(`Publishing 20 messages to ${topic}`)
    await expect(page.getByTestId('nav-badge-pubsub')).toBeVisible()
    const jobId = await strip.locator('[data-job]').getAttribute('data-job')
    await page.reload()
    await expect(strip).toContainText(`Publishing 20 messages to ${topic}`)
    await strip.getByTestId('pubsub-job-cancel').click()
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

test('a message published while the page subscribes is listed and counted', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('race')
  try {
    await createTopic(engine, topic)
    await publishOverPort(engine, topic, [{ data: { n: 1 } }])
    // The page's live subscriptions wait until its first read is in, and a
    // message lands in between: the engine takes the topic after it, so no
    // event will tell of it.
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(/\/console\/api\/v1\/live\/[^/]+\/subscriptions$/, async (route) => {
      await held
      await route.continue()
    })
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/console/api/v1/pubsub/messages',
    )
    await openTopics(page, engine.origin, `topic=${topic}`)
    await read
    const count = page.getByTestId('pubsub-message-count')
    await expect(count).toHaveText('1 message')
    await publishOverPort(engine, topic, [{ data: { n: 2 } }])
    release?.()
    await expect(count).toHaveText('2 messages')
    await expect(page.getByTestId('pubsub-message-table').getByTestId('data-row')).toHaveCount(2)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
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
    // A key pressed inside an overlay belongs to it: wait for the popover to go.
    await expect(code).toBeHidden()

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

/** A subscription's figures as the engine reports them now. */
async function countersOf(engine: Parameters<typeof consoleCall>[0], id: string) {
  const detail = await consoleCall<SubscriptionDetailView>(
    engine,
    'GET',
    `/pubsub/subscription?name=${enc(subscriptionName(engine, id))}`,
  )
  return detail.subscription.summary.counters
}

/** A backlog row by its message id (row keys end with it). */
const backlogRow = (page: Page, id: string) =>
  page.getByTestId('pubsub-backlog-table').locator(`tr[data-key$=".${id}"]`)

test('J-PS-06 the backlog is read without leasing anything', async ({ page, engine }) => {
  const before = await countersOf(engine, 'orders-worker')
  await openTopics(page, engine.origin, 'topic=orders&subscription=orders-worker')
  const rows = page.getByTestId('pubsub-backlog-table').getByTestId('data-row')
  await expect(rows.first()).toBeVisible()
  // Available rows are numbered in delivery order, from #1.
  const places = await rows.locator('td[data-column="place"]').allInnerTexts()
  const numbered = places.filter((text) => text.startsWith('#')).slice(0, 5)
  expect(numbered).toEqual(numbered.map((_, index) => `#${index + 1}`))
  for (const index of [0, 1, 2]) {
    await rows.nth(index).click()
    await expect(page.getByTestId('pubsub-message-inspector')).toBeVisible()
    await expect(page.getByTestId('pubsub-subscription-state')).toContainText('on orders-worker')
  }
  const after = await countersOf(engine, 'orders-worker')
  expect(after.outstanding).toBe(before.outstanding)
  expect(after.available).toBe(before.available)
  expect(after.backlog).toBe(before.backlog)
})

test('J-PS-08 a connected subscriber is said in the tree', async ({ page, engine }) => {
  const topic = uniqueId('ps08')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic)
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}`)
    await expect(page.getByTestId('pubsub-subscription-tabs')).toBeVisible()
    const held = holdPull(engine, subscription)
    try {
      await treeRow(page, subscription).hover()
      await expect(page.locator('.kumo-tooltip-popup')).toContainText('1 subscriber')
    } finally {
      await held.stop()
    }
    expect((await countersOf(engine, subscription)).outstanding).toBe(0)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-10 purge: what waits is acknowledged, and kept when the subscription keeps it', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps10')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic, { retainAcked: true })
    await publishOverPort(engine, topic, [
      { data: { n: 1 } },
      { data: { n: 2 } },
      { data: { n: 3 } },
    ])
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}`)
    // Kept once acknowledged, the rows stay in the backlog's All as acked.
    const rows = page.getByTestId('pubsub-backlog-table').getByTestId('data-row')
    const available = rows.filter({ hasText: 'available' })
    const acked = rows.filter({ hasText: 'acked (retained)' })
    await expect(available).toHaveCount(3)
    await page.getByTestId('pubsub-purge').click()
    const confirm = page.getByTestId('pubsub-purge-confirm')
    await expect(confirm).toContainText(
      'The 3 messages waiting now are acknowledged, as if a subscriber had acked them; messages published from now on arrive as usual.',
    )
    await expect(confirm).toContainText('they stay in its backlog, listed as acked')
    await page.getByTestId('pubsub-purge-confirm-confirm').click()
    await expect(confirm).toHaveCount(0)
    await expect(acked).toHaveCount(3)
    await expect(available).toHaveCount(0)
    expect((await countersOf(engine, subscription)).backlog).toBe(0)
    // What is published after arrives as usual.
    await publishOverPort(engine, topic, [{ data: { n: 4 } }])
    await expect(available).toHaveCount(1)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-11 push attempts: a streak in place, the pause, and the switch to pull', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps11')
  const subscription = `${topic}-push`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic, {
      pushEndpoint: functionUrl(engine, 'pushSink'),
    })
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}&view=push`)
    await expect(page.getByTestId('pubsub-push-empty')).toBeVisible()
    const [first] = (
      await publishOverPort(engine, topic, [{ data: { n: 1 }, attributes: { failTimes: '2' } }])
    ).messageIds
    const streaks = page.getByTestId('pubsub-push-feed').locator('[data-streak]')
    const refused = streaks.filter({
      has: page.getByTestId('push-status').filter({ hasText: '500' }),
    })
    const accepted = streaks.filter({
      has: page.getByTestId('push-status').filter({ hasText: '200' }),
    })
    // Two refusals are one row that counted up, then the delivery.
    await expect(accepted).toHaveCount(1, { timeout: 15_000 })
    await expect(refused).toHaveCount(1)
    await expect(refused).toContainText('×2')
    await expect(refused.getByTestId('push-attempts')).toHaveText('1–2')
    await expect(accepted.getByTestId('push-attempts')).toHaveText('3')
    await expect(streaks.first()).toContainText(first ?? '')
    await expect.poll(async () => (await countersOf(engine, subscription)).backlog).toBe(0)

    // Paused, a new message's attempts wait; resumed, they are there.
    await page.keyboard.press('p')
    const pause = page.getByTestId('pubsub-push-pause')
    await expect(pause).toHaveText('Paused')
    await expect(page).toHaveURL(/paused=true/)
    const [second] = (await publishOverPort(engine, topic, [{ data: { n: 2 } }])).messageIds
    await expect(pause).toHaveText('Paused · 1 new', { timeout: 15_000 })
    await page.keyboard.press('p')
    await expect(pause).toHaveText('Pause')
    await expect(streaks.first()).toContainText(second ?? '')
    await expect(streaks.first()).toBeInViewport()

    // Switched to pull, the Push tab goes and the backlog keeps what arrives.
    await page.getByTestId('pubsub-push-to-pull').click()
    await expect(page.getByRole('tab', { name: 'Push' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Backlog', selected: true })).toBeVisible()
    const [third] = (await publishOverPort(engine, topic, [{ data: { n: 3 } }])).messageIds
    await expect(backlogRow(page, third ?? '')).toContainText('available')
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-13 a lease a subscriber holds is returned from the Backlog', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps13')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic, { ackDeadlineSeconds: 60 })
    const [id] = (await publishOverPort(engine, topic, [{ data: { n: 1 } }])).messageIds
    // A subscriber pulls it over the port and holds its lease.
    const pulled = (await (
      await fetch(
        `${portUrl(engine, 'pubsub')}/v1/projects/${engine.project}/subscriptions/${subscription}:pull`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxMessages: 1, returnImmediately: true }),
        },
      )
    ).json()) as { receivedMessages?: unknown[] }
    expect(pulled.receivedMessages).toHaveLength(1)
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}`)
    const row = backlogRow(page, id ?? '')
    await expect(row).toContainText('outstanding')
    await row.click({ button: 'right' })
    await page.getByTestId('row-menu-release').click()
    await expect(page.getByTestId('pubsub-backlog-confirm')).toContainText(
      'A subscriber holds its lease.',
    )
    await page.getByTestId('pubsub-backlog-confirm-confirm').click()
    await expect(row).toContainText('available')
    expect((await countersOf(engine, subscription)).outstanding).toBe(0)
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('J-PS-24 a bulk ack runs as a job and the backlog empties by patches', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps24')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic)
    await publishOverPort(
      engine,
      topic,
      Array.from({ length: 30 }, (_, n) => ({ data: { n } })),
    )
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}`)
    const rows = page.getByTestId('pubsub-backlog-table').getByTestId('data-row')
    await expect(page.getByTestId('pubsub-backlog-count')).toContainText('30 messages')
    await expect(rows.first()).toBeVisible()
    let navigations = 0
    let patches = 0
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1
    })
    page.on('request', (request) => {
      if (request.url().includes('/pubsub/backlog:batchGet')) patches += 1
    })

    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.getByTestId('selection-count')).toHaveText('30 selected')
    await page.keyboard.press('Delete')
    const confirm = page.getByTestId('pubsub-backlog-ack-confirm')
    await expect(confirm).toContainText(`Acknowledge 30 at ${subscription}`)
    await page.getByTestId('pubsub-backlog-ack-confirm-confirm').click()
    await expect(page.getByTestId('pubsub-backlog-ack-confirm-progress')).toContainText(
      '30 of 30 acknowledged',
    )
    await page.getByTestId('pubsub-backlog-ack-confirm-cancel').click()
    await expect(rows).toHaveCount(0)
    await expect(page.getByTestId('pubsub-backlog-empty')).toBeVisible()
    expect(navigations).toBe(0)
    expect(patches).toBeGreaterThan(0)
    const after = await countersOf(engine, subscription)
    expect([after.backlog, after.outstanding]).toEqual([0, 0])
  } finally {
    await deleteTopic(engine, topic)
  }
})

// ------------------------------------------------------------ deliveries and the setup

/** A message's deliveries to functions as the engine reports them now. */
async function deliveriesOf(engine: Parameters<typeof consoleCall>[0], topic: string, id: string) {
  return (
    await consoleCall<MessageDetailView>(
      engine,
      'GET',
      `/pubsub/message?topic=${enc(topicName(engine, topic))}&id=${id}`,
    )
  ).functions
}

test('J-PS-03 a JSON message is published, read whole, and delivered to its function', async ({
  page,
  engine,
}) => {
  await openTopics(page, engine.origin, 'topic=orders')
  await page.keyboard.press('n')
  await expect(page.getByTestId('pubsub-composer')).toBeVisible()
  await writeData(page, '{"orderId":"o_1","amount":4.5}')
  await page.getByTestId('composer-attributes-add-key').pressSequentially('region')
  await expect(page.getByTestId('composer-attributes-key').first()).toHaveValue('region')
  await page.getByTestId('composer-attributes-value').first().fill('eu')
  await page.getByTestId('composer-ordering-key').fill('cust-1')
  await page.getByTestId('composer-ordering-key').press('ControlOrMeta+Enter')

  // The result line names the id; the row is at the top and flashes.
  const result = page.getByTestId('pubsub-publish-result')
  await expect(result).toContainText(/^Published 1 · id \d+/)
  const id = /id (\d+)/.exec(await result.innerText())?.[1] ?? ''
  const row = page.getByTestId('pubsub-message-table').locator(`tr[data-key="${id}"]`)
  await expect(row).toHaveClass(/row-flash/)
  await expect(
    page.getByTestId('pubsub-message-table').getByTestId('data-row').first(),
  ).toHaveAttribute('data-key', id)

  // Opened: the data as a tree, the attribute and the key, and where it went.
  await page.getByTestId('pubsub-composer-close').click()
  await row.click()
  const inspector = page.getByTestId('pubsub-message-inspector')
  await expect(inspector.getByTestId('pubsub-message-data-json')).toContainText('o_1')
  await inspector.getByRole('tab', { name: /Attributes/ }).click()
  await expect(inspector.getByTestId('message-attribute-region')).toContainText('eu')
  await expect(inspector.getByTestId('message-ordering-key')).toContainText('cust-1')
  await inspector.getByRole('tab', { name: /Deliveries/ }).click()
  // The function decoded it with the real SDK (`event.data.message.json`) and returned.
  await expect(inspector.getByTestId('message-function')).toHaveAttribute(
    'data-mark',
    'delivered',
    {
      timeout: 15_000,
    },
  )
  await expect(inspector.getByTestId('message-function')).toContainText('onOrderPlaced')
  const at = (subscription: string) =>
    inspector.getByTestId('message-at-subscription').filter({ hasText: subscription })
  await expect(at('orders-worker')).toHaveAttribute('data-state', 'available')
  await expect(at('orders-filtered')).toHaveAttribute('data-state', 'available')
})

test('J-PS-04 a failing function, its request, and a run again with one message', async ({
  page,
  engine,
}) => {
  const [id] = (
    await publishOverPort(engine, 'orders', [
      { data: { fail: true, reason: 'card declined' }, attributes: { region: 'us' } },
    ])
  ).messageIds
  const failed = async () =>
    (await deliveriesOf(engine, 'orders', id ?? '')).find((item) => !item.redelivery)
  await expect.poll(async () => (await failed())?.mark, { timeout: 15_000 }).toBe('failed')
  const original = (await failed())?.eventId ?? ''
  const topic = await consoleCall<TopicDetailView>(
    engine,
    'GET',
    `/pubsub/topic?name=${enc(topicName(engine, 'orders'))}`,
  )
  const published = topic.summary.counters.published

  // The message's row marks the function in the danger tone.
  await openTopics(page, engine.origin, 'topic=orders')
  const messageRow = page.getByTestId('pubsub-message-table').locator(`tr[data-key="${id}"]`)
  await expect(messageRow.locator('[data-mark="failed"]')).toBeVisible()

  // Opened on its Deliveries: failed, with the handler's own error, and the
  // CloudEvent the function received, as compute recorded it.
  await messageRow.click()
  const inspector = page.getByTestId('pubsub-message-inspector')
  await inspector.getByRole('tab', { name: /Deliveries/ }).click()
  const delivery = inspector.getByTestId('message-function').filter({ hasText: 'failed' })
  await expect(delivery).toContainText('order rejected: card declined')
  await delivery.getByTestId('message-function-dispatch-toggle').click()
  const body = delivery.getByTestId('message-function-dispatch-body')
  await expect(body).toContainText('cloudevents')
  await expect(body).toContainText('google.cloud.pubsub.topic.v1.messagePublished')
  await expect(body).toContainText(original)
  await expect(delivery.getByTestId('message-function-dispatch-rebuilt')).toHaveCount(0)
  // Logs links there once the Logs section is shown in this console.
  const logs = delivery.getByTestId('message-function-logs')
  if ((await logs.count()) > 0) await expect(logs).toHaveAttribute('href', /function/)

  // Run again asks first; Enter runs it again, for this function alone.
  await delivery.getByTestId('message-function-again').click()
  const confirm = page.getByTestId('pubsub-run-again')
  await expect(confirm).toContainText(`Run onOrderPlaced again with message ${id}?`)
  expect(await deliveriesOf(engine, 'orders', id ?? '')).toHaveLength(1)
  await page.keyboard.press('Enter')
  await expect(confirm).toBeHidden()
  const again = inspector
    .getByTestId('message-function')
    .filter({ has: page.getByTestId('message-function-redelivery') })
  await expect(again).toHaveCount(1, { timeout: 15_000 })
  await expect(again).toHaveAttribute('data-mark', 'failed', { timeout: 15_000 })
  const resent = (await deliveriesOf(engine, 'orders', id ?? '')).find((item) => item.redelivery)
  expect(resent?.eventId).toBeTruthy()
  expect(resent?.eventId).not.toBe(original)
  // Nothing was published again: the topic's count is what it was.
  const after = await consoleCall<TopicDetailView>(
    engine,
    'GET',
    `/pubsub/topic?name=${enc(topicName(engine, 'orders'))}`,
  )
  expect(after.summary.counters.published).toBe(published)
  // Each delivery's request carries its own event id.
  await again.getByTestId('message-function-dispatch-toggle').click()
  await expect(again.getByTestId('message-function-dispatch-body')).toContainText(
    resent?.eventId ?? '',
  )

  // Every run of the topic's function is an invocation in Functions.
  await page.keyboard.press('Escape')
  await page.getByTestId('pubsub-topic-runs').click()
  await expect(page).toHaveURL(/\/console\/functions\/invocations\?/)
  await expect(page.getByTestId('invocations-filter-input')).toHaveValue(
    'function:us-central1-onOrderPlaced',
  )
  await expect(
    page.getByTestId('invocations-list').getByTestId('invocation-row').first(),
  ).toBeVisible()
})

test('J-PS-09 a dead letter reaches its topic, its tab, and the function on it', async ({
  page,
  engine,
}) => {
  const topic = uniqueId('ps09')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic, {
      deadLetter: { topic: topicName(engine, 'orders-dead'), maxDeliveryAttempts: 5 },
    })
    const [id] = (await publishOverPort(engine, topic, [{ data: { orderId: 'o_dead' } }]))
      .messageIds
    expect(await nackOverPort(engine, subscription)).toBe(5)

    // In orders-dead, the attributes the engine wrote are explained and linked.
    const findDead = async () => {
      const page1 = await consoleCall<{
        items: { id: string; attributes: Record<string, string> }[]
      }>(engine, 'GET', `/pubsub/messages?topic=${enc(topicName(engine, 'orders-dead'))}&limit=50`)
      return page1.items.find(
        (item) => item.attributes.CloudPubSubDeadLetterSourceSubscription === subscription,
      )?.id
    }
    await expect.poll(findDead, { timeout: 15_000 }).toBeTruthy()
    const dead = (await findDead()) ?? ''
    await openTopics(page, engine.origin, `topic=orders-dead&message=${dead}&tab=attributes`)
    const source = page.getByTestId('message-dead-letter-source')
    await expect(source).toHaveText(subscription)

    // The function listening on orders-dead ran for it (dead letters reach functions).
    await page
      .getByTestId('pubsub-message-inspector')
      .getByRole('tab', { name: /Deliveries/ })
      .click()
    const delivered = page
      .getByTestId('pubsub-message-inspector')
      .getByTestId('message-function')
      .filter({ hasText: 'onOrderDeadLettered' })
    await expect(delivered).toHaveAttribute('data-mark', 'delivered', { timeout: 15_000 })

    // The subscription's Dead letters tab lists it, under its fixed expression.
    await openTopics(page, engine.origin, `topic=${topic}&subscription=${subscription}`)
    await page.getByRole('tab', { name: 'Dead letters' }).click()
    await expect(page.getByTestId('pubsub-fixed-expr')).toHaveText(`from ${subscription}`)
    await expect(
      page.getByTestId('pubsub-message-table').locator(`tr[data-key="${dead}"]`),
    ).toBeVisible()
    expect(id).toBeTruthy()
  } finally {
    await deleteTopic(engine, topic)
  }
})

/** An Avro record with one field of `type`: each revision of J-PS-15's schema changes it. */
const definition = (type: string) =>
  JSON.stringify({ type: 'record', name: 'Order', fields: [{ name: 'amount', type }] })

test('J-PS-15 the setup goes out as a file and comes back with its revisions', async ({
  page,
  engine,
}) => {
  const schema = uniqueId('ps15')
  const topic = `${schema}-topic`
  const subscription = `${schema}-sub`
  try {
    // A schema with three revisions, a topic bound to the first two, a subscription.
    const created = await consoleCall<SchemaDetailView>(engine, 'POST', '/pubsub/schemas', {
      name: schemaName(engine, schema),
      kind: 'AVRO',
      definition: definition('int'),
    })
    await consoleCall(engine, 'POST', '/pubsub/schema/commit', {
      name: schemaName(engine, schema),
      definition: definition('long'),
    })
    const full = await consoleCall<SchemaDetailView>(engine, 'POST', '/pubsub/schema/commit', {
      name: schemaName(engine, schema),
      definition: definition('double'),
    })
    const [first, second] = full.revisions.map((revision) => revision.id)
    expect(full.revisions).toHaveLength(3)
    expect(created.revisions[0]?.id).toBe(first)
    await createTopic(engine, topic, {
      schema: {
        schema: schemaName(engine, schema),
        encoding: 'JSON',
        firstRevisionId: first ?? '',
        lastRevisionId: second ?? '',
      },
    })
    await createSubscription(engine, subscription, topic)

    // Export from the New menu: a file, indented, without what the functions make.
    await openTopics(page, engine.origin)
    await page.getByTestId('pubsub-new-menu').click()
    await page.getByTestId('pubsub-export-setup').click()
    await expect(page).toHaveURL(/dialog=setup/)
    await expect(page.getByTestId('pubsub-setup-counts')).toContainText('schema with 3 revisions')
    await expect(page.getByTestId('pubsub-setup-left-out')).toContainText('function-managed')
    const download = page.waitForEvent('download')
    await page.getByTestId('pubsub-setup-download').click()
    const file = await download
    expect(file.suggestedFilename()).toBe('pubsub-setup.json')
    const text = await readDownload(file)
    const setup = JSON.parse(text) as {
      topics: { name: string }[]
      subscriptions: { name: string }[]
      schemas: { name: string; revisions: { id: string }[] }[]
    }
    expect(setup.topics.map((item) => item.name)).toContain(topicName(engine, topic))
    expect(setup.topics.some((item) => item.name.includes('/topics/firebase-schedule-'))).toBe(
      false,
    )
    expect(
      setup.subscriptions.some((item) => item.name.includes('/subscriptions/emulator-sub-')),
    ).toBe(false)
    expect(
      setup.schemas
        .find((item) => item.name === schemaName(engine, schema))
        ?.revisions.map((revision) => revision.id),
    ).toEqual(full.revisions.map((revision) => revision.id))

    // Gone: the topic, its subscription and the schema.
    await deleteTopic(engine, topic)
    await consoleCall(engine, 'DELETE', '/pubsub/schema', { name: schemaName(engine, schema) })

    // Import: the preview, then the engine's answer with the revision ids it mapped.
    await page.reload()
    await page.getByTestId('pubsub-new-menu').click()
    await page.getByTestId('pubsub-import-setup').click()
    await page.getByTestId('pubsub-setup-file').setInputFiles({
      name: 'pubsub-setup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const item = (name: string) =>
      page.getByTestId('pubsub-setup-item').and(page.locator(`[data-name="${name}"]`))
    await expect(item(schemaName(engine, schema))).toHaveAttribute('data-status', 'create')
    await expect(item(topicName(engine, topic))).toHaveAttribute('data-status', 'create')
    await expect(item(subscriptionName(engine, subscription))).toHaveAttribute(
      'data-status',
      'create',
    )
    await expect(item(topicName(engine, 'orders'))).toHaveAttribute('data-status', 'exists')
    await expect(page.getByTestId('pubsub-setup-create')).toHaveText('Create 3')
    await page.getByTestId('pubsub-setup-create').click()
    const answer = page.getByTestId('pubsub-setup-result')
    await expect(answer).toContainText('Created 3')
    await expect(page.getByTestId('pubsub-setup-mapping')).toHaveCount(3)
    await expect(page.getByTestId('pubsub-setup-skipped').first()).toContainText(
      'It already exists.',
    )

    // All back: the topic bound to the ids the replay made, the window kept.
    const back = await consoleCall<SchemaDetailView>(
      engine,
      'GET',
      `/pubsub/schema?name=${enc(schemaName(engine, schema))}`,
    )
    expect(back.revisions.map((revision) => revision.definition)).toEqual(
      full.revisions.map((revision) => revision.definition),
    )
    const bound = await consoleCall<TopicDetailView>(
      engine,
      'GET',
      `/pubsub/topic?name=${enc(topicName(engine, topic))}`,
    )
    expect(bound.schema?.firstRevisionId).toBe(back.revisions[0]?.id)
    expect(bound.schema?.lastRevisionId).toBe(back.revisions[1]?.id)
    await expect(page.getByTestId('pubsub-setup-mapping').first()).toContainText(
      back.revisions[0]?.id ?? '',
    )
    await page.getByTestId('pubsub-setup-done').click()
    await expect(page).not.toHaveURL(/dialog=setup/)
    await expand(page, topic)
    await expect(treeRow(page, subscription)).toBeVisible()
  } finally {
    await deleteTopic(engine, topic)
    await ownerFetch(engine, '/pubsub/schema', {
      method: 'DELETE',
      body: JSON.stringify({ name: schemaName(engine, schema) }),
    })
  }
})
