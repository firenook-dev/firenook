import { describe, expect, it } from 'vitest'
import { type CodeMessage, messageAsCode, shellQuote } from './code'

const ORIGIN = 'http://127.0.0.1:8085'
/** UTF-8 text as base64, the way the engine sends a message's data. */
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

const json: CodeMessage = {
  topic: 'projects/demo/topics/orders',
  dataBase64: base64('{"orderId":"o_1","amount":4.5}'),
  dataText: '{"orderId":"o_1","amount":4.5}',
  dataJson: true,
  attributes: { region: 'eu', googclient_schemaencoding: 'JSON' },
  orderingKey: 'cust-1',
}

describe('a published message as code (U-04)', () => {
  it('Node: compact JSON as json, with its attributes, the schema ones too, and its ordering key', () => {
    expect(messageAsCode(json, 'node', ORIGIN)).toBe(
      [
        "import { PubSub } from '@google-cloud/pubsub'",
        '',
        '// The client goes to the emulator while PUBSUB_EMULATOR_HOST is set.',
        'process.env.PUBSUB_EMULATOR_HOST ??= "127.0.0.1:8085"',
        'const pubsub = new PubSub({ projectId: "demo" })',
        'const messageId = await pubsub.topic("orders", { messageOrdering: true }).publishMessage({',
        '  json: {',
        '    orderId: "o_1",',
        '    amount: 4.5,',
        '  },',
        '  attributes: {',
        '    region: "eu",',
        '    googclient_schemaencoding: "JSON",',
        '  },',
        '  orderingKey: "cust-1",',
        '})',
      ].join('\n'),
    )
  })

  it('Node: JSON that is not compact keeps its bytes, as text', () => {
    const spaced = {
      ...json,
      dataText: '{ "a": 1 }',
      dataBase64: base64('{ "a": 1 }'),
      orderingKey: null,
      attributes: {},
    }
    const code = messageAsCode(spaced, 'node', ORIGIN)
    expect(code).toContain('  data: Buffer.from("{ \\"a\\": 1 }"),')
    expect(code).toContain('pubsub.topic("orders").publishMessage({')
    expect(code).not.toContain('attributes')
  })

  it('binary and Avro data go as their base64, decoded, never pretended into JSON', () => {
    const binary = { ...json, dataText: null, dataJson: false, dataBase64: 'AAEC/w==' }
    expect(messageAsCode(binary, 'node', ORIGIN)).toContain(
      `  data: Buffer.from("AAEC/w==", 'base64'),`,
    )
    expect(messageAsCode(binary, 'curl', ORIGIN)).toContain('"data":"AAEC/w=="')
    expect(messageAsCode(binary, 'gcloud', ORIGIN)).toContain('gcloud sends --message as text')
  })

  it('curl: the Pub/Sub port, its HTTP/JSON publish, the exact base64', () => {
    expect(messageAsCode(json, 'curl', ORIGIN)).toBe(
      [
        "curl -X POST 'http://127.0.0.1:8085/v1/projects/demo/topics/orders:publish' \\",
        "  -H 'content-type: application/json' \\",
        `  -d '{"messages":[{"data":"${json.dataBase64}","attributes":{"region":"eu","googclient_schemaencoding":"JSON"},"orderingKey":"cust-1"}]}'`,
      ].join('\n'),
    )
  })

  it('gcloud: pointed at the emulator through CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB', () => {
    expect(messageAsCode(json, 'gcloud', ORIGIN)).toBe(
      [
        'CLOUDSDK_API_ENDPOINT_OVERRIDES_PUBSUB=http://127.0.0.1:8085/ \\',
        "gcloud pubsub topics publish 'orders' --project='demo' \\",
        `  --message='{"orderId":"o_1","amount":4.5}' \\`,
        "  --attribute='region=eu,googclient_schemaencoding=JSON' \\",
        "  --ordering-key='cust-1'",
      ].join('\n'),
    )
  })

  it('quotes what the shell would read: a quote, a newline, a comma in an attribute', () => {
    const awkward = {
      ...json,
      dataText: "it's\nhere",
      dataJson: false,
      dataBase64: base64("it's\nhere"),
      attributes: { list: 'a,b' },
      orderingKey: null,
    }
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    const gcloud = messageAsCode(awkward, 'gcloud', ORIGIN)
    expect(gcloud).toContain("--message='it'\\''s\nhere'")
    expect(gcloud).toContain("--attribute='^|^list=a,b'")
    expect(messageAsCode(awkward, 'node', ORIGIN)).toContain('data: Buffer.from("it\'s\\nhere")')
  })

  it('uses the address it is given: another host, an IPv6 one', () => {
    expect(messageAsCode(json, 'node', 'http://[::1]:9085')).toContain(
      'PUBSUB_EMULATOR_HOST ??= "[::1]:9085"',
    )
    expect(messageAsCode(json, 'curl', 'http://build-box.local:8085')).toContain(
      "'http://build-box.local:8085/v1/projects/demo/topics/orders:publish'",
    )
  })
})
