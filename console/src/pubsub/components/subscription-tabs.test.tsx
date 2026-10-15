// U-18 for a subscription's tabs: `p` pauses and resumes the Push feed, and
// row two's end names the endpoint.

import { act, cleanup, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchShortcut } from '@/lib/shortcuts'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { createPushStore } from '../live'
import { PushEnd } from './push-feed'

const SUBSCRIPTION = 'projects/demo/subscriptions/orders-worker'

// The live channel's leader opens the console's one stream a tick after a
// page subscribes, which may be after the test has finished; jsdom has no
// EventSource, so a quiet one stands in for the whole file (nothing here
// asserts a live event).
class QuietEventSource {
  readyState = 0
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const live = globalThis as { EventSource?: unknown }
live.EventSource ??= QuietEventSource

beforeEach(() => vi.stubGlobal('fetch', () => new Promise<Response>(() => {})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The shell's one listener hands each key to the registry. */
function press(key: string) {
  act(() => {
    dispatchShortcut(new KeyboardEvent('keydown', { key }))
  })
}

function PushEndHarness({ store }: { store: ReturnType<typeof createPushStore> }) {
  const [paused, setPaused] = useState(false)
  return (
    <PushEnd
      project="demo"
      subscription={SUBSCRIPTION}
      endpoint="http://localhost:9000/hook"
      store={store}
      paused={paused}
      onPausedChange={setPaused}
    />
  )
}

describe('the Push feed’s pause (U-18)', () => {
  it('p pauses the feed and p resumes it', async () => {
    const store = createPushStore()
    await renderInConsole(() => <PushEndHarness store={store} />, {
      status: testStatus({ projectId: 'demo' }),
    })
    const button = screen.getByTestId('pubsub-push-pause')
    expect(button).toHaveTextContent('Pause')
    press('p')
    expect(button).toHaveTextContent('Paused')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    press('p')
    expect(button).toHaveTextContent(/^Pause$/)
    expect(screen.getByTestId('push-endpoint')).toHaveTextContent('http://localhost:9000/hook')
  })
})
