// The body of something — a Pub/Sub message, a task, an HTTP request, an
// event — shown as what it is: JSON as a tree, text as text, and anything
// else as the hex of its first 4 KB with a way to save the whole of it.
// A payload arrives as base64 more often than not, and the console decodes
// it rather than showing the base64, which says nothing to anyone.

import { Button, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import { type ReactNode, useMemo, useState } from 'react'
import { download } from '@/lib/download'
import { formatBytes } from '@/lib/format'
import { JsonView } from './json-view'

/** How much of a binary payload is drawn as hex: enough to recognise a file by its header. */
export const HEX_BYTES = 4096
/** Text past this many characters is drawn on request: a 20 MB log line is not a paragraph. */
const TEXT_SHOWN = 100_000

type Decoded =
  | { kind: 'json'; value: unknown; text: string; bytes: number }
  | { kind: 'text'; text: string; bytes: number }
  | { kind: 'binary'; data: Uint8Array }
  | { kind: 'invalid'; message: string }

/** Whether a content type promises JSON: `application/json`, `…+json`. */
function saysJson(contentType: string | undefined): boolean {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || type.endsWith('+json') || type === 'text/json'
}

/** JSON text, parsed, when it is JSON: an object or array always, a scalar only when promised. */
function asJson(text: string, promised: boolean): { value: unknown } | undefined {
  const start = text.trimStart()[0]
  if (!promised && start !== '{' && start !== '[') return undefined
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

/** Base64 (standard or URL-safe, padded or not) to bytes; `undefined` when it is not base64. */
export function decodeBase64(text: string): Uint8Array | undefined {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.replace(/=+$/, '').length % 4 === 1)
    return undefined
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}

/**
 * Bytes as text when they are text: valid UTF-8 with no control characters
 * but tab, line feed and carriage return. A NUL in the first few bytes is a
 * file, whatever its type says.
 */
export function bytesAsText(bytes: Uint8Array): string | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return undefined
    if (code === 0x7f) return undefined
  }
  return text
}

/** The classic hex dump: offset, sixteen bytes in two groups of eight, and their printable ASCII. */
export function hexDump(bytes: Uint8Array, limit = HEX_BYTES): string {
  const lines: string[] = []
  const end = Math.min(bytes.length, limit)
  for (let offset = 0; offset < end; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, end))
    const hex: string[] = []
    let ascii = ''
    for (let index = 0; index < 16; index += 1) {
      const byte = row[index]
      hex.push(byte === undefined ? '  ' : byte.toString(16).padStart(2, '0'))
      if (byte !== undefined) ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    }
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`,
    )
  }
  return lines.join('\n')
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

function decode(source: {
  base64?: string | undefined
  text?: string | undefined
  json?: unknown
  hasJson: boolean
  contentType?: string | undefined
}): Decoded {
  const promised = saysJson(source.contentType)
  if (source.hasJson) {
    const text = JSON.stringify(source.json, null, 2) ?? ''
    return { kind: 'json', value: source.json, text, bytes: utf8Length(text) }
  }
  if (source.text !== undefined) {
    const json = asJson(source.text, promised)
    const bytes = utf8Length(source.text)
    return json
      ? { kind: 'json', value: json.value, text: source.text, bytes }
      : { kind: 'text', text: source.text, bytes }
  }
  if (source.base64 !== undefined) {
    const data = decodeBase64(source.base64)
    if (!data) return { kind: 'invalid', message: 'This payload is not valid base64.' }
    const text = bytesAsText(data)
    if (text === undefined) return { kind: 'binary', data }
    const json = asJson(text, promised)
    return json
      ? { kind: 'json', value: json.value, text, bytes: data.length }
      : { kind: 'text', text, bytes: data.length }
  }
  return { kind: 'text', text: '', bytes: 0 }
}

export function PayloadView({
  base64,
  text,
  json,
  contentType,
  filename,
  testId,
}: {
  /** Exactly one of `base64`, `text` and `json`. */
  base64?: string | undefined
  text?: string | undefined
  json?: unknown
  contentType?: string | undefined
  /** What a saved binary payload is called; `payload.bin` otherwise. */
  filename?: string | undefined
  testId?: string | undefined
}) {
  const hasJson = json !== undefined
  const decoded = useMemo(
    () => decode({ base64, text, json, hasJson, contentType }),
    [base64, text, json, hasJson, contentType],
  )
  const [all, setAll] = useState(false)
  const ids = testId ?? 'payload'
  const type = contentType?.split(';')[0]?.trim()

  if (decoded.kind === 'json')
    return <JsonView value={decoded.value} text={decoded.text} testId={`${ids}-json`} />

  if (decoded.kind === 'invalid')
    return (
      <div className="px-5 py-3" data-testid={`${ids}-invalid`}>
        <Text variant="error" size="sm">
          {decoded.message}
        </Text>
      </div>
    )

  if (decoded.kind === 'text') {
    const long = decoded.text.length > TEXT_SHOWN && !all
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`${ids}-text`}>
        <PayloadMeta>
          {decoded.bytes === 0 ? 'Empty' : `${type ?? 'text'} · ${formatBytes(decoded.bytes)}`}
        </PayloadMeta>
        {decoded.bytes > 0 && (
          <pre className="m-0 min-h-0 flex-1 overflow-auto px-5 py-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-kumo-default [overflow-wrap:anywhere]">
            {long ? decoded.text.slice(0, TEXT_SHOWN) : decoded.text}
          </pre>
        )}
        {long && (
          <div className="shrink-0 border-t border-kumo-line px-5 py-1.5">
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              Show the other{' '}
              {formatBytes(decoded.bytes - utf8Length(decoded.text.slice(0, TEXT_SHOWN)))}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const save = () =>
    download(
      () =>
        Promise.resolve(
          new Response(
            new Blob([decoded.data as BlobPart], { type: type ?? 'application/octet-stream' }),
          ),
        ),
      filename ?? 'payload.bin',
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`${ids}-binary`}>
      <PayloadMeta
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<DownloadSimpleIcon />}
            onClick={() => void save()}
            data-testid={`${ids}-download`}
          >
            Download
          </Button>
        }
      >
        {formatBytes(decoded.data.length)} · not text{type ? ` · ${type}` : ''}
      </PayloadMeta>
      <pre className="m-0 min-h-0 flex-1 overflow-auto px-5 py-3 font-mono text-[12px] leading-5 whitespace-pre text-kumo-default">
        {hexDump(decoded.data)}
      </pre>
      {decoded.data.length > HEX_BYTES && (
        <p className="m-0 shrink-0 border-t border-kumo-line px-5 py-1.5 text-[12px] text-kumo-subtle">
          The first {formatBytes(HEX_BYTES)}, in hex. Download it for the rest.
        </p>
      )}
    </div>
  )
}

function PayloadMeta({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-kumo-line px-5">
      <span className="min-w-0 truncate text-[12px] text-kumo-subtle tabular-nums">{children}</span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  )
}
