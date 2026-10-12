import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { functions as functionsSection } from '@/lib/sections/functions'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { whileUnbuilt } from '@/test/unbuilt'
import { UnbuiltSection } from './section-placeholder'

afterEach(cleanup)

describe('a running section that is not built yet', () => {
  // Every section is built today, so no engine can show this page; a
  // section held back here stands in for the next one to land.
  it('keeps its honest placeholder behind a gate that lets it through', async () => {
    await whileUnbuilt(functionsSection, () =>
      renderInConsole(() => <UnbuiltSection section={functionsSection} />, {
        status: testStatus({ sections: [sectionEntry('functions')] }),
      }),
    )
    expect(screen.getByRole('heading', { name: 'Functions' })).toBeInTheDocument()
    expect(screen.getByText('This section is not built yet')).toBeInTheDocument()
    expect(screen.getByText('running', { exact: true })).toBeInTheDocument()
    expect(screen.queryByTestId('service-not-running')).not.toBeInTheDocument()
  })

  it('still says why when the engine does not run it', async () => {
    await whileUnbuilt(functionsSection, () =>
      renderInConsole(() => <UnbuiltSection section={functionsSection} />, {
        status: testStatus({
          sections: [sectionEntry('functions', { state: 'absent', reason: 'not-configured' })],
        }),
      }),
    )
    expect(screen.getByTestId('service-not-running')).toBeInTheDocument()
    expect(screen.queryByText('This section is not built yet')).not.toBeInTheDocument()
  })
})
