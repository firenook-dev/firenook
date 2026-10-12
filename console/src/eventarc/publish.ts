// The publish drawer's draft and everything that follows from it: what is
// wrong with it before it is sent, the request the engine takes, the
// question "who would this reach?" for the engine's matcher, the drawer
// filled from an event already kept ("edit and publish"), and the same
// event as code — the Admin SDK call an app makes, or a curl to the
// Eventarc emulator itself — carrying exactly this event.

import type { EventarcEventView } from '@/api/generated/compute/EventarcEventView'
import type { EventarcPublishRequest } from '@/api/generated/compute/EventarcPublishRequest'
import type { FunctionMatchRequest } from '@/api/generated/compute/FunctionMatchRequest'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import { shellQuote } from '@/components/console/request/as-code'

/** The source an event published from the console says it came from, unless changed. */
export const CONSOLE_SOURCE = 'console'

/** CloudEvent attributes a publisher sets with their own field, never as an extension attribute. */
const RESERVED = new Set([
  'id',
  'source',
  'specversion',
  'type',
  'time',
  'subject',
  'datacontenttype',
  'data',
])

export interface PublishDraft {
  /** A channel's full name (`projects/<p>/locations/<l>/channels/<id>`) or `google`. */
  channel: string
  type: string
  source: string
  subject: string
  encoding: 'json' | 'text'
  /** JSON text, or plain text. */
  data: string
  attributes: KeyValueRow[]
  /** Empty: the engine makes one (a UUID). */
  id: string
  /** Empty: now. */
  time: string
}

/** A fresh draft on a channel, with an empty JSON object for data. */
export function emptyDraft(channel = '', type = ''): PublishDraft {
  return {
    channel,
    type,
    source: CONSOLE_SOURCE,
    subject: '',
    encoding: 'json',
    data: '{}',
    attributes: [],
    id: '',
    time: '',
  }
}

/** Why an extension attribute's name is refused, or undefined: 1 to 20 lowercase letters or digits. */
export function attributeProblem(name: string): string | undefined {
  if (name === '') return undefined
  if (!/^[a-z0-9]{1,20}$/.test(name)) return 'Use 1 to 20 lowercase letters or digits.'
  if (RESERVED.has(name)) return 'A CloudEvent attribute of its own: set it with its field.'
  return undefined
}

/** Whether a channel name is one the engine accepts. */
export function isChannelName(name: string): boolean {
  return name === 'google' || /^projects\/[^/]+\/locations\/[^/]+\/channels\/[^/]+$/.test(name)
}

export interface PublishProblem {
  field: 'channel' | 'type' | 'source' | 'data' | 'attributes'
  message: string
}

/** Everything wrong with the draft, in the engine's words, field by field. */
export function publishProblems(draft: PublishDraft): PublishProblem[] {
  const problems: PublishProblem[] = []
  const channel = draft.channel.trim()
  if (channel === '')
    problems.push({ field: 'channel', message: 'Name the channel to publish on.' })
  else if (!isChannelName(channel))
    problems.push({
      field: 'channel',
      message:
        'The channel is projects/<project>/locations/<location>/channels/<id>, or google for the native channel.',
    })
  if (draft.type.trim() === '') problems.push({ field: 'type', message: 'The event needs a type.' })
  if (draft.source.trim() === '')
    problems.push({ field: 'source', message: 'The event needs a source.' })
  if (draft.encoding === 'json' && draft.data.trim() !== '') {
    try {
      JSON.parse(draft.data)
    } catch (error) {
      problems.push({
        field: 'data',
        message: `The data is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  const named = draft.attributes.filter((row) => row.enabled && row.key !== '')
  const bad = named.find((row) => attributeProblem(row.key) !== undefined)
  if (bad)
    problems.push({
      field: 'attributes',
      message: `The attribute name "${bad.key}" must be 1 to 20 lowercase letters or digits, and not a CloudEvent attribute of its own.`,
    })
  return problems
}

/** The extension attributes the draft sets, by name. */
export function draftAttributes(draft: PublishDraft): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const row of draft.attributes)
    if (row.enabled && row.key !== '') attributes[row.key] = row.value
  return attributes
}

/** The request `POST /eventarc/channel/publish` takes. */
export function publishRequest(draft: PublishDraft): EventarcPublishRequest {
  const subject = draft.subject.trim()
  const id = draft.id.trim()
  const time = draft.time.trim()
  return {
    channel: draft.channel.trim(),
    type: draft.type.trim(),
    source: draft.source.trim(),
    subject: subject === '' ? null : subject,
    id: id === '' ? null : id,
    time: time === '' ? null : time,
    encoding: draft.encoding,
    data: draft.data,
    attributes: draftAttributes(draft),
  }
}

/**
 * The matcher's question for this draft — who listens for this type on
 * this channel, and whose filters would let it through — or undefined
 * until it names both.
 */
export function matchRequest(draft: PublishDraft): FunctionMatchRequest | undefined {
  const channel = draft.channel.trim()
  const type = draft.type.trim()
  if (!isChannelName(channel) || type === '') return undefined
  const attributes: Record<string, string> = { ...draftAttributes(draft) }
  if (draft.source.trim() !== '') attributes.source = draft.source.trim()
  if (draft.subject.trim() !== '') attributes.subject = draft.subject.trim()
  return { service: 'eventarc', channel, eventType: type, attributes }
}

/** A kept event as a draft, for "edit and publish": the same event, minus its id and time. */
export function draftFromEvent(view: EventarcEventView): PublishDraft {
  const { detail } = view
  const summary = detail.summary
  const json = detail.datacontenttype === null || /json/i.test(detail.datacontenttype)
  const data =
    detail.data === null || detail.data === undefined
      ? json
        ? '{}'
        : ''
      : typeof detail.data === 'string' && !json
        ? detail.data
        : JSON.stringify(detail.data, null, 2)
  const attributes: KeyValueRow[] = Object.entries(detail.attributes)
    .filter(([name]) => !RESERVED.has(name))
    .map(([key, value]) => ({ id: rowId(), key, value, enabled: true }))
  return {
    channel: summary.channel,
    type: summary.eventType,
    source: summary.source ?? CONSOLE_SOURCE,
    subject: summary.subject ?? '',
    encoding: json ? 'json' : 'text',
    data,
    attributes,
    id: '',
    time: '',
  }
}

/** The data as the event carries it: parsed JSON, or the text. */
function dataValue(draft: PublishDraft): unknown {
  if (draft.encoding === 'text') return draft.data
  try {
    return draft.data.trim() === '' ? {} : JSON.parse(draft.data)
  } catch {
    return draft.data
  }
}

/** A JavaScript literal for a value, two-space indented under `indent`. */
function literal(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${indent}`)
}

/** The Admin SDK call that publishes this event from an app or a function. */
export function adminSdkCode(draft: PublishDraft): string {
  const request = publishRequest(draft)
  const fields: string[] = [`    type: ${literal(request.type, '    ')},`]
  fields.push(`    source: ${literal(request.source, '    ')},`)
  if (request.subject !== null) fields.push(`    subject: ${literal(request.subject, '    ')},`)
  if (request.id !== null) fields.push(`    id: ${literal(request.id, '    ')},`)
  if (request.time !== null) fields.push(`    time: ${literal(request.time, '    ')},`)
  if (draft.encoding === 'text') fields.push(`    datacontenttype: 'text/plain',`)
  fields.push(`    data: ${literal(dataValue(draft), '    ')},`)
  for (const [name, value] of Object.entries(request.attributes))
    fields.push(`    ${name}: ${literal(value, '    ')},`)
  const channel = request.channel === 'google' ? 'google' : request.channel
  return `import { getEventarc } from 'firebase-admin/eventarc'

await getEventarc()
  .channel(${literal(channel, '  ')})
  .publish({
${fields.join('\n')}
  })`
}

/**
 * The event as the Eventarc emulator takes it over HTTP: proto JSON on a
 * channel (what the Admin SDK sends), a structured CloudEvent on the native
 * channel. `id` and `time` are filled when the draft leaves them empty, as
 * the engine would.
 */
export function wireEvent(draft: PublishDraft, id: string, now: string): Record<string, unknown> {
  const request = publishRequest(draft)
  const data = dataValue(draft)
  const contentType = draft.encoding === 'text' ? 'text/plain' : 'application/json'
  if (request.channel === 'google') {
    const event: Record<string, unknown> = {
      specversion: '1.0',
      id: request.id ?? id,
      source: request.source,
      type: request.type,
      time: request.time ?? now,
      datacontenttype: contentType,
      data,
    }
    if (request.subject !== null) event.subject = request.subject
    for (const [name, value] of Object.entries(request.attributes)) event[name] = value
    return event
  }
  const attributes: Record<string, unknown> = {
    datacontenttype: { ceString: contentType },
    time: { ceTimestamp: request.time ?? now },
  }
  if (request.subject !== null) attributes.subject = { ceString: request.subject }
  for (const [name, value] of Object.entries(request.attributes))
    attributes[name] = { ceString: value }
  return {
    id: request.id ?? id,
    source: request.source,
    specVersion: '1.0',
    type: request.type,
    attributes,
    textData: typeof data === 'string' ? data : JSON.stringify(data),
  }
}

/** A curl to the Eventarc emulator at `origin` that publishes this event. */
export function curlCode(draft: PublishDraft, origin: string, id: string, now: string): string {
  const request = publishRequest(draft)
  const path =
    request.channel === 'google' ? '/google/publishEvents' : `/${request.channel}:publishEvents`
  const body = JSON.stringify({ events: [wireEvent(draft, id, now)] })
  return [
    `curl -X POST ${shellQuote(`${origin}${path}`)} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d ${shellQuote(body)}`,
  ].join('\n')
}
