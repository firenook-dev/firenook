import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Every page's text boxes keep what is typed into them, and every menu's
// dividers divide (project `shell`, profile `all`, so every section has
// something to show).
//
// A field is typed into a key at a time, waits long enough for any debounce,
// URL write or refetch to land, and is typed into again: a field that
// re-selects its text on a re-render loses the first keys to the next one,
// which is how the Firestore path box broke. Fields appear three ways: on
// the page as it opens, behind a control that turns into one (the path
// boxes), and in the dialogs the New menus and the `…` items open. Every
// menu a page offers is opened and its dividers checked: none first, none
// last, never two together.

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the worker engine did not start')
  return value
}

const PAGES = [
  { name: 'Overview', url: '' },
  { name: 'Firestore, the root', url: '/firestore' },
  { name: 'Firestore, a collection', url: '/firestore?path=users' },
  { name: 'Firestore, a document', url: '/firestore?path=users&doc=users%2Fu_k65eq' },
  { name: 'Firestore rules', url: '/firestore/rules' },
  { name: 'Auth users', url: '/auth' },
  { name: 'Auth, a user', url: '/auth?user=u_k65eq' },
  { name: 'Auth activity', url: '/auth/activity' },
  { name: 'Auth inbox', url: '/auth/inbox' },
  { name: 'Auth settings', url: '/auth/settings' },
  { name: 'Storage', url: '/storage' },
  { name: 'Storage rules', url: '/storage/rules' },
  { name: 'Functions', url: '/functions' },
  { name: 'Functions, one', url: '/functions?function=us-central1-onOrderCreated' },
  { name: 'Invocations', url: '/functions/invocations' },
  { name: 'Extensions', url: '/extensions' },
  { name: 'Eventarc', url: '/eventarc' },
  { name: 'Pub/Sub', url: '/pubsub' },
  { name: 'Pub/Sub, a topic', url: '/pubsub?topic=audit-log' },
  { name: 'Pub/Sub schemas', url: '/pubsub/schemas' },
  { name: 'Tasks', url: '/tasks' },
  { name: 'Logs', url: '/logs' },
] as const

const FIELDS = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="email"]',
  'input[type="password"]',
  'textarea',
  '[contenteditable="true"]',
].join(', ')

/** Controls that become a field when clicked. */
const OPENERS = ['button[aria-label="Edit the path"]']

/** Menus whose items open the dialogs to make things. */
const NEW_MENUS = new Set(['new-menu', 'new-users-menu', 'pubsub-new-menu', 'upload-menu'])

// None of these is a shortcut anywhere in the console, so a key that misses
// its field does nothing worse than miss.
const FIRST = 'qz'
const THEN = 'y'

async function open(page: Page, url: string) {
  await page.goto(`${origin()}/console${url}`)
  await expect(page.locator('main').first()).toBeVisible()
  // The page's first reads land, and whatever they rearrange settles.
  await page.waitForTimeout(800)
}

/** A field's own state, read without the DOM's types (the journeys compile without them). */
type Control = { value?: unknown; disabled?: boolean; readOnly?: boolean }

/** Marks the usable fields in `scope` with their order, and returns how many there are. */
function markFields(page: Page, scope = 'body'): Promise<number> {
  return page
    .locator(scope)
    .last()
    .evaluate((root, fields) => {
      let count = 0
      for (const element of root.querySelectorAll(fields)) {
        element.removeAttribute('data-sweep')
        if (element.getClientRects().length === 0) continue
        if (element.closest('[aria-hidden="true"], [inert]')) continue
        const control = element as unknown as Control
        if (control.disabled || control.readOnly) continue
        // CodeMirror's content is the field; its other editable parts are not.
        if (element.parentElement?.isContentEditable) continue
        element.setAttribute('data-sweep', String(count))
        count += 1
      }
      return count
    }, FIELDS)
}

function readField(field: Locator): Promise<{ value: string; label: string }> {
  return field.evaluate((element) => {
    const { value: own } = element as unknown as Control
    const value = typeof own === 'string' ? own : (element.textContent ?? '')
    const label =
      element.getAttribute('data-testid') ??
      element.getAttribute('aria-label') ??
      element.getAttribute('placeholder') ??
      element.getAttribute('name') ??
      element.className.toString().slice(0, 40)
    return { value, label }
  })
}

/** Types into a field the way a person does, and says what went missing, if anything. */
async function typeInto(page: Page, field: Locator, where: string): Promise<string | undefined> {
  // A field a popover covers is still the one being typed into.
  await field.click({ timeout: 1_500 }).catch(() => field.focus())
  // From the end of whatever is there, so nothing typed replaces it.
  const editable = await field.evaluate((element) => {
    const control = element as unknown as {
      value?: unknown
      setSelectionRange?: (start: number, end: number) => void
    }
    if (typeof control.value !== 'string' || !control.setSelectionRange) return true
    try {
      control.setSelectionRange(control.value.length, control.value.length)
      return false
    } catch {
      // An email field has no selection to set.
      return true
    }
  })
  if (editable) await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(FIRST, { delay: 60 })
  await page.waitForTimeout(600)
  await page.keyboard.type(THEN, { delay: 60 })
  await page.waitForTimeout(250)
  const { value, label } = await readField(field)
  if (value.includes(FIRST + THEN)) return undefined
  // A field may hand the keyboard on by design (typing into a list's empty
  // last row starts a row of its own), and the keys went with it.
  const focused = page.locator(':focus')
  if ((await focused.count()) === 1 && (await readField(focused)).value.includes(FIRST + THEN))
    return undefined
  return `${where}: typing "${FIRST + THEN}" into ${label} left ${JSON.stringify(value.slice(-60))}`
}

/** The rows of the open menu, top to bottom: `i` an item, `t` text, `|` a divider. */
function menuRows(menu: Locator): Promise<string> {
  return menu.evaluate((element) => {
    const rows: string[] = []
    const walk = (parent: (typeof element)['children'][number]) => {
      for (const child of parent.children) {
        if (child.getClientRects().length === 0) continue
        const role = child.getAttribute('role') ?? ''
        if (role === 'separator') rows.push('|')
        else if (role.startsWith('menuitem')) rows.push('i')
        else if (child.querySelector('[role^="menuitem"], [role="separator"]')) walk(child)
        else if ((child.textContent ?? '').trim() || child.querySelector('input')) rows.push('t')
      }
    }
    walk(element)
    return rows.join('')
  })
}

function dividerProblem(rows: string): string | undefined {
  if (rows.startsWith('|')) return 'a divider above everything'
  if (rows.endsWith('|')) return 'a divider below everything'
  if (rows.includes('||')) return 'two dividers together'
  return undefined
}

const openMenu = (page: Page) => page.locator('[role="menu"]:visible').last()

/** Opens a trigger's menu, and says whether one came. */
async function showMenu(page: Page, trigger: Locator): Promise<boolean> {
  // A trigger shown only under the pointer (a row's menu) can sit under
  // another element; the keyboard opens it all the same. One that is gone
  // (a dialog changed the page) is skipped.
  const clicked = await trigger
    .click({ timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!clicked) {
    const focused = await trigger
      .focus({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!focused) return false
    await page.keyboard.press('Enter')
  }
  return openMenu(page)
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
}

async function closeEverything(page: Page) {
  const layers = page.locator('[role="menu"]:visible, [role="dialog"]:visible')
  for (let i = 0; i < 4 && (await layers.count()) > 0; i += 1) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await expect(layers, 'every menu and dialog closes on Escape').toHaveCount(0)
  // Base UI's backdrop outlives the popup by its exit animation.
  await expect(page.locator('[data-base-ui-inert]')).toHaveCount(0)
}

for (const target of PAGES) {
  test(`${target.name}: every field keeps what is typed, and every menu's dividers divide`, async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const problems: string[] = []
    const checked: string[] = []

    // The fields on the page as it opens. One load serves as many as it
    // can; typing into one can hide another (a filter empties a list), so
    // those get a fresh load.
    await open(page, target.url)
    let pending = Array.from({ length: await markFields(page) }, (_, index) => index)
    for (let load = 0; pending.length > 0; load += 1) {
      if (load > 0) {
        await open(page, target.url)
        await markFields(page)
      }
      const left: number[] = []
      for (const index of pending) {
        const field = page.locator(`[data-sweep="${index}"]`)
        if (!(await field.isVisible().catch(() => false))) {
          left.push(index)
          continue
        }
        checked.push((await readField(field)).label)
        const problem = await typeInto(page, field, target.name)
        if (problem) problems.push(problem)
        // Whatever the typing opened (completions, a picker) closes.
        await page.keyboard.press('Escape')
      }
      // A fresh load that reaches none of what is left never will.
      if (load > 0 && left.length === pending.length) break
      pending = left
    }

    // The fields that a control turns into.
    for (const opener of OPENERS) {
      await open(page, target.url)
      if ((await page.locator(opener).count()) === 0) continue
      await page.locator(opener).first().click()
      const field = page.locator(':focus')
      await expect(field, `${opener} hands the keyboard to a field`).toHaveCount(1)
      checked.push((await readField(field)).label)
      const problem = await typeInto(page, field, `${target.name}, ${opener}`)
      if (problem) problems.push(problem)
    }

    // Every menu, its dividers, and the dialogs its making items open.
    await open(page, target.url)
    const triggers = page.locator('[aria-haspopup="menu"]:visible')
    const count = await triggers.count()
    // A menu every row repeats is the same menu: two of each are enough.
    const seen = new Map<string, number>()
    for (let index = 0; index < count; index += 1) {
      await closeEverything(page)
      const trigger = triggers.nth(index)
      if ((await trigger.count()) === 0 || !(await trigger.isEnabled())) continue
      const testId = await trigger.getAttribute('data-testid')
      const label = await trigger.getAttribute('aria-label')
      const name = testId ?? label ?? (await trigger.innerText()).trim().slice(0, 30)
      const kind = testId ?? label?.split(' ').slice(0, 2).join(' ') ?? name
      seen.set(kind, (seen.get(kind) ?? 0) + 1)
      if ((seen.get(kind) ?? 0) > 2) continue
      if (!(await showMenu(page, trigger))) continue
      const menu = openMenu(page)
      const rows = await menuRows(menu)
      const problem = dividerProblem(rows)
      if (problem) problems.push(`${target.name}: the ${name} menu has ${problem} (${rows})`)
      const items = (await menu.locator('[role^="menuitem"]').allInnerTexts()).map(
        (text) => text.trim().split('\n')[0] ?? '',
      )

      // Fields inside the menu itself (a search box).
      const inMenu = await markFields(page, '[role="menu"]')
      for (let field = 0; field < inMenu; field += 1) {
        const box = page.locator(`[role="menu"] [data-sweep="${field}"]`)
        checked.push(`${name} › ${(await readField(box)).label}`)
        const missed = await typeInto(page, box, `${target.name}, the ${name} menu`)
        if (missed) problems.push(missed)
      }
      await closeEverything(page)

      // The items that open a dialog: a New menu's, and any ending in `…`.
      const making = NEW_MENUS.has(name)
      for (const [position, title] of items.entries()) {
        if (!making && !title.endsWith('…')) continue
        if (!(await showMenu(page, trigger))) continue
        const item = openMenu(page).locator('[role^="menuitem"]').nth(position)
        if (!(await item.isEnabled().catch(() => false))) {
          await closeEverything(page)
          continue
        }
        // A file picker is the browser's, not a dialog of ours.
        const chooser = page.waitForEvent('filechooser', { timeout: 600 }).catch(() => undefined)
        await item.click()
        if (await chooser) continue
        const dialog = page.locator('[role="dialog"]:visible').last()
        const opened = await dialog
          .waitFor({ state: 'visible', timeout: 2_000 })
          .then(() => true)
          .catch(() => false)
        if (!opened) continue
        await page.waitForTimeout(300)
        const inDialog = await markFields(page, '[role="dialog"]')
        for (let field = 0; field < inDialog; field += 1) {
          const box = page.locator(`[role="dialog"] [data-sweep="${field}"]`)
          if (!(await box.isVisible().catch(() => false))) continue
          checked.push(`${name} › ${title} › ${(await readField(box)).label}`)
          const missed = await typeInto(page, box, `${target.name}, ${name} › ${title}`)
          if (missed) problems.push(missed)
          // A picker the typing opened closes on a click elsewhere in the dialog.
          await dialog
            .getByRole('heading')
            .first()
            .click({ timeout: 1_000 })
            .catch(() => undefined)
        }
        await closeEverything(page)
      }
    }

    console.log(`${target.name}: ${checked.length} fields: ${checked.join('; ')}`)
    expect(problems, `on ${target.name}`).toEqual([])
  })
}
