// Publish a file (PS-19): the NDJSON the export writes — one
// `{ id, publishTime, data (base64), attributes, orderingKey }` per line —
// or any lines of that shape, published as a `pubsub.publish` job (the
// engine sends it in batches of 1,000, progress on the `jobs` topic). The
// way back after a restart, since Pub/Sub keeps nothing across one.

import { Button, Tooltip } from '@cloudflare/kumo'
import { FileArrowUpIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import type { PubsubOutgoingMessage } from '@/api/generated/messaging/PubsubOutgoingMessage'
import { formatBytes, formatNumber } from '@/lib/format'
import { REQUEST_BYTES, base64Bytes, utf8Bytes } from '../payload'

/** What a file reads as: the messages, or the first line that does not read. */
export type FileMessages =
  | { ok: true; messages: PubsubOutgoingMessage[]; bytes: number }
  | { ok: false; message: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** One line of the file as a message, or why not. */
function lineMessage(value: unknown, line: number): PubsubOutgoingMessage | string {
  const entry = record(value)
  if (!entry) return `Line ${line} is not an object.`
  const data = entry.data ?? ''
  if (typeof data !== 'string' || base64Bytes(data) === undefined)
    return `Line ${line}: data is base64, as the export writes it.`
  const attributes: Record<string, string> = {}
  if (entry.attributes !== undefined && entry.attributes !== null) {
    const map = record(entry.attributes)
    if (!map) return `Line ${line}: attributes is an object of strings.`
    for (const [key, item] of Object.entries(map)) {
      if (typeof item !== 'string') return `Line ${line}: attribute ${key} is not a string.`
      attributes[key] = item
    }
  }
  const orderingKey = entry.orderingKey
  if (orderingKey !== undefined && orderingKey !== null && typeof orderingKey !== 'string')
    return `Line ${line}: orderingKey is a string.`
  return {
    data: { base64: data },
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(orderingKey ? { orderingKey } : {}),
  }
}

/** Reads NDJSON (or a JSON array) of exported messages. */
export function readMessagesFile(text: string): FileMessages {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: 'The file is empty.' }
  let values: { value: unknown; line: number }[]
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!Array.isArray(parsed))
        return { ok: false, message: 'The file is not a list of messages.' }
      values = parsed.map((value, index) => ({ value, line: index + 1 }))
    } catch (error) {
      return {
        ok: false,
        message: `The file is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  } else {
    values = []
    const lines = text.split(/\r?\n/)
    for (const [index, raw] of lines.entries()) {
      if (raw.trim() === '') continue
      try {
        values.push({ value: JSON.parse(raw) as unknown, line: index + 1 })
      } catch {
        return { ok: false, message: `Line ${index + 1} is not JSON.` }
      }
    }
  }
  const messages: PubsubOutgoingMessage[] = []
  let bytes = 0
  for (const { value, line } of values) {
    const message = lineMessage(value, line)
    if (typeof message === 'string') return { ok: false, message }
    const data = 'base64' in message.data ? message.data.base64 : ''
    bytes += base64Bytes(data) ?? 0
    for (const [key, item] of Object.entries(message.attributes ?? {}))
      bytes += utf8Bytes(key) + utf8Bytes(item)
    bytes += utf8Bytes(message.orderingKey ?? '')
    messages.push(message)
  }
  if (messages.length === 0) return { ok: false, message: 'The file holds no messages.' }
  if (bytes > REQUEST_BYTES)
    return {
      ok: false,
      message: `The file's messages are ${formatBytes(bytes)}; the console publishes up to 64 MiB at once. Split the file.`,
    }
  return { ok: true, messages, bytes }
}

/** "214 messages from orders.ndjson". */
export function fileSummary(count: number, name: string): string {
  return `${formatNumber(count)} ${count === 1 ? 'message' : 'messages'} from ${name}`
}

/** The composer footer's "Publish file…": a file input that reads the file it is given. */
export function PublishFileButton({
  onRead,
}: {
  onRead: (file: { name: string; result: FileMessages }) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".ndjson,.jsonl,.json,application/json,application/x-ndjson"
        className="hidden"
        data-testid="pubsub-publish-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          void file
            .text()
            .then((text) => onRead({ name: file.name, result: readMessagesFile(text) }))
        }}
      />
      <Tooltip
        content="Publish the messages of a file, as the export writes them (one JSON object per line)"
        render={
          <Button
            variant="ghost"
            size="sm"
            icon={<FileArrowUpIcon />}
            onClick={() => input.current?.click()}
            data-testid="pubsub-publish-file"
          >
            Publish file…
          </Button>
        }
      />
    </>
  )
}
