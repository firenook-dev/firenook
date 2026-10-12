import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { giveListsALayout } from '@/test/virtual'
import { PayloadView, bytesAsText, decodeBase64, hexDump } from './payload-view'

giveListsALayout()
afterEach(cleanup)

const base64 = (text: string) => btoa(text)

describe('decoding a payload', () => {
  it('reads standard and URL-safe base64, padded or not, and refuses what is not', () => {
    expect(Array.from(decodeBase64('aGk=') ?? [])).toEqual([104, 105])
    expect(Array.from(decodeBase64('aGk') ?? [])).toEqual([104, 105])
    expect(Array.from(decodeBase64('-_8') ?? [])).toEqual([251, 255])
    expect(decodeBase64('not base64!')).toBeUndefined()
    expect(decodeBase64('a')).toBeUndefined()
  })

  it('calls bytes text only when they are UTF-8 without control characters', () => {
    expect(bytesAsText(new TextEncoder().encode('héllo\n\tworld'))).toBe('héllo\n\tworld')
    expect(bytesAsText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
    expect(bytesAsText(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined()
  })

  it('dumps hex with offsets and printable ASCII', () => {
    const bytes = new TextEncoder().encode('\x89PNG\r\n\x1a\n0123456789')
    expect(hexDump(bytes).split('\n')[0]).toBe(
      '00000000  c2 89 50 4e 47 0d 0a 1a  0a 30 31 32 33 34 35 36  |..PNG....0123456|',
    )
    expect(hexDump(new Uint8Array(5000)).split('\n')).toHaveLength(256)
  })
})

describe('the payload view', () => {
  it('shows JSON as a tree, whether it came as JSON, text or base64', () => {
    render(<PayloadView json={{ order: 'o_1' }} testId="a" />)
    expect(screen.getByTestId('a-json')).toBeInTheDocument()
    cleanup()
    render(<PayloadView text='{"order":"o_1"}' testId="b" />)
    expect(screen.getByTestId('b-json')).toBeInTheDocument()
    cleanup()
    render(<PayloadView base64={base64('[1,2]')} testId="c" />)
    expect(screen.getByTestId('c-json')).toBeInTheDocument()
    cleanup()
    // A scalar is JSON only when the content type says so.
    render(<PayloadView text="42" testId="d" />)
    expect(screen.getByTestId('d-text')).toHaveTextContent('42')
    cleanup()
    render(<PayloadView text="42" contentType="application/json" testId="e" />)
    expect(screen.getByTestId('e-json')).toBeInTheDocument()
  })

  it('shows text as text, with its type and size', () => {
    render(
      <PayloadView
        base64={base64('hello world')}
        contentType="text/plain; charset=utf-8"
        testId="p"
      />,
    )
    expect(screen.getByTestId('p-text')).toHaveTextContent('text/plain · 11 B')
    expect(screen.getByTestId('p-text')).toHaveTextContent('hello world')
  })

  it('shows anything else as hex with a download', () => {
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    render(<PayloadView base64={png} contentType="image/png" filename="logo.png" testId="p" />)
    expect(screen.getByTestId('p-binary')).toHaveTextContent('8 B · not text · image/png')
    expect(screen.getByTestId('p-binary').querySelector('pre')?.textContent).toMatch(
      /^00000000 {2}89 50 4e 47 0d 0a 1a 0a {2}/,
    )
    expect(screen.getByTestId('p-download')).toBeInTheDocument()
  })

  it('says when base64 is not base64', () => {
    render(<PayloadView base64="%%%" testId="p" />)
    expect(screen.getByTestId('p-invalid')).toHaveTextContent('This payload is not valid base64.')
  })
})
