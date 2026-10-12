import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { RequiresNotice } from './requires-notice'

afterEach(cleanup)

const withFunctions = (state: 'ready' | 'starting' | 'absent') =>
  testStatus({
    sections: [
      sectionEntry('functions', {
        state,
        ...(state === 'absent'
          ? {
              reason: 'not-configured' as const,
              detail: 'firebase.json configures no Functions codebase.',
              fixes: [
                {
                  kind: 'firebase-json' as const,
                  label: 'Add to firebase.json',
                  text: '{ "functions": [{ "source": "functions" }] }',
                },
              ],
            }
          : {}),
      }),
    ],
  })

describe('a feature that needs another section', () => {
  it('says nothing while that section runs', async () => {
    await renderInConsole(() => <RequiresNotice section="functions" for="Sending events" />, {
      status: withFunctions('ready'),
    })
    expect(screen.queryByTestId('requires-functions')).toBeNull()
  })

  it('names the section as a link to its page, absent or starting', async () => {
    const absent = await renderInConsole(
      () => <RequiresNotice section="functions" for="Sending events" />,
      { status: withFunctions('absent') },
    )
    expect(screen.getByTestId('requires-functions').textContent).toContain(
      'Sending events needs Functions, which this engine does not run.',
    )
    expect(screen.getByTestId('requires-functions-section').getAttribute('href')).toBe('/functions')
    expect(screen.getByTestId('requires-functions-how')).toBeTruthy()
    absent.unmount()
    await renderInConsole(() => <RequiresNotice section="functions" for="Sending events" />, {
      status: withFunctions('starting'),
    })
    expect(screen.getByTestId('requires-functions').textContent).toContain(
      'Sending events needs Functions, which is starting; it works as soon as it is up.',
    )
    expect(screen.getByTestId('requires-functions-section').getAttribute('href')).toBe('/functions')
  })
})
