// Code to paste into a terminal or a script. `CODE_DIALECTS` is the one
// list of the dialects the console writes code in, each with the label its
// tab shows on every page and the language of its block, so "Admin
// (Node.js)" reads the same in every section's Code popover; `codeTab`
// makes a `CodePopover` or `CodeBlock` tab from one.
//
// A composed request is written in three of them — curl, fetch or HTTPie —
// against the service's own address (`codeUrl`), never the console's
// mount, with the identity's token as the console sent it.

import type { CodeDialect as CodeTab, CodeLanguage } from '@/components/console/code-block'
import { authorizationFor } from '@/lib/identity'
import { type ComposedRequest, activePairs, bodyContentType, withQuery } from './types'

/** Every dialect the console writes code in: the label its tab shows everywhere, and its language. */
export const CODE_DIALECTS = {
  curl: { label: 'curl', language: 'shell' },
  fetch: { label: 'fetch', language: 'js' },
  httpie: { label: 'HTTPie', language: 'shell' },
  web: { label: 'Web', language: 'js' },
  flutter: { label: 'Flutter', language: 'dart' },
  node: { label: 'Admin (Node.js)', language: 'js' },
  python: { label: 'Python', language: 'python' },
  go: { label: 'Go', language: 'go' },
  rest: { label: 'REST (curl)', language: 'shell' },
  gcloud: { label: 'gcloud', language: 'shell' },
} as const satisfies Record<string, { label: string; language: CodeLanguage }>

export type CodeDialectId = keyof typeof CODE_DIALECTS

/** A tab of code in one of the console's dialects: its label and language from `CODE_DIALECTS`. */
export function codeTab(id: CodeDialectId, code: string): CodeTab {
  const { label, language } = CODE_DIALECTS[id]
  return { id, label, language, code }
}

/** The dialects a composed request is written in. */
export const REQUEST_DIALECTS = ['curl', 'fetch', 'httpie'] as const

export type RequestDialect = (typeof REQUEST_DIALECTS)[number]

/** Written for an Auth user whose engine token the caller did not pass. */
export const TOKEN_PLACEHOLDER = 'Bearer <ID token>'

/** A shell word in single quotes: `'` becomes `'\''`; newlines and unicode stay as they are. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * The headers code sends: the enabled ones (never the console's own
 * marker), the body's content type when none is named, and the identity's
 * token unless a header already sets one.
 */
function codeHeaders(
  request: ComposedRequest,
  project: string,
  authorization: string | undefined,
): [string, string][] {
  const headers: [string, string][] = activePairs(request.headers)
    .filter((pair) => pair.key.trim().toLowerCase() !== 'x-firenook-console')
    .map((pair) => [pair.key.trim(), pair.value])
  const named = (name: string) => headers.some(([key]) => key.toLowerCase() === name)
  const sends =
    request.body.kind !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
  const type = sends ? bodyContentType(request.body.kind) : undefined
  if (type && !named('content-type')) headers.push(['content-type', type])
  if (!named('authorization')) {
    const token =
      request.identity.kind === 'user'
        ? (authorization ?? TOKEN_PLACEHOLDER)
        : authorizationFor(request.identity, project)
    if (token) headers.unshift(['Authorization', token])
  }
  return headers
}

function sendsBody(request: ComposedRequest): boolean {
  return request.body.kind !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
}

function prettyJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function curl(request: ComposedRequest, headers: [string, string][]): string {
  const url = withQuery(request.codeUrl, request.query)
  const lines: string[] = []
  const base64 = sendsBody(request) && request.body.kind === 'base64'
  const verb =
    request.method === 'HEAD'
      ? 'curl -I'
      : request.method === 'GET'
        ? 'curl'
        : `curl -X ${request.method}`
  lines.push(`${verb} ${shellQuote(url)}`)
  for (const [key, value] of headers) lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`)
  if (sendsBody(request))
    lines.push(base64 ? '  --data-binary @-' : `  --data-raw ${shellQuote(request.body.text)}`)
  const command = lines.join(' \\\n')
  return base64
    ? `printf '%s' ${shellQuote(request.body.text.replace(/\s+/g, ''))} | base64 --decode |\n${command}`
    : command
}

function fetchCode(request: ComposedRequest, headers: [string, string][]): string {
  const url = withQuery(request.codeUrl, request.query)
  const options: string[] = []
  if (request.method !== 'GET') options.push(`  method: ${JSON.stringify(request.method)},`)
  if (headers.length > 0) {
    options.push('  headers: {')
    for (const [key, value] of headers)
      options.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    options.push('  },')
  }
  if (sendsBody(request)) {
    const json = request.body.kind === 'json' ? prettyJson(request.body.text) : undefined
    if (json !== undefined)
      options.push(
        `  body: JSON.stringify(${JSON.stringify(json, null, 2).replace(/\n/g, '\n  ')}),`,
      )
    else if (request.body.kind === 'base64')
      options.push(
        `  body: Uint8Array.from(atob(${JSON.stringify(request.body.text.replace(/\s+/g, ''))}), (c) => c.charCodeAt(0)),`,
      )
    else options.push(`  body: ${JSON.stringify(request.body.text)},`)
  }
  const call =
    options.length === 0
      ? `const response = await fetch(${JSON.stringify(url)})`
      : `const response = await fetch(${JSON.stringify(url)}, {\n${options.join('\n')}\n})`
  return `${call}\nconsole.log(response.status, await response.text())`
}

function httpie(request: ComposedRequest, headers: [string, string][]): string {
  const url = withQuery(request.codeUrl, request.query)
  const base64 = sendsBody(request) && request.body.kind === 'base64'
  const lines = [`http ${request.method} ${shellQuote(url)}`]
  for (const [key, value] of headers) lines.push(`  ${shellQuote(`${key}:${value}`)}`)
  if (sendsBody(request) && !base64) lines.push(`  --raw ${shellQuote(request.body.text)}`)
  const command = lines.join(' \\\n')
  return base64
    ? `printf '%s' ${shellQuote(request.body.text.replace(/\s+/g, ''))} | base64 --decode |\n${command}`
    : command
}

/**
 * The request as `dialect`. `authorization` is the token the console sends
 * for an Auth user (the engine's, which the caller resolves); without it a
 * user's request names a placeholder.
 */
export function requestAsCode(
  request: ComposedRequest,
  dialect: RequestDialect,
  project: string,
  authorization?: string,
): string {
  const headers = codeHeaders(request, project, authorization)
  if (dialect === 'curl') return curl(request, headers)
  if (dialect === 'fetch') return fetchCode(request, headers)
  return httpie(request, headers)
}
