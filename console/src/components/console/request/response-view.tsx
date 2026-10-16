// The answer to a composed request: a status line that says how it went
// and how long it took, then the body, the headers and the exchange as it
// was on the wire. A streamed answer shows its chunks as they arrive.

import { Button, Tabs, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { StatusDot, type StatusTone } from '@/components/kit'
import { download } from '@/lib/download'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { JsonView } from '../json-view'
import type { ResponseRecord } from './types'

type Tab = 'body' | 'headers' | 'raw' | 'chunks'

const TEXTUAL =
  /^(text\/|application\/(json|[\w.+-]*\+json|x-ndjson|ndjson|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql|yaml|x-yaml)\b)/i

/** Whether a content type is text the console can show as it is. */
export function isTextual(contentType: string | undefined): boolean {
  return contentType !== undefined && TEXTUAL.test(contentType.trim())
}

/** Bytes shown as hex: the first 4 KB. */
const HEX_BYTES = 4096

/** success for 2xx, warning for 3xx and 4xx, danger for 5xx and no answer. */
export function statusTone(response: ResponseRecord): StatusTone {
  if (response.status === 0) return 'danger'
  if (response.status < 300) return 'success'
  if (response.status < 500) return 'warning'
  return 'danger'
}

/** `200 OK`, or `No answer` when none arrived. */
export function statusLabel(response: ResponseRecord): string {
  if (response.status === 0) return 'No answer'
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
}

/** The figures after the status: `first byte 12 ms · 41 ms · 312 B`, or `receiving… 3 chunks`. */
export function responseFigures(response: ResponseRecord): string {
  if (response.receiving) {
    const count = response.chunks?.length ?? 0
    return `receiving… ${formatNumber(count)} ${count === 1 ? 'chunk' : 'chunks'} · ${formatBytes(response.sizeBytes)}`
  }
  if (response.status === 0) return formatDuration(response.durationMs)
  const parts: string[] = []
  if (response.firstByteMs !== undefined && response.durationMs - response.firstByteMs >= 1)
    parts.push(`first byte ${formatDuration(response.firstByteMs)}`)
  parts.push(formatDuration(response.durationMs), formatBytes(response.sizeBytes))
  return parts.join(' · ')
}

/** The body as text when it is text, with its value when it is JSON. */
function bodyFor(
  response: ResponseRecord,
): { text: string; json: { value: unknown } | undefined } | undefined {
  const text =
    response.bodyText ??
    (response.chunks && response.receiving
      ? response.chunks.map((chunk) => chunk.text).join('')
      : undefined)
  if (text === undefined) return undefined
  const looksJson =
    /json/i.test(response.contentType ?? '') ||
    (response.contentType === undefined && /^\s*[[{]/.test(text))
  if (looksJson && !response.receiving) {
    try {
      return { text, json: { value: JSON.parse(text) as unknown } }
    } catch {
      // Not JSON after all: shown as it came.
    }
  }
  return { text, json: undefined }
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** `00000000  89 50 4e 47 0d 0a 1a 0a  …  |.PNG....|`, sixteen bytes a line. */
export function hexLines(bytes: Uint8Array, limit = HEX_BYTES): string[] {
  const lines: string[] = []
  const end = Math.min(bytes.length, limit)
  for (let at = 0; at < end; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, end))
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, '0'))
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    const ascii = Array.from(row, (byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.',
    ).join('')
    lines.push(
      `${at.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`,
    )
  }
  return lines
}

/** The exchange's answer as HTTP text: the status line, the headers and the body. */
export function rawResponse(response: ResponseRecord): string {
  const head = [
    `HTTP/1.1 ${statusLabel(response)}`,
    ...response.headers.map(([key, value]) => `${key}: ${value}`),
  ]
  const body =
    response.bodyText ??
    (response.bodyBase64 !== undefined
      ? `<${formatBytes(response.sizeBytes)} of bytes, not text>`
      : '')
  return `${head.join('\n')}\n\n${body}`
}

/** "Waiting for the answer…", only once the wait is long enough to notice (150 ms). */
function Waiting() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 150)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <Text size="sm" variant="secondary">
      {shown ? 'Waiting for the answer…' : '\u00a0'}
    </Text>
  )
}

export function ResponseView({
  response,
  pending,
  testId = 'response',
}: {
  response: ResponseRecord | undefined
  pending: boolean
  testId?: string
}) {
  const [tab, setTab] = useState<Tab>('body')
  if (!response)
    return (
      <div className="px-1 py-3" data-testid={testId} data-state={pending ? 'pending' : 'empty'}>
        {pending ? (
          <Waiting />
        ) : (
          <Text size="sm" variant="secondary">
            Send the request to see the answer here.
          </Text>
        )}
      </div>
    )
  const streamed = (response.chunks?.length ?? 0) > 1
  const shown: Tab = tab === 'chunks' && !streamed ? 'body' : tab
  const body = bodyFor(response)
  const tabs = [
    { value: 'body', label: 'Body' },
    { value: 'headers', label: `Headers · ${formatNumber(response.headers.length)}` },
    ...(streamed
      ? [{ value: 'chunks', label: `Chunks · ${formatNumber(response.chunks?.length ?? 0)}` }]
      : []),
    { value: 'raw', label: 'Raw' },
  ]
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2"
      data-testid={testId}
      data-state={response.receiving ? 'receiving' : response.status === 0 ? 'failed' : 'done'}
      data-status={response.status}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot
          tone={statusTone(response)}
          label={statusLabel(response)}
          pulse={response.receiving === true}
          testId={`${testId}-status`}
        />
        <span
          className="text-[12px] text-kumo-subtle tabular-nums"
          data-testid={`${testId}-figures`}
        >
          {responseFigures(response)}
        </span>
      </div>
      {response.error && (
        <Text size="sm" variant="error">
          {response.error}
        </Text>
      )}
      {response.status !== 0 && (
        <>
          <Tabs
            size="sm"
            variant="segmented"
            value={shown}
            onValueChange={(next) => setTab(next as Tab)}
            tabs={tabs}
          />
          <div className="flex min-h-0 flex-1 flex-col" data-testid={`${testId}-${shown}`}>
            {shown === 'body' && <ResponseBody response={response} body={body} testId={testId} />}
            {shown === 'headers' && <HeaderList headers={response.headers} />}
            {shown === 'chunks' && <ChunkList chunks={response.chunks ?? []} />}
            {shown === 'raw' && (
              <pre className="max-h-96 min-h-0 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words text-kumo-default ring ring-kumo-line">
                {rawResponse(response)}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ResponseBody({
  response,
  body,
  testId,
}: {
  response: ResponseRecord
  body: ReturnType<typeof bodyFor>
  testId: string
}) {
  if (response.bodyBase64 !== undefined) {
    const bytes = bytesOf(response.bodyBase64)
    return (
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Text size="sm" variant="secondary">
            {formatBytes(response.sizeBytes)} ·{' '}
            {isTextual(response.contentType) ? 'text' : 'not text'}
            {response.contentType ? ` · ${response.contentType}` : ''}
            {bytes.length > HEX_BYTES ? ` · first ${formatBytes(HEX_BYTES)} shown` : ''}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            icon={<DownloadSimpleIcon />}
            onClick={() =>
              void download(
                () =>
                  Promise.resolve(
                    new Response(new Blob([bytes as BlobPart]), {
                      headers: {
                        'content-type': response.contentType ?? 'application/octet-stream',
                      },
                    }),
                  ),
                'response.bin',
              )
            }
            data-testid={`${testId}-download`}
          >
            Download
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line">
          {hexLines(bytes).join('\n')}
        </pre>
      </div>
    )
  }
  if (!body || body.text === '')
    return (
      <Text size="sm" variant="secondary">
        The answer has no body.
      </Text>
    )
  return (
    <div className="grid gap-1">
      {response.truncated && (
        <Text size="xs" variant="secondary">
          The answer is {formatBytes(response.sizeBytes)}; the console keeps its first 5 MB.
        </Text>
      )}
      {body.json ? (
        // The tree to fold, search and copy a path from (the text as it came
        // is the response's own Raw tab); as tall as the answer up to 480 px,
        // so a short answer leaves no empty box and a long one no endless page.
        <div className="overflow-hidden rounded-md ring ring-kumo-line">
          <JsonView
            value={body.json.value}
            text={body.text}
            height="content"
            raw={false}
            testId={`${testId}-json`}
          />
        </div>
      ) : (
        <pre className="max-h-96 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words text-kumo-default ring ring-kumo-line">
          {body.text}
        </pre>
      )}
    </div>
  )
}

function HeaderList({ headers }: { headers: readonly [string, string][] }) {
  if (headers.length === 0)
    return (
      <Text size="sm" variant="secondary">
        No headers.
      </Text>
    )
  return (
    <dl className="grid max-h-96 grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 overflow-auto font-mono text-[12px]">
      {headers.map(([key, value], index) => (
        // A header can repeat (set-cookie), so its position is what keeps two rows apart.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={`${key}-${index}`} className="contents">
          <dt className="text-kumo-subtle">{key}</dt>
          <dd className="break-all text-kumo-default">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ChunkList({ chunks }: { chunks: readonly { atMs: number; text: string }[] }) {
  return (
    <ol className="max-h-96 overflow-auto rounded-md ring ring-kumo-line">
      {chunks.map((chunk, index) => (
        <li
          // Chunks only ever append, so a chunk's position is its identity.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 border-b border-kumo-hairline px-3 py-1 last:border-b-0"
        >
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
            +{formatDuration(chunk.atMs)}
          </span>
          <span className="font-mono text-[12px] whitespace-pre-wrap break-words text-kumo-default">
            {chunk.text}
          </span>
        </li>
      ))}
    </ol>
  )
}
