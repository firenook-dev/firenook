// A curl command pasted into the Invoke form's address: read as a shell
// would read it (quotes, escapes, line continuations), then turned into the
// form's fields — the method, the path after this function's address, the
// headers and the body — with a sentence of what was taken. A command for
// another function, or something that is not curl, is refused in words.

/** The words of a POSIX shell command line: quotes and backslashes as a shell reads them. */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && /["\\$`\n]/.test(text.charAt(index + 1))) {
        index += 1
        if (text.charAt(index) !== '\n') word += text.charAt(index)
      } else word += char
      continue
    }
    if (char === '\\') {
      const next = text.charAt(index + 1)
      index += 1
      if (next === '\n' || next === '\r') {
        if (next === '\r' && text.charAt(index + 1) === '\n') index += 1
        continue
      }
      word += next
      inWord = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    word += char
    inWord = true
  }
  if (quote) throw new Error(`A ${quote === "'" ? 'single' : 'double'} quote is not closed.`)
  if (inWord) words.push(word)
  return words
}

export interface PastedRequest {
  method: string
  /** After the function's address, with its query: `/orders?x=1`. */
  path: string
  headers: { key: string; value: string }[]
  body: { kind: 'none' | 'json' | 'text'; text: string }
  /** "Filled from curl: POST, 2 headers, JSON body." */
  said: string
}

/** Whether pasted text is a curl command (and so should be read rather than typed). */
export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\s|$)/.test(text)
}

const DATA_FLAGS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
])
const IGNORED_WITH_VALUE = new Set([
  '-u',
  '--user',
  '-o',
  '--output',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '--connect-timeout',
  '-m',
  '--max-time',
])

/**
 * Reads a curl command against a function's address (`base` is the
 * function's URL as apps reach it, or its path `/project/region/name`).
 */
export function readCurl(text: string, base: string): PastedRequest {
  const words = shellWords(text.trim())
  if (words[0] !== 'curl') throw new Error('This is not a curl command.')
  let method: string | undefined
  let url: string | undefined
  const headers: { key: string; value: string }[] = []
  const data: string[] = []
  let json = false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    const value = () => {
      index += 1
      const next = words[index]
      if (next === undefined) throw new Error(`${word} needs a value.`)
      return next
    }
    if (word === '-X' || word === '--request') method = value().toUpperCase()
    else if (word.startsWith('-X') && word.length > 2) method = word.slice(2).toUpperCase()
    else if (word === '-H' || word === '--header') {
      const header = value()
      const colon = header.indexOf(':')
      if (colon > 0)
        headers.push({ key: header.slice(0, colon).trim(), value: header.slice(colon + 1).trim() })
    } else if (DATA_FLAGS.has(word)) {
      if (word === '--json') json = true
      const payload = value()
      if (payload.startsWith('@'))
        throw new Error(
          `curl reads ${payload.slice(1)} from a file; paste its contents as the body instead.`,
        )
      data.push(payload)
    } else if (word === '-I' || word === '--head') method = 'HEAD'
    else if (word === '-G' || word === '--get') method = 'GET'
    else if (word === '--url') url = value()
    else if (IGNORED_WITH_VALUE.has(word)) value()
    else if (word.startsWith('-')) continue
    else url ??= word
  }
  if (!url) throw new Error('The curl command names no URL.')
  const path = pathAfter(url, base)
  const bodyText = data.join('&')
  if (json && !headers.some((header) => header.key.toLowerCase() === 'content-type'))
    headers.push({ key: 'content-type', value: 'application/json' })
  const body: PastedRequest['body'] =
    bodyText === ''
      ? { kind: 'none', text: '' }
      : isJson(bodyText)
        ? { kind: 'json', text: bodyText }
        : { kind: 'text', text: bodyText }
  const finalMethod = method ?? (bodyText === '' ? 'GET' : 'POST')
  const parts = [finalMethod]
  if (headers.length > 0)
    parts.push(`${headers.length} ${headers.length === 1 ? 'header' : 'headers'}`)
  if (body.kind !== 'none') parts.push(body.kind === 'json' ? 'JSON body' : 'text body')
  return {
    method: finalMethod,
    path,
    headers,
    body,
    said: `Filled from curl: ${parts.join(', ')}.`,
  }
}

function isJson(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** The path and query after the function's address, or why the URL is another function's. */
export function pathAfter(url: string, base: string): string {
  const basePath = (() => {
    try {
      return new URL(base).pathname
    } catch {
      return base
    }
  })().replace(/\/+$/, '')
  let target: URL
  try {
    target = new URL(url, 'http://placeholder.invalid')
  } catch {
    throw new Error(`${url} is not a URL.`)
  }
  const path = target.pathname
  if (path !== basePath && !path.startsWith(`${basePath}/`)) {
    const name = basePath.split('/').pop() ?? ''
    throw new Error(
      `This curl command calls ${path}, not ${name} (${basePath}). Open that function to send it.`,
    )
  }
  const rest = path.slice(basePath.length)
  return `${rest === '' ? '/' : rest}${target.search}`
}
