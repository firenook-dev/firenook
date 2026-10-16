import { describe, expect, it } from 'vitest'
import { looksLikeCurl, pathAfter, readCurl, shellWords } from './curl-paste'

const BASE = 'http://127.0.0.1:5001/demo-x/us-central1/api'

describe('a pasted curl command', () => {
  it('reads words as a shell does', () => {
    expect(shellWords(`curl -H 'x: a b' "q\\"t" plain\\ word`)).toEqual([
      'curl',
      '-H',
      'x: a b',
      'q"t',
      'plain word',
    ])
    expect(shellWords("curl \\\n  -X POST \\\n  'u'")).toEqual(['curl', '-X', 'POST', 'u'])
    expect(() => shellWords("curl 'open")).toThrow(/single quote/)
  })

  it('fills method, path, headers and a JSON body, and says so', () => {
    const pasted = readCurl(
      `curl -X POST '${BASE}/orders?x=1' -H 'x-demo: 2' -H 'content-type: application/json' -d '{"n":1}'`,
      BASE,
    )
    expect(pasted.method).toBe('POST')
    expect(pasted.path).toBe('/orders?x=1')
    expect(pasted.headers).toEqual([
      { key: 'x-demo', value: '2' },
      { key: 'content-type', value: 'application/json' },
    ])
    expect(pasted.body).toEqual({ kind: 'json', text: '{"n":1}' })
    expect(pasted.said).toBe('Filled from curl: POST, 2 headers, JSON body.')
  })

  it('takes a data flag as a POST and text as text', () => {
    const pasted = readCurl(`curl ${BASE} --data-raw 'hello'`, BASE)
    expect(pasted.method).toBe('POST')
    expect(pasted.path).toBe('/')
    expect(pasted.body).toEqual({ kind: 'text', text: 'hello' })
    expect(readCurl(`curl -I ${BASE}/x`, BASE).method).toBe('HEAD')
    expect(readCurl(`curl --json '{"a":1}' ${BASE}`, BASE).headers).toEqual([
      { key: 'content-type', value: 'application/json' },
    ])
  })

  it('refuses another function, a file body and what is not curl', () => {
    expect(() => readCurl('curl http://127.0.0.1:5001/demo-x/us-central1/other', BASE)).toThrow(
      /not api/,
    )
    expect(() => readCurl(`curl -d @body.json ${BASE}`, BASE)).toThrow(/from a file/)
    expect(() => readCurl('wget x', BASE)).toThrow(/not a curl command/)
    expect(() => readCurl('curl -H a:b', BASE)).toThrow(/names no URL/)
    expect(looksLikeCurl('  curl x')).toBe(true)
    expect(looksLikeCurl('/curl')).toBe(false)
    expect(pathAfter('/demo-x/us-central1/api/a', '/demo-x/us-central1/api')).toBe('/a')
  })
})
