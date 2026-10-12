import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { giveListsALayout } from '@/test/virtual'
import {
  ResponseView,
  hexLines,
  rawResponse,
  responseFigures,
  statusLabel,
  statusTone,
} from './response-view'
import type { ResponseRecord } from './types'

giveListsALayout()
afterEach(cleanup)

const ok: ResponseRecord = {
  status: 200,
  statusText: 'OK',
  headers: [
    ['content-type', 'text/plain'],
    ['x-firenook-execution', 'a3f9c1-1284'],
  ],
  bodyText: 'hello ada',
  contentType: 'text/plain',
  firstByteMs: 12,
  durationMs: 41,
  sizeBytes: 312,
  at: '2026-10-12T06:00:00Z',
}

describe('the answer to a request', () => {
  it('says how it went in a status line', () => {
    expect(statusTone(ok)).toBe('success')
    expect(statusTone({ ...ok, status: 404 })).toBe('warning')
    expect(statusTone({ ...ok, status: 500 })).toBe('danger')
    expect(statusTone({ ...ok, status: 0 })).toBe('danger')
    expect(statusLabel(ok)).toBe('200 OK')
    expect(statusLabel({ ...ok, status: 0 })).toBe('No answer')
    expect(responseFigures(ok)).toBe('first byte 12 ms · 41 ms · 312 B')
    expect(
      responseFigures({
        ...ok,
        receiving: true,
        chunks: [
          { atMs: 3, text: 'a' },
          { atMs: 9, text: 'b' },
          { atMs: 12, text: 'c' },
        ],
      }),
    ).toBe('receiving… 3 chunks · 312 B')
  })

  it('shows the body, the headers with a count, and the exchange as text', async () => {
    render(<ResponseView response={ok} pending={false} />)
    expect(screen.getByTestId('response-status')).toHaveTextContent('200 OK')
    expect(screen.getByTestId('response-body')).toHaveTextContent('hello ada')
    await userEvent.click(screen.getByRole('tab', { name: 'Headers · 2' }))
    expect(screen.getByTestId('response-headers')).toHaveTextContent('x-firenook-execution')
    await userEvent.click(screen.getByRole('tab', { name: 'Raw' }))
    expect(screen.getByTestId('response-raw')).toHaveTextContent('HTTP/1.1 200 OK')
    expect(rawResponse(ok)).toBe(
      'HTTP/1.1 200 OK\ncontent-type: text/plain\nx-firenook-execution: a3f9c1-1284\n\nhello ada',
    )
  })

  it('shows a JSON answer as a tree to search, and copies it exactly as it came', async () => {
    const user = userEvent.setup()
    const text = '{"user":{"uid":"u_1","plan":"pro"},"n":3.0}'
    render(
      <ResponseView
        response={{ ...ok, bodyText: text, contentType: 'application/json', headers: [] }}
        pending={false}
      />,
    )
    expect(screen.getByRole('tree', { name: 'JSON tree' })).toBeInTheDocument()
    // One Raw tab: the exchange's. The tree's own would show the same text again.
    expect(screen.getAllByRole('tab', { name: 'Raw' })).toHaveLength(1)
    await user.type(screen.getByTestId('response-json-search'), 'pro')
    expect(screen.getByTestId('response-json-hits')).toHaveTextContent('1 of 1')
    await user.click(screen.getByTestId('response-json-copy'))
    expect(await navigator.clipboard.readText()).toBe(text)
  })

  it('lists the chunks of a streamed answer', async () => {
    render(
      <ResponseView
        response={{
          ...ok,
          bodyText: 'onetwo',
          chunks: [
            { atMs: 5, text: 'one' },
            { atMs: 900, text: 'two' },
          ],
        }}
        pending={false}
      />,
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Chunks · 2' }))
    expect(screen.getByTestId('response-chunks')).toHaveTextContent('+900 ms')
  })

  it('shows bytes as hex, and a failure as a sentence', () => {
    expect(hexLines(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 65]))).toEqual([
      '00000000  89 50 4e 47 0d 0a 1a 0a  41                       |.PNG....A|',
    ])
    render(
      <ResponseView
        response={{
          ...ok,
          status: 0,
          statusText: '',
          headers: [],
          error: 'The request did not reach the engine: Failed to fetch',
        }}
        pending={false}
      />,
    )
    expect(screen.getByTestId('response-status')).toHaveTextContent('No answer')
    expect(
      screen.getByText('The request did not reach the engine: Failed to fetch'),
    ).toBeInTheDocument()
  })

  it('says what will appear before anything was sent', () => {
    render(<ResponseView response={undefined} pending={false} />)
    expect(screen.getByText('Send the request to see the answer here.')).toBeInTheDocument()
  })
})
