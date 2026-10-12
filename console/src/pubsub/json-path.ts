// Where a JSON path the engine names lands in the text the person typed:
// the schema check answers `$.items[2].price: expected double, found
// string`, and the editor marks that value where it is written. Paths are
// written the engine's way (`avro.rs`): `$` for the whole message, `.name`
// for a key of letters, digits and underscores, `["any key"]` otherwise,
// `[2]` for an array's third item.
//
// A path that names a field the message does not have (a required field
// left out) lands on the nearest part that exists — the object that should
// hold it — so the mark is still where the fix goes.

/** A span of the text: `from` inclusive, `to` exclusive, UTF-16 offsets. */
export interface TextSpan {
  from: number
  to: number
}

const SPACE = new Set([' ', '\t', '\n', '\r'])

/** Ends the scan: the text is not JSON. */
function fail(): never {
  throw new Error('not JSON')
}

/** The engine's spelling of a key in a path. */
function keySegment(key: string): string {
  return key !== '' && /^[A-Za-z0-9_]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
}

/**
 * Every value's span in `text`, by its path; undefined when the text is not
 * JSON. One pass, no values built: only where each one starts and ends.
 */
export function valueSpans(text: string): Map<string, TextSpan> | undefined {
  // The scanner only finds where values are; whether the text is JSON is the parser's call.
  try {
    JSON.parse(text)
  } catch {
    return undefined
  }
  const spans = new Map<string, TextSpan>()
  let at = 0
  const skip = () => {
    while (at < text.length && SPACE.has(text[at] ?? '')) at += 1
  }
  const string = (): string => {
    if (text[at] !== '"') fail()
    const start = at
    at += 1
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    if (at >= text.length) fail()
    at += 1
    return JSON.parse(text.slice(start, at)) as string
  }
  const value = (path: string) => {
    skip()
    const from = at
    const character = text[at]
    if (character === '{') {
      at += 1
      skip()
      if (text[at] === '}') at += 1
      else
        for (;;) {
          skip()
          const key = string()
          skip()
          if (text[at] !== ':') fail()
          at += 1
          value(`${path}${keySegment(key)}`)
          skip()
          if (text[at] === ',') {
            at += 1
            continue
          }
          if (text[at] === '}') {
            at += 1
            break
          }
          fail()
        }
    } else if (character === '[') {
      at += 1
      skip()
      if (text[at] === ']') at += 1
      else
        for (let index = 0; ; index += 1) {
          value(`${path}[${index}]`)
          skip()
          if (text[at] === ',') {
            at += 1
            continue
          }
          if (text[at] === ']') {
            at += 1
            break
          }
          fail()
        }
    } else if (character === '"') string()
    else {
      while (at < text.length && !SPACE.has(text[at] ?? '') && !',:{}[]"'.includes(text[at] ?? ''))
        at += 1
      if (at === from) fail()
    }
    spans.set(path, { from, to: at })
  }
  try {
    value('$')
    skip()
    if (at !== text.length) return undefined
    return spans
  } catch {
    return undefined
  }
}

/** A path's segments, outermost first: `$.a[2]["b c"]` → `$`, `$.a`, `$.a[2]`, `$.a[2]["b c"]`. */
export function pathPrefixes(path: string): string[] {
  const prefixes = ['$']
  let at = 1
  while (at < path.length) {
    if (path[at] === '.') {
      let end = at + 1
      while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1
      at = end
    } else if (path[at] === '[') {
      let end = at + 1
      if (path[end] === '"') {
        end += 1
        while (end < path.length && path[end] !== '"') end += path[end] === '\\' ? 2 : 1
        end += 1
      }
      while (end < path.length && path[end] !== ']') end += 1
      at = end + 1
    } else break
    prefixes.push(path.slice(0, at))
  }
  return prefixes
}

/** Where `path` lands in `text`: its value, or the deepest part of it that exists. */
export function spanOfPath(text: string, path: string): TextSpan | undefined {
  const spans = valueSpans(text)
  if (!spans) return undefined
  const prefixes = pathPrefixes(path)
  for (let index = prefixes.length - 1; index >= 0; index -= 1) {
    const span = spans.get(prefixes[index] ?? '$')
    if (span) return span
  }
  return undefined
}
