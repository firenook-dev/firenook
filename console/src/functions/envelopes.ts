// Test events, built exactly as the official functions shell builds them —
// a port of `packages/cli/src/invoke.mjs` (Firenook's own `functions:invoke
// --event-data`, itself held to firebase-tools' FunctionsEmulatorShell) for
// the browser. A parity test imports the CLI module and compares the two
// builder by builder, so change both or neither.
//
// Input is the definition exactly as `/backends` serves it (the function
// detail's `definition`), the project id and the event data a person typed;
// output is the body to post to the function's trigger route (and, for a
// second-generation schedule, the Cloud Scheduler headers the SDK reads).

/** A `/backends` definition: only the fields the builders read are typed. */
export interface BackendDefinition {
  name: string
  region?: string
  platform?: 'gcfv1' | 'gcfv2' | string
  labels?: Record<string, string>
  httpsTrigger?: unknown
  blockingTrigger?: unknown
  taskQueueTrigger?: unknown
  schedule?: unknown
  scheduleTrigger?: unknown
  eventTrigger?: {
    eventType?: string
    resource?: string
    channel?: string
    eventFilters?: Record<string, string>
    eventFilterPathPatterns?: Record<string, string>
  }
}

/** What the shell calls the ways a definition is triggered. */
export type ShellKind =
  | 'taskQueue'
  | 'blocking'
  | 'callable'
  | 'https'
  | 'schedule'
  | 'eventarc'
  | 'firestore'
  | 'database'
  | 'pubsub'
  | 'storage'
  | 'auth'
  | 'event'
  | 'unknown'

/** Where ids and times come from: the browser's own, or a test's fixed ones. */
export interface EnvelopeClock {
  uuid: () => string
  now: () => Date
}

const DEFAULT_CLOCK: EnvelopeClock = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date(),
}

/** The official Firestore emulator reports every writer with these values. */
const AUTH_CONTEXT = { authtype: 'unknown', authid: 'fake-auth-id@gmail.com' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isObject(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** UTF-8 text as base64 (the CLI's `Buffer.from(text).toString('base64')`). */
export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** How a definition is triggered, in the official shell's vocabulary. */
export function triggerKind(trigger: BackendDefinition): ShellKind {
  if (trigger.taskQueueTrigger) return 'taskQueue'
  if (trigger.blockingTrigger) return 'blocking'
  if (trigger.httpsTrigger)
    return trigger.labels?.['deployment-callable'] === 'true' ? 'callable' : 'https'
  if (trigger.schedule || trigger.scheduleTrigger) return 'schedule'
  const event = trigger.eventTrigger
  if (!event) return 'unknown'
  if (event.channel) return 'eventarc'
  const type = String(event.eventType ?? '')
  if (type.includes('firestore')) return 'firestore'
  if (type.includes('database')) return 'database'
  if (type.includes('pubsub')) return 'pubsub'
  if (type.includes('storage')) return 'storage'
  if (type.includes('auth')) return 'auth'
  return 'event'
}

export interface EventAuth {
  admin: boolean
  variable?: unknown
}

/** FunctionsEmulatorShell.createLegacyEvent (first-generation functions). */
export function legacyEvent(
  eventType: string | undefined,
  data: unknown,
  opts: { resource?: unknown; params?: unknown; auth?: EventAuth | undefined } = {},
  clock: EnvelopeClock = DEFAULT_CLOCK,
): Record<string, unknown> {
  let resource = opts.resource
  if (isObject(resource) && resource.name) resource = resource.name
  return {
    eventId: clock.uuid(),
    timestamp: clock.now().toISOString(),
    eventType,
    resource,
    params: opts.params,
    auth: { admin: opts.auth?.admin ?? false, variable: opts.auth?.variable },
    data,
  }
}

/** FunctionsEmulatorShell.createCloudEvent (second-generation functions). */
export function cloudEvent(
  eventType: string | undefined,
  data: unknown,
  source = '',
  extensions: Record<string, unknown> = {},
  clock: EnvelopeClock = DEFAULT_CLOCK,
): Record<string, unknown> {
  return {
    specversion: '1.0',
    datacontenttype: 'application/json',
    id: clock.uuid(),
    type: eventType,
    time: clock.now().toISOString(),
    source,
    data,
    ...extensions,
  }
}

/**
 * LocalFunction.substituteParams: wildcards take the param or, like the
 * shell, the wildcard name with a random digit.
 */
export function substituteParams(
  pattern: string,
  params?: Record<string, string> | undefined,
  random: () => number = Math.random,
): string {
  return String(pattern).replace(/{[^/{}]*}/g, (wildcard) => {
    const name = wildcard.slice(1, -1).replace(/=\*\*$/, '')
    return params?.[name] || `${name}${1 + Math.floor(random() * 9)}`
  })
}

/**
 * The wildcard values a concrete path gives a pattern (`users/{uid}` and
 * `users/alice` yield {uid: "alice"}); `{rest=**}` takes the remainder.
 */
export function matchParams(pattern: string | undefined, path: string): Record<string, string> {
  const params: Record<string, string> = {}
  if (!pattern) return params
  const wildcards = String(pattern).split('/')
  const segments = String(path).split('/')
  for (const [index, part] of wildcards.entries()) {
    const match = /^{([^/{}=]+)(=\*\*)?}$/.exec(part)
    if (!match?.[1]) continue
    params[match[1]] = match[2] ? segments.slice(index).join('/') : (segments[index] ?? '')
  }
  return params
}

/** Whether a concrete document path fits a pattern (`orders/o1` fits `orders/{orderId}`). */
export function fitsPattern(pattern: string, path: string): boolean {
  const wildcards = pattern.split('/')
  const segments = path.split('/')
  for (const [index, part] of wildcards.entries()) {
    if (/^{[^/{}=]+=\*\*}$/.test(part)) return segments.length > index
    if (segments[index] === undefined) return false
    if (!/^{[^/{}]+}$/.test(part) && part !== segments[index]) return false
  }
  return segments.length === wildcards.length
}

// ── Firestore values (packages/cli/src/firestore-values.mjs) ─────────────

/** The relative document path of a full name (`users/alice`), or the input when it is already relative. */
export function relativePath(name: string): string {
  const match = /^projects\/[^/]+\/databases\/[^/]+\/documents\/(.*)$/.exec(String(name))
  return match?.[1] ?? String(name).replace(/(^\/+|\/+$)/g, '')
}

function documentName(path: string, project: string | undefined, database = '(default)'): string {
  const trimmed = String(path).replace(/(^\/+|\/+$)/g, '')
  if (trimmed.startsWith('projects/')) return trimmed
  return `projects/${project}/databases/${database}/documents/${trimmed}`
}

function sentinel(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0]?.startsWith('$') ? keys[0] : undefined
}

type Context = { project?: string | undefined; database?: string | undefined }

/** One plain JSON value as a Firestore REST value, the shell's encoding plus the CLI's sentinels. */
export function encodeValue(value: unknown, context: Context = {}): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return { integerValue: value }
    if (!Number.isFinite(value)) throw new Error(`Cannot encode ${value} as a Firestore Value`)
    return { doubleValue: value }
  }
  if (typeof value === 'bigint') return { integerValue: value.toString() }
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' }
  if (Array.isArray(value))
    return { arrayValue: { values: value.map((item) => encodeValue(item, context)) } }
  if (isPlainObject(value)) {
    const key = sentinel(value)
    if (key === '$timestamp') {
      const raw = value.$timestamp
      const date = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN)
      if (Number.isNaN(date.getTime()))
        throw new Error('$timestamp must be an RFC 3339 date string')
      return { timestampValue: date.toISOString() }
    }
    if (key === '$ref') {
      const ref = value.$ref
      if (typeof ref !== 'string' || !ref) throw new Error('$ref must be a document path')
      if (!context.project && !ref.startsWith('projects/'))
        throw new Error('$ref needs a project to complete a relative document path')
      return { referenceValue: documentName(ref, context.project, context.database) }
    }
    if (key === '$geo') {
      const geo = isObject(value.$geo) ? value.$geo : {}
      const { latitude, longitude } = geo
      if (typeof latitude !== 'number' || typeof longitude !== 'number')
        throw new Error('$geo must be {latitude, longitude}')
      return { geoPointValue: { latitude, longitude } }
    }
    if (key === '$bytes') {
      if (typeof value.$bytes !== 'string') throw new Error('$bytes must be a base64 string')
      return { bytesValue: value.$bytes }
    }
    return { mapValue: { fields: encodeFields(value, context) } }
  }
  throw new Error(`Cannot encode ${typeof value} as a Firestore Value`)
}

/** An object's entries as a `fields` map (undefined values are skipped). */
export function encodeFields(data: unknown, context: Context = {}): Record<string, unknown> {
  if (!isPlainObject(data)) throw new Error('Firestore data must be key-value pairs.')
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data))
    if (value !== undefined) fields[key] = encodeValue(value, context)
  return fields
}

/** LocalFunction.makeFirestoreValue, plus the document name the SDK prefers. */
export function firestoreValue(
  input: unknown,
  name: string,
  clock: EnvelopeClock = DEFAULT_CLOCK,
): Record<string, unknown> {
  if (input === undefined || input === null || (isObject(input) && Object.keys(input).length === 0))
    return {}
  if (!isObject(input)) throw new Error('Firestore data must be key-value pairs.')
  const currentTime = clock.now().toISOString()
  return { name, fields: encodeFields(input), createTime: currentTime, updateTime: currentTime }
}

/** The REST fields of a stored document back as plain JSON with the CLI's sentinels (to start from it). */
export function decodeFields(fields: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(isObject(fields) ? fields : {}))
    data[key] = decodeValue(value)
  return data
}

function decodeValue(value: unknown): unknown {
  if (!isObject(value)) return null
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue
  if (Object.hasOwn(value, 'booleanValue')) return value.booleanValue
  if (Object.hasOwn(value, 'integerValue')) {
    const number = Number(value.integerValue)
    return Number.isSafeInteger(number) ? number : String(value.integerValue)
  }
  if (Object.hasOwn(value, 'doubleValue')) {
    const raw = value.doubleValue
    return typeof raw === 'string' ? (raw === 'NaN' ? Number.NaN : Number(raw)) : raw
  }
  if (Object.hasOwn(value, 'nullValue')) return null
  if (Object.hasOwn(value, 'timestampValue')) return { $timestamp: value.timestampValue }
  if (Object.hasOwn(value, 'referenceValue'))
    return { $ref: relativePath(String(value.referenceValue)) }
  if (Object.hasOwn(value, 'geoPointValue')) {
    const geo = isObject(value.geoPointValue) ? value.geoPointValue : {}
    return { $geo: { latitude: geo.latitude ?? 0, longitude: geo.longitude ?? 0 } }
  }
  if (Object.hasOwn(value, 'bytesValue')) return { $bytes: value.bytesValue }
  if (Object.hasOwn(value, 'arrayValue')) {
    const array = isObject(value.arrayValue) ? value.arrayValue : {}
    return (Array.isArray(array.values) ? array.values : []).map(decodeValue)
  }
  if (Object.hasOwn(value, 'mapValue')) {
    const map = isObject(value.mapValue) ? value.mapValue : {}
    return decodeFields(map.fields)
  }
  return null
}

// ── The builders ─────────────────────────────────────────────────────────

/** Options a person can set beside the event data: the shell's `--params`, `--auth`, `--resource`, `--event-type`. */
export interface EnvelopeOptions {
  params?: Record<string, string> | undefined
  auth?: EventAuth | undefined
  resource?: string | undefined
  eventType?: string | undefined
}

/** A test event: the body to post to the trigger route, and what the shell would also say about it. */
export interface TestEnvelope {
  kind: ShellKind
  transport: 'functions' | 'tasks'
  body?: Record<string, unknown>
  headers?: Record<string, string>
  /** Firestore: the full document name. */
  document?: string
  /** Pub/Sub: the message and its topic (short name). */
  message?: Record<string, unknown>
  topic?: string
  /** A task queue's task, as the CLI enqueues it. */
  task?: Record<string, unknown>
}

function firestoreEnvelope(
  trigger: BackendDefinition,
  project: string,
  eventData: unknown,
  opts: EnvelopeOptions,
  clock: EnvelopeClock,
  random: () => number,
): TestEnvelope {
  const event = trigger.eventTrigger ?? {}
  const v2 = trigger.platform === 'gcfv2'
  const database = event.eventFilters?.database || '(default)'
  const pattern = v2
    ? (event.eventFilterPathPatterns?.document ?? event.eventFilters?.document)
    : event.resource
  const relativePattern = pattern ? relativePath(pattern) : undefined
  let document: string
  let params = opts.params
  if (opts.resource) {
    document = relativePath(opts.resource)
    params ??= matchParams(relativePattern, document)
  } else if (relativePattern) {
    document = substituteParams(relativePattern, params, random)
    params ??= matchParams(relativePattern, document)
  } else throw new Error(`${trigger.name} declares no document pattern; pass the document path`)
  if (document.split('/').length % 2)
    throw new Error(
      `${document} is not a document path (collection/document[/subcollection/document...])`,
    )
  const name = `projects/${project}/databases/${database}/documents/${document}`
  const operation = String(event.eventType)
    .replace(/\.withAuthContext$/, '')
    .split('.')
    .pop()
  const explicit =
    isObject(eventData) && (Object.hasOwn(eventData, 'before') || Object.hasOwn(eventData, 'after'))
  const before = explicit ? (eventData as Record<string, unknown>).before : undefined
  const after = explicit ? (eventData as Record<string, unknown>).after : eventData
  let data: Record<string, unknown>
  switch (operation) {
    case 'create':
    case 'created':
      data = { value: firestoreValue(after, name, clock), oldValue: {} }
      break
    case 'delete':
    case 'deleted':
      data = { value: {}, oldValue: firestoreValue(explicit ? before : eventData, name, clock) }
      break
    default:
      data = {
        value: firestoreValue(after, name, clock),
        oldValue: firestoreValue(before, name, clock),
      }
  }
  if (!v2)
    return {
      kind: 'firestore',
      transport: 'functions',
      body: legacyEvent(event.eventType, data, { resource: name, params, auth: opts.auth }, clock),
      document: name,
    }
  const extensions: Record<string, unknown> = {
    document,
    project,
    database,
    namespace: '(default)',
  }
  if (String(event.eventType).endsWith('.withAuthContext')) Object.assign(extensions, AUTH_CONTEXT)
  return {
    kind: 'firestore',
    transport: 'functions',
    body: cloudEvent(event.eventType, data, 'projects/_/databases/(default)', extensions, clock),
    document: name,
  }
}

function storageEnvelope(
  trigger: BackendDefinition,
  project: string,
  eventData: unknown,
  opts: EnvelopeOptions,
  storage: string | undefined,
  clock: EnvelopeClock,
): TestEnvelope {
  const event = trigger.eventTrigger ?? {}
  const v2 = trigger.platform === 'gcfv2'
  const declared = v2 ? event.eventFilters?.bucket : event.resource
  const given =
    isObject(eventData) && typeof eventData.bucket === 'string' ? eventData.bucket : undefined
  const bucket =
    given ||
    (declared ? String(declared).replace(/^projects\/_\/buckets\//, '') : `${project}.appspot.com`)
  if (!isObject(eventData) || typeof eventData.name !== 'string' || !eventData.name)
    throw new Error(
      'Storage events need the object, e.g. {"name":"uploads/photo.png","contentType":"image/png","size":"1024"}',
    )
  const now = clock.now().toISOString()
  const generation = String(eventData.generation ?? clock.now().getTime())
  const object = encodeURIComponent(eventData.name)
  const data: Record<string, unknown> = {
    kind: 'storage#object',
    id: `${bucket}/${eventData.name}/${generation}`,
    bucket,
    name: eventData.name,
    generation,
    metageneration: '1',
    contentType: 'application/octet-stream',
    size: '0',
    storageClass: 'STANDARD',
    timeCreated: now,
    updated: now,
    timeStorageClassUpdated: now,
    ...(storage
      ? {
          selfLink: `${storage}/storage/v1/b/${bucket}/o/${object}`,
          mediaLink: `${storage}/download/storage/v1/b/${bucket}/o/${object}?generation=${generation}&alt=media`,
        }
      : {}),
    ...eventData,
  }
  for (const key of ['size', 'metageneration'])
    if (data[key] !== undefined) data[key] = String(data[key])
  if (!v2)
    return {
      kind: 'storage',
      transport: 'functions',
      body: legacyEvent(
        event.eventType,
        data,
        {
          resource: opts.resource ?? `projects/_/buckets/${bucket}/objects/${String(data.name)}`,
          params: opts.params,
          auth: opts.auth,
        },
        clock,
      ),
    }
  return {
    kind: 'storage',
    transport: 'functions',
    body: cloudEvent(event.eventType, data, `projects/_/buckets/${bucket}`, {}, clock),
  }
}

/**
 * A Pub/Sub message from {data, attributes, orderingKey}: string data is
 * sent as given, any other JSON value as its JSON text; both base64.
 */
export function pubsubMessage(eventData: unknown): Record<string, unknown> {
  if (eventData !== undefined && !isObject(eventData))
    throw new Error('A Pub/Sub event is {"data": ..., "attributes": {...}}')
  const message: Record<string, unknown> = {}
  const { data, attributes, orderingKey } = (eventData ?? {}) as Record<string, unknown>
  if (data !== undefined)
    message.data = utf8Base64(typeof data === 'string' ? data : JSON.stringify(data))
  if (attributes !== undefined) {
    if (
      !isObject(attributes) ||
      Object.values(attributes).some((value) => typeof value !== 'string')
    )
      throw new Error('Pub/Sub attributes must be a map of strings')
    message.attributes = attributes
  }
  if (orderingKey !== undefined) message.orderingKey = String(orderingKey)
  if (
    message.data === undefined &&
    Object.keys((message.attributes as object | undefined) ?? {}).length === 0
  )
    throw new Error('A Pub/Sub message needs data or at least one attribute')
  return message
}

/** A Pub/Sub function's topic, short name. */
export function topicOf(trigger: BackendDefinition): string {
  return (
    String(trigger.eventTrigger?.resource || trigger.eventTrigger?.eventFilters?.topic || '')
      .split('/')
      .pop() ?? ''
  )
}

function pubsubEnvelope(
  trigger: BackendDefinition,
  project: string,
  eventData: unknown,
  opts: EnvelopeOptions,
  clock: EnvelopeClock,
): TestEnvelope {
  const event = trigger.eventTrigger ?? {}
  const message = pubsubMessage(eventData)
  const topic = topicOf(trigger)
  if (trigger.platform !== 'gcfv2')
    return {
      kind: 'pubsub',
      transport: 'functions',
      body: legacyEvent(
        event.eventType,
        message,
        {
          resource: opts.resource ?? `projects/${project}/topics/${topic}`,
          params: opts.params,
          auth: opts.auth,
        },
        clock,
      ),
      message,
      topic,
    }
  return {
    kind: 'pubsub',
    transport: 'functions',
    body: cloudEvent(
      event.eventType,
      { message: { ...message, messageId: clock.uuid() } },
      event.eventFilters?.topic ?? topic,
      {},
      clock,
    ),
    message,
    topic,
  }
}

function authEnvelope(
  trigger: BackendDefinition,
  project: string,
  eventData: unknown,
  opts: EnvelopeOptions,
  clock: EnvelopeClock,
): TestEnvelope {
  if (trigger.platform === 'gcfv2')
    throw new Error(
      `${trigger.name} is a second-generation Auth function; only first-generation user.create/user.delete events can be injected`,
    )
  if (eventData !== undefined && !isObject(eventData))
    throw new Error(
      'An Auth event is a UserRecord object, e.g. {"uid":"alice","email":"alice@example.com"}',
    )
  const now = clock.now().toISOString()
  const record = (eventData ?? {}) as Record<string, unknown>
  const metadata = isObject(record.metadata) ? record.metadata : {}
  const data = {
    uid: clock.uuid(),
    ...record,
    metadata: { creationTime: now, lastSignInTime: now, ...metadata },
  }
  return {
    kind: 'auth',
    transport: 'functions',
    body: legacyEvent(
      trigger.eventTrigger?.eventType,
      data,
      { resource: opts.resource ?? `projects/${project}`, params: opts.params, auth: opts.auth },
      clock,
    ),
  }
}

function scheduleEnvelope(
  trigger: BackendDefinition,
  project: string,
  opts: EnvelopeOptions,
  clock: EnvelopeClock,
): TestEnvelope {
  const eventType = trigger.eventTrigger?.eventType || 'pubsub'
  if (trigger.platform !== 'gcfv2')
    return {
      kind: 'schedule',
      transport: 'functions',
      body: legacyEvent(
        eventType,
        {},
        {
          resource: opts.resource ?? `projects/${project}/topics/firebase-schedule-${trigger.name}`,
          params: opts.params,
          auth: opts.auth,
        },
        clock,
      ),
    }
  // The worker serves a second-generation schedule as an HTTP function; the
  // SDK reads Cloud Scheduler's headers for jobName/scheduleTime.
  const headers = {
    'x-cloudscheduler-jobname': `firebase-schedule-${trigger.name}-${trigger.region}`,
    'x-cloudscheduler-scheduletime': clock.now().toISOString(),
  }
  return {
    kind: 'schedule',
    transport: 'functions',
    body: cloudEvent(eventType, {}, '', {}, clock),
    headers,
  }
}

/** The envelope for one definition, or the shell's own sentence for one it cannot inject. */
export function buildTestEvent(
  trigger: BackendDefinition,
  project: string,
  eventData: unknown,
  opts: EnvelopeOptions = {},
  services: { storage?: string | undefined } = {},
  clock: EnvelopeClock = DEFAULT_CLOCK,
  random: () => number = Math.random,
): TestEnvelope {
  const kind = triggerKind(trigger)
  const event = trigger.eventTrigger
  switch (kind) {
    case 'https':
    case 'callable':
      throw new Error(
        `${trigger.name} is an HTTPS${kind === 'callable' ? ' callable' : ''} function; call it, do not send it an event`,
      )
    case 'blocking':
      throw new Error(
        `${trigger.name} is an Auth blocking function; the Auth emulator calls it during sign-in/sign-up flows`,
      )
    case 'database':
      throw new Error(
        `${trigger.name} listens to Realtime Database, which Firenook does not emulate`,
      )
    case 'unknown':
      throw new Error(`${trigger.name} has no trigger Firenook can drive`)
    case 'taskQueue':
      return {
        kind,
        transport: 'tasks',
        task: {
          httpRequest: {
            url: '',
            oidcToken: { serviceAccountEmail: 'emulated-service-acct@email.com' },
            body: utf8Base64(JSON.stringify({ data: eventData ?? {} })),
            headers: { 'Content-Type': 'application/json' },
          },
        },
      }
    case 'firestore':
      return firestoreEnvelope(trigger, project, eventData, opts, clock, random)
    case 'storage':
      return storageEnvelope(trigger, project, eventData, opts, services.storage, clock)
    case 'pubsub':
      return pubsubEnvelope(trigger, project, eventData, opts, clock)
    case 'auth':
      return authEnvelope(trigger, project, eventData, opts, clock)
    case 'schedule':
      return scheduleEnvelope(trigger, project, opts, clock)
    case 'eventarc':
      return {
        kind,
        transport: 'functions',
        body: cloudEvent(opts.eventType || event?.eventType, eventData ?? {}, '', {}, clock),
      }
    default:
      return {
        kind,
        transport: 'functions',
        body:
          trigger.platform === 'gcfv2'
            ? cloudEvent(opts.eventType || event?.eventType, eventData ?? {}, '', {}, clock)
            : legacyEvent(event?.eventType, eventData ?? {}, opts, clock),
      }
  }
}
