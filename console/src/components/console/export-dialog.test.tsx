import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'

const saved = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('@/lib/download', () => ({ download: saved.download }))

const { ExportDialog } = await import('./export-dialog')

afterEach(() => {
  cleanup()
  saved.download.mockReset()
})

describe('the export dialog', () => {
  it('downloads what the engine streams, by format, and closes', async () => {
    saved.download.mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    await renderInConsole(
      () => (
        <ExportDialog
          open
          onOpenChange={onOpenChange}
          title="Export users"
          scope="Every user matching provider:google.com, in every tenant."
          formats={['ndjson', 'csv']}
          filename={(format) => `users.${format}`}
          href={(format) => `/console/api/v1/auth/users:export?format=${format}`}
        />
      ),
      { status: testStatus() },
    )
    expect(screen.getByTestId('export-dialog-scope')).toHaveTextContent('provider:google.com')
    expect(screen.getByText(/One JSON value per line/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'CSV' }))
    await userEvent.click(screen.getByTestId('export-dialog-confirm'))
    expect(saved.download).toHaveBeenCalledWith(
      '/console/api/v1/auth/users:export?format=csv',
      'users.csv',
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('builds a file in the browser with progress, and keeps the error when it fails', async () => {
    let finish: ((blob: Blob) => void) | undefined
    const run = vi.fn(
      (_format: string, _signal: AbortSignal, progress: (done: number, total?: number) => void) => {
        progress(40, 120)
        return new Promise<Blob>((resolve) => (finish = resolve))
      },
    )
    saved.download.mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    await renderInConsole(
      () => (
        <ExportDialog
          open
          onOpenChange={onOpenChange}
          title="Export"
          scope="What ada@example.test can read."
          formats={['json']}
          filename={() => 'orders.json'}
          run={run}
        />
      ),
      { status: testStatus() },
    )
    await userEvent.click(screen.getByTestId('export-dialog-confirm'))
    expect(await screen.findByTestId('export-dialog-progress')).toHaveTextContent('Read 40 of 120…')
    finish?.(new Blob(['[]']))
    await waitFor(() => expect(saved.download).toHaveBeenCalledTimes(1))
    expect(saved.download.mock.calls[0]?.[1]).toBe('orders.json')
    // Built here, so saved as the Blob it is, typed for its format.
    const file = saved.download.mock.calls[0]?.[0] as Blob
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('application/json')
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

    cleanup()
    const failing = vi.fn(async () => {
      throw new Error('Denied by security rules.')
    })
    await renderInConsole(
      () => (
        <ExportDialog
          open
          onOpenChange={() => {}}
          title="Export"
          scope="What ada@example.test can read."
          formats={['json']}
          filename={() => 'orders.json'}
          run={failing}
        />
      ),
      { status: testStatus() },
    )
    await userEvent.click(screen.getByTestId('export-dialog-confirm'))
    expect(await screen.findByTestId('export-dialog-error')).toHaveTextContent(
      'Denied by security rules.',
    )
  })

  it('says what a section’s formats hold, and offers its own choice under them', async () => {
    await renderInConsole(
      () => (
        <ExportDialog
          open
          onOpenChange={() => {}}
          title="Export"
          scope="Every document in orders."
          formats={['json', 'csv']}
          filename={(format) => `orders.${format}`}
          notes={{ json: 'One object keyed by document id.' }}
          renderOptions={(format) =>
            format === 'csv' ? null : <span data-testid="typed-option">Keep types</span>
          }
          run={async () => new Blob(['{}'])}
        />
      ),
      { status: testStatus() },
    )
    expect(screen.getByText('One object keyed by document id.')).toBeInTheDocument()
    expect(screen.getByTestId('typed-option')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'CSV' }))
    expect(screen.queryByTestId('typed-option')).toBeNull()
    expect(screen.getByText(/Columns for a spreadsheet/)).toBeInTheDocument()
  })
})
