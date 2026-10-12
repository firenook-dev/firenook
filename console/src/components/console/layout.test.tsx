// The layout pieces: the page column, the toolbar rows and field, the panel
// head and filter, the subscription notice, the scope picker, and the
// empty, no-match, error and loading states.

import { DatabaseIcon } from '@phosphor-icons/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { EmptyState, NoMatch, QueryError, TableSkeleton, useDelayedFlag } from './empty-state'
import { LiveNotice, liveNoticeText } from './live-notice'
import { PanelFilter } from './panel'
import { ScopeSelect } from './scope-select'
import { SectionFrame } from './section-gate'
import { SectionBody, SectionPage } from './section-page'
import { SectionToolbar, ToolbarDivider, ToolbarField, ToolbarRow } from './toolbar'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const paused = (overrides: Partial<ConsoleStatus> = {}) =>
  testStatus({
    sections: [sectionEntry('auth')],
    backgroundTriggers: { enabled: false, since: null, dropped: [] },
    services: [{ name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null }],
    ...overrides,
  })

describe('SectionPage', () => {
  it('is the page column with its name for assistive technology', async () => {
    await renderInConsole(
      () => (
        <SectionFrame section="auth">
          <SectionPage
            section="auth"
            page="users"
            title="Authentication · Users"
            testId="auth-page"
          >
            <SectionBody testId="body">rows</SectionBody>
          </SectionPage>
        </SectionFrame>
      ),
      { status: paused() },
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Authentication · Users' })).toHaveClass(
      'sr-only',
    )
    expect(screen.getByTestId('auth-page')).toHaveAttribute('data-page', 'users')
    expect(screen.getByTestId('body')).toHaveClass('relative', 'flex', 'min-h-0', 'flex-1')
    // The frame draws the suite's banners once; the page inside it does not again.
    expect(screen.getAllByTestId('banner-triggers-paused')).toHaveLength(1)
  })

  it('draws the suite’s banners itself when no frame is above it', async () => {
    await renderInConsole(
      () => (
        <SectionPage section="auth" title="Users" testId="auth-page">
          rows
        </SectionPage>
      ),
      { status: paused() },
    )
    expect(screen.getAllByTestId('banner-triggers-paused')).toHaveLength(1)
  })
})

describe('the toolbar', () => {
  it('lays a selection over row two without moving it, and keeps row one at 44 px', () => {
    render(
      <SectionToolbar testId="toolbar">
        <ToolbarRow testId="row-one">
          scope
          <ToolbarDivider />
          <button type="button">New</button>
        </ToolbarRow>
        <ToolbarRow
          variant="line"
          testId="row-two"
          below={<p>Unknown filter "foo:".</p>}
          overlay={<div data-testid="overlay">3 selected</div>}
        >
          <input aria-label="Filter" />
        </ToolbarRow>
      </SectionToolbar>,
    )
    expect(screen.getByTestId('row-one')).toHaveClass('h-11')
    const line = screen.getByTestId('row-two')
    expect(line.parentElement).toHaveAttribute('inert')
    expect(screen.getByTestId('overlay')).toBeInTheDocument()
    expect(line).toHaveTextContent('Unknown filter "foo:".')
  })

  it('draws the field flat at rest, and ringed in danger when what it holds is invalid', () => {
    const { rerender } = render(
      <ToolbarField testId="field" trailing={<button type="button">Copy</button>}>
        path
      </ToolbarField>,
    )
    expect(screen.getByTestId('field').className).not.toContain('ring-kumo-danger')
    expect(screen.getByTestId('field').className).toContain('focus-within:ring')
    rerender(
      <ToolbarField testId="field" invalid>
        path
      </ToolbarField>,
    )
    expect(screen.getByTestId('field')).toHaveClass('ring-kumo-danger')
    expect(screen.getByTestId('field')).toHaveAttribute('data-invalid')
  })
})

function Filter() {
  const [value, setValue] = useState('ord')
  return <PanelFilter value={value} onChange={setValue} placeholder="Filter queues" />
}

function Flag({ on }: { on: boolean }) {
  return <span data-testid="flag">{String(useDelayedFlag(on, 100))}</span>
}

describe('PanelFilter', () => {
  it('clears with its × and with Escape', () => {
    render(<Filter />)
    const input = screen.getByRole('textbox', { name: 'Filter queues' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter' }))
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'em' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
  })
})

describe('LiveNotice', () => {
  it('says nothing while the subscription is live, and says when it stopped, with Retry', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<LiveNotice status="live" what="the users" onRetry={onRetry} />)
    expect(screen.queryByTestId('live-notice')).toBeNull()
    rerender(<LiveNotice status="connecting" what="the users" onRetry={onRetry} />)
    expect(screen.queryByTestId('live-notice')).toBeNull()
    rerender(<LiveNotice status="ended" what="the users" onRetry={onRetry} />)
    expect(screen.getByTestId('live-notice')).toHaveAttribute('data-state', 'ended')
    fireEvent.click(screen.getByTestId('live-notice-retry'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('words the tooltip with the engine’s own reason', () => {
    expect(liveNoticeText('ended', 'the users', 'Auth stopped')).toBe(
      'Live updates for the users stopped, so what is on screen may be out of date. Auth stopped. The console retries by itself; Retry asks now.',
    )
    expect(liveNoticeText('refused', 'this bucket', undefined)).toBe(
      'The engine refused live updates for this bucket, so what is on screen may be out of date.',
    )
  })
})

describe('ScopeSelect', () => {
  it('names itself inside the box and keeps the value on screen in its list', () => {
    render(
      <ScopeSelect
        label="Bucket"
        value="gone.appspot.com"
        items={[{ value: 'demo.appspot.com', detail: '12 objects' }]}
        onChange={() => {}}
        testId="bucket"
      />,
    )
    const box = screen.getByRole('combobox', { name: 'Bucket' })
    expect(box).toHaveTextContent('Bucket')
    expect(box).toHaveTextContent('gone.appspot.com')
  })
})

describe('the empty, no-match, error and loading states', () => {
  const running = testStatus({
    sections: [sectionEntry('auth')],
    services: [{ name: 'auth', host: '127.0.0.1', port: 9099, listening: true, pid: null }],
  })

  it('teaches how things get here from the app, with this engine’s address, then the console’s way', async () => {
    await renderInConsole(
      () => (
        <EmptyState
          icon={DatabaseIcon}
          title="No users yet"
          description="Users appear when your app signs someone up."
          connect={{ service: 'auth' }}
          actions={<button type="button">Add user</button>}
        />
      ),
      { status: running },
    )
    expect(screen.getByText('No users yet')).toBeInTheDocument()
    const block = screen.getByTestId('empty-state-connect')
    expect(block).toHaveTextContent('127.0.0.1:9099')
    expect(screen.getByRole('button', { name: 'Add user' })).toBeInTheDocument()
  })

  it('says the app is writing to another project when the engine has seen it', async () => {
    await renderInConsole(
      () => <EmptyState icon={DatabaseIcon} title="No users yet" connect={{ service: 'auth' }} />,
      {
        status: {
          ...running,
          foreignProjects: [
            {
              projectId: 'my-prod',
              services: ['auth'],
              firstSeen: '2026-10-12T00:00:00Z',
              requests: 3,
            },
          ],
        },
      },
    )
    expect(screen.getByTestId('empty-state-foreign')).toHaveTextContent(
      'Your app is using project my-prod; this emulator is demo-console',
    )
  })

  it('names the filter that matched nothing, with the way out', () => {
    const onClear = vi.fn()
    render(<NoMatch filter="provider:google -is:disabled" onClear={onClear} noun="users" />)
    expect(screen.getByText('No users match')).toBeInTheDocument()
    expect(screen.getByText('provider:google -is:disabled')).toHaveClass('font-mono')
    fireEvent.click(screen.getByTestId('no-match-clear'))
    expect(onClear).toHaveBeenCalled()
  })

  it('shows the engine’s message and fix with Retry', async () => {
    const onRetry = vi.fn()
    await renderInConsole(
      () => (
        <QueryError
          error={
            new ApiError(
              400,
              'Unknown filter "foo:".',
              'invalid-argument',
              'Quote it to search for the text.',
            )
          }
          onRetry={onRetry}
        />
      ),
      { status: running },
    )
    expect(screen.getByText('Unknown filter "foo:".')).toBeInTheDocument()
    expect(screen.getByText('Quote it to search for the text.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('query-error-retry'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('treats a section that is starting as starting, and asks again once it is ready', async () => {
    const onRetry = vi.fn()
    const starting = testStatus({
      sections: [sectionEntry('auth', { state: 'starting', detail: 'Loading users…' })],
    })
    const view = await renderInConsole(
      () => (
        <QueryError
          error={new ApiError(503, 'Auth is starting.', 'starting')}
          onRetry={onRetry}
          section="auth"
        />
      ),
      { status: starting },
    )
    expect(screen.getByTestId('service-starting')).toHaveTextContent('Loading users…')
    expect(onRetry).not.toHaveBeenCalled()
    act(() =>
      view.client.setQueryData(['status'], testStatus({ sections: [sectionEntry('auth')] })),
    )
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  })

  it('shows the skeleton only once the wait passes 150 ms', () => {
    vi.useFakeTimers()
    render(<TableSkeleton columns={[{ width: 160 }, { width: 240 }]} rows={3} check />)
    expect(screen.queryByTestId('table-skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByTestId('table-skeleton').children).toHaveLength(3)
  })

  it('holds a delayed flag off for a fast answer', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Flag on />)
    act(() => vi.advanceTimersByTime(50))
    rerender(<Flag on={false} />)
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByTestId('flag')).toHaveTextContent('false')
    rerender(<Flag on />)
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByTestId('flag')).toHaveTextContent('true')
  })
})
