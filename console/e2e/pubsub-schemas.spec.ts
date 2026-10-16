// Pub/Sub's Schemas page against a real engine (project `messaging`): each
// journey makes its own schema (and topic) through the API or the page and
// deletes it in `finally`.

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { ownerFetch } from './support/api'
import {
  type SchemaDetailView,
  type TopicDetailView,
  consoleCall,
  createTopic,
  deleteTopic,
  schemaName,
  topicName,
  uniqueId,
} from './support/messaging'

const enc = encodeURIComponent

/** An Avro record of an order: its id, and an amount of `amount`'s type. */
const order = (amount: string) =>
  JSON.stringify({
    type: 'record',
    name: 'OrderEvent',
    fields: [
      { name: 'orderId', type: 'string' },
      { name: 'amount', type: amount },
    ],
  })

/** The Schemas page at `search`. */
async function openSchemas(page: Page, origin: string, search = '') {
  await page.goto(`${origin}/console/pubsub/schemas${search ? `?${search}` : ''}`)
  await expect(page.getByTestId('pubsub-schemas-page')).toBeVisible()
}

/** Replaces an editor's text the way a paste does: one insertion, no bracket closing. */
async function replaceText(page: Page, testId: string, text: string) {
  const editor = page.getByTestId(testId)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

/** Creates a schema through the Console API. */
function createSchema(engine: Parameters<typeof consoleCall>[0], id: string, definition: string) {
  return consoleCall<SchemaDetailView>(engine, 'POST', '/pubsub/schemas', {
    name: schemaName(engine, id),
    kind: 'AVRO',
    definition,
  })
}

/** Deletes a journey's schema; one already gone is fine. */
async function deleteSchema(
  engine: Parameters<typeof ownerFetch>[0] & { project: string },
  id: string,
) {
  const response = await ownerFetch(engine, '/pubsub/schema', {
    method: 'DELETE',
    body: JSON.stringify({ name: `projects/${engine.project}/schemas/${id}` }),
  })
  expect([204, 404]).toContain(response.status)
}

/** A schema's revisions as the engine holds them now. */
async function revisionsOf(engine: Parameters<typeof consoleCall>[0], id: string) {
  const detail = await consoleCall<SchemaDetailView>(
    engine,
    'GET',
    `/pubsub/schema?name=${enc(schemaName(engine, id))}`,
  )
  return detail.revisions
}

test('J-SC-01 a new schema says what is wrong, where, until it parses', async ({
  page,
  engine,
}) => {
  const id = uniqueId('sc01')
  try {
    await openSchemas(page, engine.origin)
    await page.keyboard.press('n')
    const dialog = page.getByTestId('create-schema')
    await expect(dialog).toBeVisible()
    await page.getByTestId('create-schema-id').fill(id)
    const check = page.getByTestId('create-schema-check')

    // JSON that does not read: the parser's reason, and the line it is on.
    await replaceText(page, 'create-schema-definition', '{"type": "record",\n "name": }')
    await expect(check).toContainText('(line 2, column')
    await expect(dialog.locator('.cm-lint-marker-error')).toHaveCount(1)

    // Avro that does not hold: the reason, placed on the name it is about.
    await replaceText(page, 'create-schema-definition', order('strin'))
    await expect(check).toContainText('Unknown primitive type: strin')
    await expect(dialog.locator('.cm-lintRange-error')).toHaveText('"strin"')

    // Fixed: valid, with a message of its shape from the engine.
    await replaceText(page, 'create-schema-definition', order('double'))
    await expect(check).toContainText('Valid Avro')
    await expect(page.getByTestId('create-schema-example')).toContainText('"orderId"')
    await page.getByTestId('create-schema-submit').click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`schema=${id}`))
    await expect(
      page.getByTestId('pubsub-schemas-tree').getByRole('treeitem', { name: id, exact: true }),
    ).toBeVisible()
    await expect(page.getByTestId('pubsub-schema-status')).toContainText('Valid Avro')
    await expect(page.getByTestId('pubsub-schema-source')).toContainText('"OrderEvent"')
  } finally {
    await deleteSchema(engine, id)
  }
})

test('J-SC-02 an edited definition commits as a new revision', async ({ page, engine }) => {
  const id = uniqueId('sc02')
  try {
    await createSchema(engine, id, order('double'))
    await openSchemas(page, engine.origin, `schema=${id}`)
    const commit = page.getByTestId('pubsub-schema-commit')
    await expect(commit).toBeDisabled()

    // A field's type edited: ⌘S commits it as revision 2, now the latest.
    await replaceText(page, 'pubsub-schema-source', order('long'))
    await expect(page.getByTestId('pubsub-schema-edited')).toBeVisible()
    await expect(commit).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByTestId('pubsub-schema-edited')).toHaveCount(0)
    await expect(commit).toBeDisabled()
    const revisions = await revisionsOf(engine, id)
    expect(revisions).toHaveLength(2)
    const latest = revisions.at(-1)?.id ?? ''
    expect(JSON.parse(revisions.at(-1)?.definition ?? '{}')).toEqual(JSON.parse(order('long')))
    await expect(page.getByTestId('pubsub-schema-status')).toContainText(
      latest.length > 12 ? latest.slice(0, 8) : latest,
    )
    // A definition that does not parse cannot be committed.
    await replaceText(page, 'pubsub-schema-source', order('strin'))
    await expect(page.getByTestId('pubsub-schema-status')).toContainText(
      'Unknown primitive type: strin',
    )
    await expect(commit).toBeDisabled()
  } finally {
    await deleteSchema(engine, id)
  }
})

test('J-SC-03 Used by lists the topics bound to a schema, each a link', async ({
  page,
  engine,
}) => {
  const id = uniqueId('sc03')
  const topic = `${id}-topic`
  try {
    await createSchema(engine, id, order('double'))
    await createTopic(engine, topic, {
      schema: { schema: schemaName(engine, id), encoding: 'BINARY' },
    })
    await openSchemas(page, engine.origin, `schema=${id}&view=used-by`)
    const table = page.getByTestId('pubsub-schema-used-by-table')
    await expect(page.getByRole('tab', { name: /Used by 1/ })).toBeVisible()
    await expect(table.getByTestId('data-row')).toHaveCount(1)
    await expect(table.getByTestId('data-row').first()).toContainText('binary')
    await table.getByRole('link', { name: topic }).click()
    await expect(page).toHaveURL(new RegExp(`/console/pubsub\\?.*topic=${topic}`))
  } finally {
    await deleteTopic(engine, topic)
    await deleteSchema(engine, id)
  }
})

test('J-SC-04 a topic bound to a schema publishes its examples, and refuses after it goes', async ({
  page,
  engine,
}) => {
  const id = uniqueId('sc04')
  const topic = `${id}-topic`
  try {
    await createSchema(engine, id, order('double'))
    await createTopic(engine, topic, {
      schema: { schema: schemaName(engine, id), encoding: 'JSON' },
    })
    await page.goto(`${engine.origin}/console/pubsub?topic=${topic}&new=message`)
    const composer = page.getByTestId('pubsub-composer')
    await expect(composer).toBeVisible()
    const publish = page.getByTestId('composer-publish')

    // An example from the engine passes the topic's schema, and publishes.
    await page.getByTestId('composer-fill-example').click()
    await expect(publish).toHaveClass(/!text-white/)
    await publish.click()
    await expect(page.getByTestId('pubsub-publish-result')).toContainText('Published 1')

    // A wrong message: the path, and Publish no longer the primary.
    const editor = composer.locator('.cm-content')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText('{"orderId":"o_2","amount":"x"}')
    // (The last publish's result holds the strip for six seconds first.)
    await expect(page.getByTestId('composer-schema-problem')).toContainText('$.amount', {
      timeout: 15_000,
    })
    await expect(publish).not.toHaveClass(/!text-white/)

    // The schema deleted from its page: the topic shows _deleted-schema_ and refuses publishes.
    await page.goto(`${engine.origin}/console/pubsub/schemas?schema=${id}`)
    await page.getByTestId('pubsub-schema-delete').click()
    await expect(page.getByTestId('pubsub-schema-delete-confirm')).toContainText(topic)
    await page.getByTestId('pubsub-schema-delete-confirm-confirm').click()
    await expect(page).not.toHaveURL(/schema=/)
    const detail = await consoleCall<TopicDetailView>(
      engine,
      'GET',
      `/pubsub/topic?name=${enc(topicName(engine, topic))}`,
    )
    expect(detail.schema?.deleted).toBe(true)
    await page.goto(`${engine.origin}/console/pubsub?topic=${topic}&view=settings`)
    await expect(page.getByTestId('pubsub-topic-settings')).toContainText('_deleted-schema_')
    await page.goto(`${engine.origin}/console/pubsub?topic=${topic}&new=message`)
    await expect(composer).toBeVisible()
    await page.getByTestId('pubsub-composer').locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText('{"orderId":"o_3","amount":1.5}')
    await publish.click()
    await expect(page.getByTestId('composer-error')).toContainText(
      'Schema associated with topic deleted.',
    )
  } finally {
    await deleteTopic(engine, topic)
    await deleteSchema(engine, id)
  }
})

test('J-SC-05 Protocol Buffer is offered, disabled, with the reason', async ({ page, engine }) => {
  await openSchemas(page, engine.origin, 'new=schema')
  await expect(page.getByTestId('create-schema')).toBeVisible()
  await page.getByRole('combobox', { name: 'Type' }).click()
  const protobuf = page.getByRole('option', { name: /Protocol Buffer/ })
  await expect(protobuf).toHaveAttribute('aria-disabled', 'true')
  await expect(protobuf).toContainText(
    'The emulator does not run Protocol Buffer schemas (the official one does not either).',
  )
})
