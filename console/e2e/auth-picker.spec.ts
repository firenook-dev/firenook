import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { batchCreate, scratchTenant } from './support/auth'

// The account picker a federated sign-in opens (`crates/auth-front/src/
// oauth-handler.html`). It is served from the Auth port with no console build
// behind it, so it restates the console's light tokens instead of importing
// them; this holds the two together, measured as each page paints them. It is
// light whatever the system's mode, as the official page is. It also holds the
// page's own contrast and the shape it keeps in a popup and on a phone. Signing in through it, with the real SDK, is
// `conformance/test/auth-popup.test.mjs`.

/** A console token and the page's name for it. */
const TOKENS = [
  ['--color-kumo-canvas', '--canvas'],
  ['--color-kumo-base', '--base'],
  ['--color-kumo-tint', '--tint'],
  ['--color-kumo-recessed', '--recessed'],
  ['--color-kumo-control', '--control'],
  ['--color-kumo-line', '--line'],
  ['--color-kumo-hairline', '--hairline'],
  ['--color-kumo-focus', '--focus'],
  ['--color-kumo-danger', '--danger-ring'],
  ['--color-kumo-danger-tint', '--danger-tint'],
  ['--color-kumo-brand', '--brand'],
  ['--color-firenook-hover', '--hover'],
  ['--color-firenook-wordmark', '--wordmark'],
  ['--text-color-kumo-default', '--text'],
  ['--text-color-kumo-strong', '--strong'],
  ['--text-color-kumo-subtle', '--subtle'],
  ['--text-color-kumo-placeholder', '--placeholder'],
  ['--text-color-kumo-danger', '--danger'],
] as const

/** Each CSS colour as the browser paints it over white, in sRGB: two spellings of one colour compare equal. */
function paint(page: Page, colors: readonly string[]) {
  return page.evaluate(`(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    return ${JSON.stringify(colors)}.map((color) => {
      const probe = document.createElement('div')
      probe.style.color = color
      document.body.append(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      context.fillStyle = '#fff'
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = resolved
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
    })
  })()`) as Promise<number[][]>
}

const painted = (page: Page, names: readonly string[]) =>
  paint(
    page,
    names.map((name) => `var(${name})`),
  )

/** A colour's relative luminance (WCAG 2). */
function luminance(rgb: number[]) {
  const [r = 0, g = 0, b = 0] = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG 2 contrast of two sRGB colours. */
function contrast(one: number[], other: number[]) {
  const [hi = 0, lo = 0] = [luminance(one), luminance(other)].toSorted((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

/** The picker for Google, in a tenant when a journey has seeded one. */
const pickerUrl = (authPort: number | undefined, tenant?: string, provider = 'google.com') =>
  `http://127.0.0.1:${authPort}/emulator/auth/handler?apiKey=fake-api-key&appName=journey&authType=signInViaPopup&eventId=1&providerId=${provider}${tenant ? `&tid=${tenant}` : ''}`

/** `count` accounts on Google, for a scratch tenant. */
const googleUsers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    localId: `picker-${index}`,
    providerUserInfo: [
      {
        providerId: 'google.com',
        rawId: `picker-${index}`,
        email: `person.${index}@journey.test`,
        displayName: `Person ${index}`,
      },
    ],
  }))

test("the picker paints the console's light colours, and reads", async ({ page, engine }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${engine.origin}/console`)
  await expect(page.getByTestId('top-bar')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  const consoleColors = await painted(
    page,
    TOKENS.map(([name]) => name),
  )
  const picker = await page.context().newPage()
  await picker.goto(pickerUrl(engine.ports.auth))
  const pickerColors = await painted(
    picker,
    TOKENS.map(([, name]) => name),
  )
  TOKENS.forEach(([name, own], index) => {
    const [theirs, ours] = [consoleColors[index] ?? [], pickerColors[index] ?? []]
    const apart = Math.max(...theirs.map((value, at) => Math.abs(value - (ours[at] ?? 0))))
    expect(
      apart,
      `${own} against ${name}: ${ours.join()} and ${theirs.join()}`,
    ).toBeLessThanOrEqual(1)
  })

  const [canvas = [], base = [], control = [], text = [], subtle = [], placeholder = []] =
    await painted(picker, [
      '--canvas',
      '--base',
      '--control',
      '--text',
      '--subtle',
      '--placeholder',
    ])
  for (const [what, ink, ground] of [
    ['a name on a row', text, base],
    ['an email on a row', subtle, base],
    ['the words under the title', subtle, canvas],
    ['the foot of the page', subtle, canvas],
    ['the bar, its kind', subtle, base],
    ['a filter hint', placeholder, control],
  ] as const) {
    expect(contrast(ink, ground), what).toBeGreaterThanOrEqual(4.5)
  }
  await picker.close()
})

test('the picker stays light when the system is dark', async ({ page, engine }) => {
  const names = TOKENS.map(([, name]) => name)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(pickerUrl(engine.ports.auth))
  const light = await painted(page, names)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  expect(await painted(page, names)).toEqual(light)
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
  await expect(page.locator('body')).toHaveCSS('background-color', 'oklch(0.9875 0 0)')
})

test('the picker is the console: its logo, its faces and a provider by name', async ({
  page,
  engine,
}) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('data:')) requests.push(request.url())
  })
  await page.goto(pickerUrl(engine.ports.auth))
  await page.evaluate('document.fonts.ready.then(() => true)')
  await expect(page.getByRole('heading', { name: 'Sign in with Google' })).toBeVisible()
  await expect(page).toHaveTitle('Sign in with Google · Firenook Auth Emulator')
  await expect(page.locator('#project')).toHaveText(engine.project)

  // The wordmark draws as well as the flames.
  const logo = (await page.evaluate(`(() => {
    const svg = document.querySelector('header .logo')
    return { width: svg.getBBox().width, height: svg.getBoundingClientRect().height }
  })()`)) as { width: number; height: number }
  expect(logo.width).toBeGreaterThan(2000)
  expect(logo.height).toBe(24)

  const faces = (await page.evaluate(`[
    document.fonts.check('14px InterVariable'),
    document.fonts.check("13px 'IBM Plex Mono'"),
    getComputedStyle(document.querySelector('h1')).fontFamily,
  ]`)) as [boolean, boolean, string]
  expect(faces[0]).toBe(true)
  expect(faces[1]).toBe(true)
  expect(faces[2]).toContain('InterVariable')
  // Everything is in the page: it asks for itself and nothing else.
  expect(requests).toEqual([pickerUrl(engine.ports.auth)])

  await page.goto(pickerUrl(engine.ports.auth, undefined, 'saml.acme'))
  await expect(page.getByRole('heading', { name: 'Sign in with SAML (saml.acme)' })).toBeVisible()
})

test('no accounts yet: it says so, and the two ways to make one are there', async ({
  page,
  engine,
}) => {
  await page.goto(pickerUrl(engine.ports.auth, undefined, 'yahoo.com'))
  await expect(page.getByText('No Yahoo accounts yet')).toBeVisible()
  await expect(page.locator('#accounts')).toBeHidden()
  await expect(page.locator('#search')).toBeHidden()
  await expect(page.getByRole('button', { name: 'New random user' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add account' })).toBeVisible()
})

test('a long list scrolls inside the page, and is filtered, in a popup and on a phone', async ({
  browser,
  engine,
}) => {
  const scratch = await scratchTenant(engine)
  const tenant = scratch.id
  try {
    await batchCreate(engine, googleUsers(30), tenant)
    for (const [width, height, hasTouch] of [
      [500, 600, false],
      [390, 844, true],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch })
      const page = await context.newPage()
      await page.goto(pickerUrl(engine.ports.auth, tenant))
      await expect(page.locator('.js-reuse-account')).toHaveCount(30)
      await expect(page.locator('#account-filter')).toBeVisible()

      // The window never scrolls: the list does, with the buttons in view under it.
      const shape = await page.evaluate(`(() => {
        const root = document.documentElement
        const list = document.getElementById('accounts')
        const action = document.querySelector('.js-random-account')
        return {
          windowScrolls: root.scrollHeight > innerHeight || root.scrollWidth > innerWidth,
          listScrolls: list.scrollHeight > list.clientHeight,
          actionsInView: action.getBoundingClientRect().bottom <= innerHeight,
        }
      })()`)
      expect(shape).toEqual({ windowScrolls: false, listScrolls: true, actionsInView: true })

      await page.locator('#account-filter').fill('person.17')
      await expect(page.locator('.js-reuse-account:visible')).toHaveCount(1)
      await expect(page.locator('.js-reuse-account:visible')).toContainText('Person 17')
      await page.locator('#account-filter').fill('nobody')
      await expect(page.locator('.js-reuse-account:visible')).toHaveCount(0)
      await expect(page.getByText('No account matches.')).toBeVisible()
      await context.close()
    }
  } finally {
    await scratch.remove()
  }
})

test('the form says what an email lacks, fills itself in and goes back', async ({
  page,
  engine,
}) => {
  await page.setViewportSize({ width: 500, height: 600 })
  await page.goto(pickerUrl(engine.ports.auth))
  await page.locator('.js-new-account').click()
  const email = page.locator('#email-input')
  await expect(email).toBeFocused()
  await expect(page.getByRole('heading', { name: 'New Google account' })).toBeVisible()

  await page.locator('#sign-in').click()
  await expect(page.locator('#email-error')).toHaveText('Email required')
  await expect(email).toHaveAttribute('aria-invalid', 'true')
  await email.fill('nobody')
  await expect(page.locator('#email-error')).toHaveText('')
  await page.locator('#sign-in').click()
  await expect(page.locator('#email-error')).toHaveText('Missing "@"')

  await page.locator('#autogen-button').click()
  await expect(page.locator('#email-error')).toHaveText('')
  await expect(email).toHaveValue(/^[a-z]+\.[a-z]+\.\d{5}@example\.test$/)
  await expect(page.locator('#display-name-input')).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-zA-Z]+$/)
  await expect(page.locator('#screen-name-input')).toHaveValue(/^[a-z]+_[a-z]+$/)

  await email.press('Escape')
  await expect(page.locator('#main-form')).toBeHidden()
  await expect(page.locator('.js-new-account')).toBeFocused()
})
