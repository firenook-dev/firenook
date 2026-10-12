import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { firestore } from '@/lib/sections/firestore'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { SectionGate, seenBadges } from './section-gate'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const page = () => (
  <SectionGate section="storage">
    <p>the storage page</p>
  </SectionGate>
)

describe('the section gate', () => {
  it('renders the page when the section is ready', async () => {
    await renderInConsole(page, { status: testStatus({ sections: [sectionEntry('storage')] }) })
    expect(screen.getByText('the storage page')).toBeInTheDocument()
  })

  it('says why an absent section is absent, with each fix as a block to copy', async () => {
    const status = testStatus({
      sections: [
        sectionEntry('storage', {
          state: 'absent',
          reason: 'not-configured',
          detail: 'firebase.json does not configure Storage.',
          fixes: [
            {
              label: 'Add it to firebase.json',
              kind: 'firebase-json',
              text: '"emulators": { "storage": {} }',
            },
            { label: 'Or start with Storage', kind: 'command', text: 'firenook emulators:start' },
          ],
        }),
      ],
    })
    await renderInConsole(page, { status })
    expect(screen.queryByText('the storage page')).not.toBeInTheDocument()
    expect(screen.getByText('Storage is not running')).toBeInTheDocument()
    expect(screen.getByText('firebase.json does not configure Storage.')).toBeInTheDocument()
    expect(screen.getByTestId('service-not-running')).toHaveAttribute(
      'data-reason',
      'not-configured',
    )
    expect(screen.getByTestId('fix-firebase-json')).toHaveTextContent(
      '"emulators": { "storage": {} }',
    )
    expect(screen.getByTestId('fix-command')).toHaveTextContent('firenook emulators:start')
    expect(screen.getByText('not running')).toBeInTheDocument()
  })

  it('says something useful about an absent section the engine gave no reason for', async () => {
    const status = testStatus({ sections: [sectionEntry('storage', { state: 'absent' })] })
    await renderInConsole(page, { status })
    expect(screen.getByText('This engine does not run Storage.')).toBeInTheDocument()
    expect(screen.queryByTestId('section-fixes')).not.toBeInTheDocument()
  })

  it('shows a starting section’s wait, and the page once the status says ready', async () => {
    const status = testStatus({
      sections: [sectionEntry('storage', { state: 'starting', detail: 'Indexing the bucket…' })],
    })
    const { client } = await renderInConsole(page, { status })
    expect(screen.getByTestId('service-starting')).toBeInTheDocument()
    expect(screen.getByText('Indexing the bucket…')).toBeInTheDocument()
    act(() => {
      client.setQueryData<ConsoleStatus>(['status'], {
        ...status,
        sections: [sectionEntry('storage')],
      })
    })
    expect(await screen.findByText('the storage page')).toBeInTheDocument()
  })

  it('shows nothing before the engine has said', async () => {
    await renderInConsole(page)
    expect(screen.queryByText('the storage page')).not.toBeInTheDocument()
    expect(screen.queryByTestId('service-not-running')).not.toBeInTheDocument()
  })

  it('takes a section the engine does not list as ready (an older engine)', async () => {
    await renderInConsole(page, { status: testStatus({ sections: [] }) })
    expect(screen.getByText('the storage page')).toBeInTheDocument()
  })
})

describe('which badges a page marks seen', () => {
  it('the section’s own and the open page’s, the longest page path winning', () => {
    expect(seenBadges(firestore, '/firestore/rules')).toEqual([
      'firestore.rules',
      'firestore.denials',
    ])
    expect(seenBadges(firestore, '/firestore')).toEqual([])
    expect(seenBadges(firestore, '/firestore/')).toEqual([])
  })
})
