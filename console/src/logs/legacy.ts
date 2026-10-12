// A Google Emulator UI log query, read into the console's filter language,
// so a link shared from the Google UI opens the same view here. Its query
// is `key="value"` pairs and free text (`QueryBar.tsx` in the UI 1.15
// sources): `level`, `metadata.emulator(.name)`, `metadata.function(.name)`,
// `metadata.extension.instanceId`, `user.<path>` or `user["<key>"]`, and
// `search` for text. Ours writes `level:error service:functions
// function:us-central1-hello instance:x payload.orderId:"o_1"` and words.
//
// A query is the Google UI's when one of its pairs is there: a pair with
// one of those keys and `=`. Only those pairs are rewritten; every other
// item is left exactly as it was typed, so a filter of ours is never
// touched. The route rewrites before the page loads, so this module is in
// the first chunk: it stays small and imports nothing.

/** One item of a query: a `key=value` pair, or anything else, with the text it was written as. */
type LegacyItem = { key: string; value: string; quoted: boolean; raw: string } | { raw: string }

const KEY = /^[A-Za-z][\w.-]*(?:\[\s*"(?:[^"\\]|\\.)*"\s*\])*/

const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character)

/** A quoted string starting at `at`: its text, unescaped, and where it ends; undefined when unclosed. */
function quoted(text: string, at: number): { value: string; end: number } | undefined {
  let read = ''
  for (let index = at + 1; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\' && index + 1 < text.length) {
      read += text[index + 1]
      index += 1
    } else if (character === '"') return { value: read, end: index + 1 }
    else read += character
  }
  return undefined
}

/** The end of the run of non-space characters from `at`. */
function runEnd(text: string, at: number): number {
  let end = at
  while (end < text.length && !isSpace(text[end])) end += 1
  return end
}

/** The items of a query, in order. */
export function legacyItems(text: string): LegacyItem[] {
  const items: LegacyItem[] = []
  let at = 0
  while (at < text.length) {
    while (isSpace(text[at])) at += 1
    if (at >= text.length) break
    const key = text[at] === '"' ? undefined : KEY.exec(text.slice(at))?.[0]
    if (key && text[at + key.length] === '=') {
      const start = at + key.length + 1
      const inQuotes = text[start] === '"' ? quoted(text, start) : undefined
      const end = inQuotes ? inQuotes.end : runEnd(text, start)
      items.push({
        key,
        value: inQuotes ? inQuotes.value : text.slice(start, end),
        quoted: inQuotes !== undefined,
        raw: text.slice(at, end),
      })
      at = end
      continue
    }
    // A phrase keeps its spaces; anything else runs to the next space.
    const words = text[at] === '"' ? quoted(text, at) : undefined
    const end = words ? words.end : runEnd(text, at)
    items.push({ raw: text.slice(at, end) })
    at = end
  }
  return items
}

/** `text` as a quoted phrase: backslashes and quotes escaped. */
function quote(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** A term's value: bare when it reads back as itself, else quoted. */
function valueText(text: string): string {
  return text !== '' && !/[\s"]/.test(text) && !/^[<>=]/.test(text) ? text : quote(text)
}

/** Text as a word: bare when it reads back as itself, else a quoted phrase. */
function word(text: string): string {
  return /^[^\s"/-][^\s"]*$/.test(text) && !/^[A-Za-z][\w.-]*[:=]/.test(text) ? text : quote(text)
}

/** The engine's level spellings (`LogLevel::parse`), read the way it reads them. */
function level(text: string): string {
  const upper = text.toUpperCase()
  if (upper === 'DEBUG') return 'debug'
  if (upper === 'WARN' || upper === 'WARNING') return 'warn'
  if (['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(upper)) return 'error'
  if (['INFO', 'NOTICE', 'DEFAULT', 'BULLET', 'SUCCESS', 'USER'].includes(upper)) return 'info'
  return text
}

/**
 * `user.orderId`, `user["orderId"]`, `user["a"]["b"]` → `['orderId']`,
 * `['a', 'b']`; undefined when the key is not a user path.
 */
function userPath(key: string): string[] | undefined {
  if (!/^user(?=[.[])/i.test(key)) return undefined
  const rest = key.slice(4)
  const segments: string[] = []
  let consumed = 0
  for (const match of rest.matchAll(/\.([\w-]+)|\[\s*"((?:[^"\\]|\\.)*)"\s*\]/g)) {
    if (match.index !== consumed) return undefined
    consumed += match[0].length
    segments.push(match[1] ?? (match[2] ?? '').replace(/\\(.)/g, '$1'))
  }
  return consumed === rest.length && segments.length > 0 ? segments : undefined
}

/** A Google UI pair in our language, or undefined for a pair that is not one of its keys. */
function rewrite(item: { key: string; value: string; quoted: boolean }): string | undefined {
  const key = item.key.toLowerCase()
  if (key === 'level') return `level:${valueText(level(item.value))}`
  if (key === 'search') return word(item.value)
  if (key === 'metadata.emulator' || key === 'metadata.emulator.name')
    return `service:${valueText(item.value.toLowerCase())}`
  if (key === 'metadata.function' || key === 'metadata.function.name')
    return `function:${valueText(item.value)}`
  if (key === 'metadata.extension.instanceid') return `instance:${valueText(item.value)}`
  const path = userPath(item.key)
  if (path === undefined) return undefined
  // A key our path cannot write (a dot or a space in it) has no term; its
  // value is still searched for, as text.
  if (!path.every((segment) => /^[\w-]+$/.test(segment))) return word(item.value)
  return `payload.${path.join('.')}:${item.quoted ? quote(item.value) : valueText(item.value)}`
}

/**
 * Our filter for a Google UI query, or `undefined` when `text` holds none of
 * its pairs (a filter of ours, or nothing).
 */
export function fromLegacyQuery(text: string): string | undefined {
  const items = legacyItems(text)
  const written = items.map((item) => ('key' in item ? rewrite(item) : undefined))
  if (written.every((item) => item === undefined)) return undefined
  return items.map((item, index) => written[index] ?? item.raw).join(' ')
}
