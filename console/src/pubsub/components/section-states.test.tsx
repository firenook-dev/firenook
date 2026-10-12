import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SectionFrame } from '@/components/console/section-gate'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'

// Pub/Sub's pages (Topics, Schemas, Schedules) sit in the section's frame:
// before the engine runs Pub/Sub nothing of the page renders and nothing
// asks the service; the frame says why and how to turn it on, or what it
// waits for, in the engine's own sentences.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const page = () => (
  <SectionFrame section="pubsub">
    <p>the topics page</p>
  </SectionFrame>
)

describe('the Pub/Sub section states (U-18)', () => {
  it('say Pub/Sub is not running, why, and the command that starts it', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const status = testStatus({
      sections: [
        sectionEntry('pubsub', {
          state: 'absent',
          reason: 'excluded-by-only',
          detail: 'Pub/Sub is configured in firebase.json, but --only left it out.',
          fixes: [
            {
              label: 'Start with Pub/Sub',
              kind: 'command',
              text: 'firenook emulators:start --only firestore,pubsub',
            },
          ],
        }),
      ],
    })
    await renderInConsole(page, { status })
    expect(screen.queryByText('the topics page')).not.toBeInTheDocument()
    expect(screen.getByTestId('service-not-running')).toHaveTextContent('Pub/Sub is not running')
    expect(
      screen.getByText('Pub/Sub is configured in firebase.json, but --only left it out.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('fix-command')).toHaveTextContent(
      'firenook emulators:start --only firestore,pubsub',
    )
  })

  it('wait for Functions discovery while starting, then fill in', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const status = testStatus({
      sections: [
        sectionEntry('pubsub', {
          state: 'starting',
          detail:
            'Waiting for Functions discovery. Pub/Sub starts once the functions that listen on topics are known.',
        }),
      ],
    })
    const { client } = await renderInConsole(page, { status })
    expect(screen.getByTestId('service-starting')).toHaveTextContent(
      'Pub/Sub starts once the functions that listen on topics are known.',
    )
    expect(screen.queryByText('the topics page')).not.toBeInTheDocument()
    act(() => client.setQueryData(['status'], { ...status, sections: [sectionEntry('pubsub')] }))
    expect(await screen.findByText('the topics page')).toBeInTheDocument()
  })
})
