import { describe, expect, it } from 'vitest'
import { TOKEN_PLACEHOLDER, requestAsCode, shellQuote } from './as-code'
import type { ComposedRequest } from './types'

const base: ComposedRequest = {
  method: 'POST',
  url: '/console/api/v1/functions/native/demo-x/us-central1/greet',
  codeUrl: 'http://127.0.0.1:5001/demo-x/us-central1/greet',
  query: [
    { key: 'name', value: 'ada lovelace', enabled: true },
    { key: 'debug', value: '1', enabled: false },
  ],
  headers: [
    { key: 'x-trace', value: 'abc123', enabled: true },
    { key: 'x-firenook-console', value: '1', enabled: true },
  ],
  body: { kind: 'json', text: '{"greeting":"it\'s ünïcode","lines":"a\\nb"}' },
  identity: { kind: 'anonymous' },
}

describe('a request as code', () => {
  it('writes curl for the service address, with the query, headers and body', () => {
    const code = requestAsCode(base, 'curl', 'demo-x')
    expect(code).toBe(
      [
        "curl -X POST 'http://127.0.0.1:5001/demo-x/us-central1/greet?name=ada+lovelace' \\",
        "  -H 'x-trace: abc123' \\",
        "  -H 'content-type: application/json' \\",
        `  --data-raw '{"greeting":"it'\\''s ünïcode","lines":"a\\nb"}'`,
      ].join('\n'),
    )
    // Never the console's own marker, never the console's mount.
    expect(code).not.toContain('x-firenook-console')
    expect(code).not.toContain('/console/api')
  })

  it('quotes a single quote, keeps newlines and unicode inside the quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    const text = requestAsCode(
      { ...base, body: { kind: 'text', text: "line one\nit's — ok" }, headers: [] },
      'curl',
      'demo-x',
    )
    expect(text).toContain(`--data-raw 'line one\nit'\\''s — ok'`)
    expect(text).toContain('content-type: text/plain; charset=utf-8')
  })

  it('writes fetch with the JSON body tidied and every value escaped for JavaScript', () => {
    const code = requestAsCode(base, 'fetch', 'demo-x')
    expect(code).toContain(
      'const response = await fetch("http://127.0.0.1:5001/demo-x/us-central1/greet?name=ada+lovelace", {',
    )
    expect(code).toContain('  method: "POST",')
    expect(code).toContain('    "x-trace": "abc123",')
    expect(code).toContain('  body: JSON.stringify({')
    expect(code).toContain('"greeting": "it\'s ünïcode"')
    expect(code).toContain('console.log(response.status, await response.text())')
    const get = requestAsCode({ ...base, method: 'GET', headers: [], query: [] }, 'fetch', 'demo-x')
    expect(get).toBe(
      'const response = await fetch("http://127.0.0.1:5001/demo-x/us-central1/greet")\nconsole.log(response.status, await response.text())',
    )
  })

  it('writes HTTPie with name:value headers and a raw body', () => {
    const code = requestAsCode(
      { ...base, body: { kind: 'form', text: 'a=1&b=2' } },
      'httpie',
      'demo-x',
    )
    expect(code).toBe(
      [
        "http POST 'http://127.0.0.1:5001/demo-x/us-central1/greet?name=ada+lovelace' \\",
        "  'x-trace:abc123' \\",
        "  'content-type:application/x-www-form-urlencoded' \\",
        "  --raw 'a=1&b=2'",
      ].join('\n'),
    )
  })

  it('pipes bytes through base64 for curl and HTTPie, and decodes them for fetch', () => {
    const bytes = {
      ...base,
      headers: [],
      query: [],
      body: { kind: 'base64', text: 'AAEC\n/w==' },
    } as const
    expect(requestAsCode(bytes, 'curl', 'demo-x')).toBe(
      [
        "printf '%s' 'AAEC/w==' | base64 --decode |",
        "curl -X POST 'http://127.0.0.1:5001/demo-x/us-central1/greet' \\",
        "  -H 'content-type: application/octet-stream' \\",
        '  --data-binary @-',
      ].join('\n'),
    )
    expect(requestAsCode(bytes, 'httpie', 'demo-x')).toContain(
      "printf '%s' 'AAEC/w==' | base64 --decode |\nhttp POST",
    )
    expect(requestAsCode(bytes, 'fetch', 'demo-x')).toContain(
      'body: Uint8Array.from(atob("AAEC/w=="), (c) => c.charCodeAt(0)),',
    )
  })

  it('sends no body for GET and HEAD, and none for a body of kind none', () => {
    expect(
      requestAsCode({ ...base, method: 'GET', headers: [], query: [] }, 'curl', 'demo-x'),
    ).toBe("curl 'http://127.0.0.1:5001/demo-x/us-central1/greet'")
    expect(
      requestAsCode({ ...base, method: 'HEAD', headers: [], query: [] }, 'curl', 'demo-x'),
    ).toBe("curl -I 'http://127.0.0.1:5001/demo-x/us-central1/greet'")
    expect(
      requestAsCode(
        { ...base, headers: [], query: [], body: { kind: 'none', text: 'x' } },
        'httpie',
        'demo-x',
      ),
    ).toBe("http POST 'http://127.0.0.1:5001/demo-x/us-central1/greet'")
  })

  it("carries the identity's token as the console sends it", () => {
    const owner = requestAsCode({ ...base, identity: { kind: 'owner' } }, 'curl', 'demo-x')
    expect(owner).toContain("-H 'Authorization: Bearer owner'")
    const custom = requestAsCode(
      { ...base, identity: { kind: 'custom', uid: 'tester', claims: { admin: true } } },
      'httpie',
      'demo-x',
    )
    expect(custom).toMatch(/'Authorization:Bearer [\w-]+\.[\w-]+\.'/)
    const user = { ...base, identity: { kind: 'user', uid: 'u1' } } as const
    expect(requestAsCode(user, 'curl', 'demo-x', 'Bearer engine-token')).toContain(
      "-H 'Authorization: Bearer engine-token'",
    )
    expect(requestAsCode(user, 'curl', 'demo-x')).toContain(
      `-H 'Authorization: ${TOKEN_PLACEHOLDER}'`,
    )
    // A header that sets its own authorization wins.
    const explicit = {
      ...user,
      headers: [{ key: 'Authorization', value: 'Bearer mine', enabled: true }],
    }
    const code = requestAsCode(explicit, 'curl', 'demo-x', 'Bearer engine-token')
    expect(code).toContain('Authorization: Bearer mine')
    expect(code).not.toContain('engine-token')
  })
})
