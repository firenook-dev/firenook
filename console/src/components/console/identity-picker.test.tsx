import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IdentityUser } from '@/api/generated/IdentityUser'
import type { ViewAs } from '@/lib/identity'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { IdentityPicker, parseClaims } from './identity-picker'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const user = (uid: string, email: string | null, tenant: string | null = null): IdentityUser => ({
  uid,
  tenant,
  email,
  displayName: null,
  disabled: false,
  emailVerified: true,
  providers: ['password'],
  claims: null,
})

/** The engine's identity route, answering `users` for any search; every request is kept. */
function engine(answer: (url: URL) => Response) {
  const requests: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://console.test')
      requests.push(url)
      return answer(url)
    }),
  )
  return requests
}

const page = (items: IdentityUser[]) =>
  new Response(
    JSON.stringify({ items, nextCursor: null, prevCursor: null, total: null, scanned: null }),
    {
      headers: { 'content-type': 'application/json' },
    },
  )

function picker(value: ViewAs = { kind: 'owner' }, onChange = vi.fn()) {
  return {
    onChange,
    ui: () => (
      <IdentityPicker project="demo-console" value={value} onChange={onChange} testId="who" />
    ),
  }
}

const ready = testStatus({ sections: [sectionEntry('firestore'), sectionEntry('auth')] })

describe('the identity picker', () => {
  it('offers the owner, an anonymous client, the Auth users of every tenant and a custom identity', async () => {
    const requests = engine(() =>
      page([user('u_1', 'ada@example.test'), user('u_2', null, 'acme')]),
    )
    const { ui, onChange } = picker()
    await renderInConsole(ui, { status: ready })
    expect(screen.getByTestId('who')).toHaveTextContent('Admin')
    await userEvent.click(screen.getByTestId('who'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Admin (bypasses rules)')).toBeInTheDocument()
    expect(within(menu).getByText('Anonymous client')).toBeInTheDocument()
    expect(within(menu).getByText('Custom identity…')).toBeInTheDocument()
    await within(menu).findByText('ada@example.test')
    // A tenant's user says which tenant.
    expect(within(menu).getByText('u_2 · acme')).toBeInTheDocument()
    const asked = requests.find((url) => url.pathname === '/console/api/v1/auth/identities')
    expect(asked?.searchParams.get('q')).toBe('')
    expect(asked?.searchParams.get('limit')).toBe('20')
    expect(asked?.searchParams.has('tenant')).toBe(false)
    await userEvent.click(within(menu).getByText('u_2 · acme'))
    expect(onChange).toHaveBeenCalledWith({ kind: 'user', uid: 'u_2', tenant: 'acme' })
  })

  it('searches on the engine once there are more users than a menu should list', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      user(`u_${index}`, `user${index}@example.test`),
    )
    const requests = engine((url) =>
      page(url.searchParams.get('q') ? [user('u_ada', 'ada@example.test')] : many),
    )
    const { ui, onChange } = picker()
    await renderInConsole(ui, { status: ready })
    await userEvent.click(screen.getByTestId('who'))
    const search = await screen.findByTestId('who-search')
    // Eight shown; the rest are a search away.
    expect(screen.getAllByTestId('who-user')).toHaveLength(8)
    expect(screen.getByText('More users: search to find one.')).toBeInTheDocument()
    await userEvent.type(search, 'ada')
    await screen.findByText('ada@example.test')
    expect(requests.some((url) => url.searchParams.get('q') === 'ada')).toBe(true)
    await userEvent.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ kind: 'user', uid: 'u_ada', email: 'ada@example.test' })
  })

  it('says why there are no users when Authentication is not running, and asks nothing', async () => {
    const requests = engine(() => page([]))
    const { ui } = picker({ kind: 'anonymous' })
    await renderInConsole(ui, {
      status: testStatus({
        sections: [sectionEntry('auth', { state: 'absent', reason: 'not-configured' })],
      }),
    })
    await userEvent.click(screen.getByTestId('who'))
    expect(await screen.findByTestId('who-no-auth')).toHaveTextContent(
      'Authentication is not running, so there are no users to pick; a custom identity still works.',
    )
    expect(requests.filter((url) => url.pathname.endsWith('/auth/identities'))).toHaveLength(0)
  })

  it("shows the engine's error instead of an empty list", async () => {
    engine(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'internal', message: 'The identity search failed.' } }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )
    const { ui } = picker()
    await renderInConsole(ui, { status: ready })
    await userEvent.click(screen.getByTestId('who'))
    expect(await screen.findByTestId('who-error')).toHaveTextContent('The identity search failed.')
    expect(screen.queryByText(/No Auth users yet/)).not.toBeInTheDocument()
  })

  it('makes a custom identity from a uid, an email and a provider', async () => {
    engine(() => page([]))
    const { ui, onChange } = picker()
    await renderInConsole(ui, { status: ready })
    await userEvent.click(screen.getByTestId('who'))
    await userEvent.click(await screen.findByTestId('who-custom'))
    const dialog = await screen.findByTestId('who-custom-dialog')
    const use = within(dialog).getByTestId('who-custom-dialog-use')
    expect(use).toBeDisabled()
    await userEvent.type(within(dialog).getByTestId('who-custom-dialog-uid'), 'tester')
    await userEvent.type(
      within(dialog).getByTestId('who-custom-dialog-email'),
      'tester@example.test',
    )
    await waitFor(() => expect(use).toBeEnabled())
    await userEvent.click(use)
    expect(onChange).toHaveBeenCalledWith({
      kind: 'custom',
      uid: 'tester',
      claims: {},
      signInProvider: 'custom',
      emailVerified: false,
      email: 'tester@example.test',
    })
  })

  it('names a custom identity and a user it was linked to in the trigger', async () => {
    engine(() => page([]))
    await renderInConsole(picker({ kind: 'custom', uid: 'tester', claims: { admin: true } }).ui, {
      status: ready,
    })
    expect(screen.getByTestId('who')).toHaveTextContent('tester')
    expect(screen.getByTestId('who')).toHaveAttribute('data-kind', 'custom')
  })

  it('reads claims as a JSON object and says what is wrong with anything else', () => {
    expect(parseClaims('')).toEqual({ claims: {} })
    expect(parseClaims('{"admin": true}')).toEqual({ claims: { admin: true } })
    expect(parseClaims('[1]')).toEqual({
      error: 'Claims are a JSON object, such as {"admin": true}.',
    })
    expect('error' in parseClaims('{nope')).toBe(true)
  })
})
