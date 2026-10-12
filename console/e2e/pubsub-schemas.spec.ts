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

test('J-SC-02 revisions: commit, diff, roll back and delete', async ({ page, engine }) => {
  const id = uniqueId('sc02')
  try {
    await createSchema(engine, id, order('double'))
    await openSchemas(page, engine.origin, `schema=${id}`)
    const commit = page.getByTestId('pubsub-schema-commit')
    await expect(commit).toBeDisabled()

    // A field's type edited: ⌘S commits it as revision 2.
    await replaceText(page, 'pubsub-schema-source', order('long'))
    await expect(page.getByTestId('pubsub-schema-edited')).toBeVisible()
    await expect(commit).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('tab', { name: /Revisions 2/ })).toBeVisible()
    await expect(page.getByTestId('pubsub-schema-edited')).toHaveCount(0)
    const [first, second] = (await revisionsOf(engine, id)).map((revision) => revision.id)

    // The first against the editor: double out, long in.
    await page.getByRole('tab', { name: /Revisions/ }).click()
    const table = page.getByTestId('pubsub-schema-revisions-table')
    await table.locator(`tr[data-key="${first}"]`).click({ button: 'right' })
    await page.getByTestId('row-menu-diff').click()
    await expect(page).toHaveURL(new RegExp(`diff=${first}`))
    await expect(
      page.locator('[data-testid="pubsub-schema-diff-lines"] [data-kind="removed"]'),
    ).toContainText('"double"')
    await expect(
      page.locator('[data-testid="pubsub-schema-diff-lines"] [data-kind="added"]'),
    ).toContainText('"long"')

    // Rolled back: a third revision with the first's definition, in the editor.
    await page.getByRole('tab', { name: /Revisions/ }).click()
    await table.locator(`tr[data-key="${first}"]`).click({ button: 'right' })
    await page.getByTestId('row-menu-rollback').click()
    await expect(page.getByRole('tab', { name: /Revisions 3/ })).toBeVisible()
    await expect(page.getByTestId('pubsub-schema-source')).toContainText('"double"')
    const third = (await revisionsOf(engine, id)).at(-1)
    expect(JSON.parse(third?.definition ?? '{}')).toEqual(JSON.parse(order('double')))

    // The middle one deleted; then down to one, which cannot go.
    await page.getByRole('tab', { name: /Revisions/ }).click()
    await table.locator(`tr[data-key="${second}"]`).click({ button: 'right' })
    await page.getByTestId('row-menu-delete').click()
    await page.getByTestId('pubsub-revision-delete-confirm-confirm').click()
    await expect(page.getByRole('tab', { name: /Revisions 2/ })).toBeVisible()
    await table.locator(`tr[data-key="${first}"]`).click({ button: 'right' })
    await page.getByTestId('row-menu-delete').click()
    await page.getByTestId('pubsub-revision-delete-confirm-confirm').click()
    await expect(page.getByRole('tab', { name: /Revisions 1/ })).toBeVisible()
    await table.locator(`tr[data-key="${third?.id ?? ''}"]`).click({ button: 'right' })
    const last = page.getByTestId('row-menu-delete')
    await expect(last).toHaveAttribute('data-disabled', '')
    // Its tooltip's trigger wraps it, and takes the pointer.
    await last.hover({ force: true })
    await expect(page.locator('.kumo-tooltip-popup')).toContainText(
      'Cannot delete last revision. Please use DeleteSchema.',
    )
    expect(await revisionsOf(engine, id)).toHaveLength(1)
  } finally {
    await deleteSchema(engine, id)
  }
})

test('J-SC-03 a test message names the path that fails, and an example passes', async ({
  page,
  engine,
}) => {
  const id = uniqueId('sc03')
  try {
    await createSchema(engine, id, order('double'))
    await openSchemas(page, engine.origin, `schema=${id}`)
    await page.getByTestId('pubsub-schema-test-toggle').click()
    await expect(page).toHaveURL(/panel=test/)
    // It opens on the engine's example, which passes.
    await expect(page.getByTestId('schema-test-valid')).toContainText('Valid against the latest')
    await replaceText(page, 'schema-test-data', '{"orderId":"o_1","amount":"42.5"}')
    await expect(page.getByTestId('schema-test-problem')).toHaveText(
      '$.amount: expected a number, found string "42.5"',
    )
    await expect(page.getByTestId('schema-test-engine')).toHaveText(
      'A publish would answer: Could not parse JSON Avro message',
    )
    await page.getByTestId('schema-test-example').click()
    await expect(page.getByTestId('schema-test-valid')).toContainText('Valid against the latest')
    // Escape closes the panel.
    await page.getByTestId('pubsub-schema-tabs').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pubsub-schema-test')).toHaveCount(0)
  } finally {
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
