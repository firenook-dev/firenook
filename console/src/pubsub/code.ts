// A published message as code (PS-16): the call that would publish exactly
// this message again — its bytes, its attributes (the schema's included),
// its ordering key — in the Node client, as curl against the Pub/Sub port,
// and as gcloud pointed at the emulator. What earns it its place is the data
// a model cannot know: the bytes as they are. JSON goes as JSON only when
// the client would write the same bytes back (compact, as JSON.stringify
// writes it); any other text goes as that text, and data that is not text
// goes as its base64, decoded, never pretended into JSON.
//
// The address is the engine's (`serviceAddress`'s host rule), never assumed.

/** The dialects a message is written in: ids of the console's one list, `CODE_DIALECTS`. */
export type MessageDialect = 'node' | 'curl' | 'gcloud'

export const MESSAGE_DIALECTS: readonly MessageDialect[] = ['node', 'curl', 'gcloud']

/** What the code is built from: a message as the engine answers it, and where it lives. */
export interface CodeMessage {
  /** The topic's full name. */
  topic: string
  dataBase64: string
  /** The data as text, when it is valid UTF-8. */
  dataText: string | null
  dataJson: boolean
  attributes: { [key in string]: string }
  orderingKey: string | null
}

/** A string as a shell word: single-quoted, a quote written `'\''`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/** A string as a JavaScript literal (JSON's string escapes are JavaScript's). */
function jsString(text: string): string {
  return JSON.stringify(text).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/** A value as JavaScript source, indented by `pad`: object keys bare where they can be. */
function jsValue(value: unknown, pad: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const inner = `${pad}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${inner}${jsValue(item, inner)}`).join(',\n')},\n${pad}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries
    .map(([key, item]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : jsString(key)
      return `${inner}${name}: ${jsValue(item, inner)}`
    })
    .join(',\n')},\n${pad}}`
}

/** The JSON value of the data when the client's `json:` would send exactly these bytes. */
function compactJson(message: CodeMessage): { value: unknown } | undefined {
  if (!message.dataJson || message.dataText === null) return undefined
  try {
    const value = JSON.parse(message.dataText) as unknown
    return JSON.stringify(value) === message.dataText ? { value } : undefined
  } catch {
    return undefined
  }
}

function parts(topic: string): { project: string; id: string } {
  const match = /^projects\/([^/]*)\/topics\/(.+)$/.exec(topic)
  return match ? { project: match[1] ?? '', id: match[2] ?? topic } : { project: '', id: topic }
}

/** `http://127.0.0.1:8085` → `127.0.0.1:8085`, what PUBSUB_EMULATOR_HOST takes. */
function hostPort(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function nodeCode(message: CodeMessage, origin: string): string {
  const { project, id } = parts(message.topic)
  const json = compactJson(message)
  const fields: string[] = []
  if (json) fields.push(`  json: ${jsValue(json.value, '  ')},`)
  else if (message.dataText !== null)
    fields.push(`  data: Buffer.from(${jsString(message.dataText)}),`)
  else fields.push(`  data: Buffer.from(${jsString(message.dataBase64)}, 'base64'),`)
  const attributes = Object.entries(message.attributes)
  if (attributes.length > 0) fields.push(`  attributes: ${jsValue(message.attributes, '  ')},`)
  if (message.orderingKey) fields.push(`  orderingKey: ${jsString(message.orderingKey)},`)
  const ordering = message.orderingKey ? `, { messageOrdering: true }` : ''
  return [
    `import { PubSub } from '@google-cloud/pubsub'`,
    '',
    `// The client goes to the emulator while PUBSUB_EMULATOR_HOST is set.`,
    `process.env.PUBSUB_EMULATOR_HOST ??= ${jsString(hostPort(origin))}`,
    `const pubsub = new PubSub({ projectId: ${jsString(project)} })`,
    `const messageId = await pubsub.topic(${jsString(id)}${ordering}).publishMessage({`,
    ...fields,
    `})`,
  ].join('\n')
}

function curlCode(message: CodeMessage, origin: string): string {
  const { project, id } = parts(message.topic)
  const body = {
    messages: [
      {
        data: message.dataBase64,
        ...(Object.keys(message.attributes).length > 0 ? { attributes: message.attributes } : {}),
        ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
      },
    ],
  }
  const url = `${origin.replace(/\/$/, '')}/v1/projects/${project}/topics/${encodeURIComponent(id)}:publish`
  return [
    `curl -X POST ${shellQuote(url)} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join('\n')
}

/** gcloud's `--attribute` value: `k=v,k2=v2`, or with another delimiter when a value holds a comma. */
function attributeFlag(attributes: { [key in string]: string }): string | undefined {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return undefined
  const text = entries.map(([key, value]) => `${key}=${value}`)
  const all = text.join('')
  if (!all.includes(',')) return text.join(',')
  const delimiter = ['|', ';', '#', '~', '!'].find((candidate) => !all.includes(candidate))
  return delimiter ? `^${delimiter}^${text.join(delimiter)}` : undefined
}

function gcloudCode(message: CodeMessage, origin: string): string {
  const { project, id } = parts(message.topic)
  const lines = [
    `CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB=${origin.replace(/\/$/, '')}/ \\`,
    `gcloud pubsub topics publish ${shellQuote(id)} --project=${shellQuote(project)} \\`,
  ]
  if (message.dataText === null)
    return [
      `# This message's data is not text, and gcloud sends --message as text,`,
      `# so it could not publish the same bytes. The curl and Node tabs do.`,
    ].join('\n')
  const flags = [`  --message=${shellQuote(message.dataText)}`]
  const attributes = attributeFlag(message.attributes)
  if (attributes !== undefined) flags.push(`  --attribute=${shellQuote(attributes)}`)
  if (message.orderingKey) flags.push(`  --ordering-key=${shellQuote(message.orderingKey)}`)
  return [...lines, flags.join(' \\\n')].join('\n')
}

/** The message as code in `dialect`, against the Pub/Sub port at `origin`. */
export function messageAsCode(
  message: CodeMessage,
  dialect: MessageDialect,
  origin: string,
): string {
  if (dialect === 'node') return nodeCode(message, origin)
  if (dialect === 'curl') return curlCode(message, origin)
  return gcloudCode(message, origin)
}
