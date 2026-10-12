import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInConsole } from '@/test/render'
import { auth } from '@/lib/sections/auth'
import { sectionEntry, testStatus } from '@/test/status'
import { whileUnbuilt } from '@/test/unbuilt'
import { EntityLink } from './entity-link'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const doc = { kind: 'firestore.document', key: '(default)|users/u_1', label: 'users/u_1' }

describe('an entity link', () => {
  it('opens through the target section’s routes', async () => {
    await renderInConsole(() => <EntityLink entity={doc} testId="ref" />, {
      status: testStatus({ sections: [sectionEntry('firestore')] }),
    })
    const link = screen.getByRole('link', { name: 'users/u_1' })
    expect(link.getAttribute('href')).toBe('/firestore?path=users&doc=users%2Fu_1')
  })

  it('is plain text while its section is absent or not built', async () => {
    await renderInConsole(() => <EntityLink entity={doc} testId="ref" />, {
      status: testStatus({ sections: [sectionEntry('firestore', { state: 'absent' })] }),
    })
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref')).toHaveTextContent('users/u_1')
    cleanup()
    await whileUnbuilt(auth, async () => {
      await renderInConsole(
        () => <EntityLink entity={{ kind: 'auth.user', key: 'u_9f3k2' }} testId="user" />,
        { status: testStatus({ sections: [sectionEntry('auth')] }) },
      )
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.getByTestId('user')).toHaveTextContent('u_9f3k2')
    })
  })

  it('copies what it shows', async () => {
    const user = userEvent.setup()
    await renderInConsole(
      () => <EntityLink entity={{ kind: 'auth.user', key: 'u_9f3k2' }} testId="user" />,
      { status: testStatus() },
    )
    await user.click(screen.getByTestId('user-copy'))
    expect(await navigator.clipboard.readText()).toBe('u_9f3k2')
  })
})
