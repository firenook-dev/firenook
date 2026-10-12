import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForeignProject } from '@/api/generated/ForeignProject'
import { useLiveStatus } from '@/lib/live/channel'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { ShellBanners, foreignToShow } from './shell-banners'

const myProd: ForeignProject = {
  projectId: 'my-prod',
  services: ['firestore'],
  firstSeen: '2026-01-01T00:00:00Z',
  requests: 3,
}
const staging: ForeignProject = { ...myProd, projectId: 'my-staging' }

const functionsRunning = [
  { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
]

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  useLiveStatus.setState({ engineUpdated: false })
})

describe('the suite-wide banners', () => {
  it('say nothing when nothing suite-wide is true', async () => {
    await renderInConsole(() => <ShellBanners section="firestore" />, { status: testStatus() })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('say background triggers are paused, with Resume, only where functions run', async () => {
    const paused = {
      backgroundTriggers: { enabled: false, since: '2026-01-01T00:00:00Z', dropped: [] },
    }
    await renderInConsole(() => <ShellBanners section="firestore" />, {
      status: testStatus({ ...paused, services: functionsRunning }),
    })
    expect(screen.getByTestId('banner-triggers-paused')).toHaveTextContent(
      'Background triggers are paused, so events are dropped, not queued.',
    )
    expect(screen.getByTestId('resume-triggers')).toBeInTheDocument()
    cleanup()
    await renderInConsole(() => <ShellBanners section="firestore" />, {
      status: testStatus(paused),
    })
    expect(screen.queryByTestId('banner-triggers-paused')).not.toBeInTheDocument()
  })

  it('name the project the app uses, and offer to show it where the page can', async () => {
    const status = testStatus({ projectId: 'demo-x', foreignProjects: [myProd, staging] })
    await renderInConsole(() => <ShellBanners section="firestore" />, { status })
    expect(screen.getByTestId('banner-foreign-project')).toHaveTextContent(
      'Your app is using project my-prod (and 1 other); this emulator is demo-x, so its data is not shown here.',
    )
    expect(screen.getByTestId('foreign-show')).toHaveTextContent('Show my-prod')
  })

  it('offer how to fix it where the page cannot show another project', async () => {
    const status = testStatus({ projectId: 'demo-x', foreignProjects: [myProd] })
    await renderInConsole(() => <ShellBanners section="storage" />, { status })
    expect(screen.getByTestId('foreign-how')).toBeInTheDocument()
    expect(screen.queryByTestId('foreign-show')).not.toBeInTheDocument()
  })

  it('put the project banner away until a new project appears', async () => {
    const status = testStatus({ projectId: 'demo-x', foreignProjects: [myProd] })
    await renderInConsole(() => <ShellBanners section="firestore" />, { status })
    await userEvent.click(screen.getByTestId('banner-foreign-project-dismiss'))
    expect(screen.queryByTestId('banner-foreign-project')).not.toBeInTheDocument()
    cleanup()
    await renderInConsole(() => <ShellBanners section="firestore" />, { status })
    expect(screen.queryByTestId('banner-foreign-project')).not.toBeInTheDocument()
    cleanup()
    await renderInConsole(() => <ShellBanners section="firestore" />, {
      status: { ...status, foreignProjects: [staging, myProd] },
    })
    expect(screen.getByTestId('banner-foreign-project')).toHaveTextContent('my-staging')
  })

  it('say when another project is on screen, with the way back', async () => {
    const status = testStatus({ projectId: 'demo-x', foreignProjects: [myProd] })
    await renderInConsole(() => <ShellBanners section="firestore" />, {
      status,
      path: '/firestore?project=my-prod',
    })
    expect(screen.getByTestId('banner-foreign-view')).toHaveTextContent('Showing project my-prod')
    expect(screen.getByTestId('foreign-back')).toHaveTextContent('Back to demo-x')
  })

  it('ask for a reload when the engine was updated, which cannot be put away', async () => {
    await renderInConsole(() => <ShellBanners section="firestore" />, { status: testStatus() })
    act(() => useLiveStatus.setState({ engineUpdated: true }))
    expect(screen.getByTestId('banner-engine-updated')).toHaveTextContent(
      'The engine was updated. Reload to get its console.',
    )
    expect(screen.queryByTestId('banner-engine-updated-dismiss')).not.toBeInTheDocument()
  })
})

describe('which foreign project the banner names', () => {
  it('the newest one not put away', () => {
    expect(foreignToShow([staging, myProd], [])).toBe(staging)
    expect(foreignToShow([staging, myProd], ['my-staging'])).toBe(myProd)
    expect(foreignToShow([myProd], ['my-prod'])).toBeUndefined()
  })
})
