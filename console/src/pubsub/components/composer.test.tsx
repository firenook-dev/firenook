import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { draftKey, emptyDraft, useComposer } from '../composer-store'
import { Composer } from './composer'

const TOPIC = 'projects/demo/topics/orders'

beforeEach(() => vi.stubGlobal('fetch', () => new Promise<Response>(() => {})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useComposer.setState({ drafts: {} })
})

async function renderComposer() {
  return renderInConsole(
    () => (
      <Composer
        project="demo"
        topic={TOPIC}
        detail={undefined}
        summary={undefined}
        prefill={undefined}
        onClose={() => {}}
        onOpenMessage={() => {}}
      />
    ),
    { status: testStatus({ projectId: 'demo' }) },
  )
}

describe('the composer (U-18)', () => {
  it('turns Publish primary only when the draft can be sent', async () => {
    useComposer
      .getState()
      .set(draftKey('demo', TOPIC), { ...emptyDraft('base64'), data: 'not base64!' })
    await renderComposer()
    const button = screen.getByTestId('composer-publish')
    // The brand fill is a signal: it appears when there is something to send.
    const primary = () => /button-emphasis/.test(button.getAttribute('class') ?? '')
    expect(button).toBeDisabled()
    expect(primary()).toBe(false)
    expect(screen.getByTestId('composer-problems')).toHaveTextContent('This is not base64.')
    const data = screen.getByTestId('composer-data-text')
    await userEvent.clear(data)
    await userEvent.type(data, 'aGVsbG8=')
    expect(button).toBeEnabled()
    expect(primary()).toBe(true)
  })

  it('names the copies it will publish, and refuses more than a thousand', async () => {
    useComposer.getState().set(draftKey('demo', TOPIC), { ...emptyDraft('text'), data: 'hi' })
    await renderComposer()
    const repeat = screen.getByTestId('composer-repeat')
    await userEvent.clear(repeat)
    await userEvent.type(repeat, '20')
    expect(screen.getByTestId('composer-publish')).toHaveTextContent('Publish 20')
    await userEvent.clear(repeat)
    await userEvent.type(repeat, '1001')
    expect(screen.getByTestId('composer-publish')).toBeDisabled()
    expect(screen.getByText('Repeat 1 to 1,000 copies.')).toBeInTheDocument()
  })

  it('warns in amber about what production would refuse, without blocking', async () => {
    useComposer.getState().set(draftKey('demo', TOPIC), {
      ...emptyDraft('text'),
      data: 'hi',
      attributes: [{ id: 'a', key: 'goog-trace', value: '1', enabled: true }],
    })
    await renderComposer()
    expect(screen.getByTestId('composer-limit')).toHaveTextContent(
      'Attribute goog-trace: Production refuses a key that starts with goog.',
    )
    expect(screen.getByTestId('composer-publish')).toBeEnabled()
  })
})
