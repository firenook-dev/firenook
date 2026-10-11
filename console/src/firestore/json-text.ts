// Where the values of a JSON document are, in the text itself.
//
// Two things need the source text rather than the parsed value. The
// marks, which have to land on a range of characters. And the one type
// `JSON.parse` destroys on the way past: `3.0` and `3` are the same
// number to it, and different types to Firestore. Both are answered by
// knowing which characters each value occupies.

/**
 * Paths are joined on a character no key can contain, so a field
 * literally called `a.b` can never be mistaken for `b` inside `a`.
 */
export const SEP = '\u0000'

export interface TextSpan {
  from: number
  to: number
}

/**
 * Where every value of a JSON document starts and ends, by path.
 *
 * A scanner rather than `JSON.parse`, because the positions are the
 * whole point and `JSON.parse` throws them away. It is deliberately
 * forgiving: the text is being typed, so it stops at the first thing it
 * cannot read and returns what it found up to there.
 */
export function valueSpans(text: string): Map<string, TextSpan> {
  const spans = new Map<string, TextSpan>()
  let at = 0

  const space = () => {
    while (
      at < text.length &&
      (text[at] === ' ' || text[at] === '\n' || text[at] === '\r' || text[at] === '\t')
    )
      at += 1
  }

  /** Past the closing quote of the string starting at `at`. */
  const quoted = (): string | undefined => {
    const from = at
    at += 1
    while (at < text.length) {
      const char = text[at]
      at += 1
      if (char === '\\') at += 1
      else if (char === '"') {
        try {
          return JSON.parse(text.slice(from, at)) as string
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  /** True while the scan is still making sense. */
  const value = (path: readonly string[]): boolean => {
    space()
    const from = at
    const char = text[at]
    let ok = true
    if (char === '{') {
      at += 1
      ok = object(path)
    } else if (char === '[') {
      at += 1
      ok = array(path)
    } else if (char === '"') {
      ok = quoted() !== undefined
    } else {
      const start = at
      while (at < text.length && !',]} \n\r\t'.includes(text[at] as string)) at += 1
      ok = at > start
    }
    // Only what was actually read. A value the scan ran out of text in
    // the middle of — `{"a": 1, "b": `, a document halfway through being
    // typed — would otherwise record an empty span at the end of the
    // text, and a mark on it would be a marker on nothing.
    if (ok && path.length > 0) spans.set(path.join(SEP), { from, to: at })
    return ok
  }

  const object = (path: readonly string[]): boolean => {
    space()
    if (text[at] === '}') {
      at += 1
      return true
    }
    for (;;) {
      space()
      if (text[at] !== '"') return false
      const key = quoted()
      if (key === undefined) return false
      space()
      if (text[at] !== ':') return false
      at += 1
      if (!value([...path, key])) return false
      space()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === '}') {
        at += 1
        return true
      }
      return false
    }
  }

  const array = (path: readonly string[]): boolean => {
    space()
    if (text[at] === ']') {
      at += 1
      return true
    }
    for (let index = 0; ; index += 1) {
      if (!value([...path, String(index)])) return false
      space()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === ']') {
        at += 1
        return true
      }
      return false
    }
  }

  value([])
  return spans
}

/**
 * Whether a number literal was written as a double.
 *
 * This is the whole of telling Firestore's `integer` from its `double`
 * when both hold a whole number: `3.0` and `3` parse to the same
 * JavaScript 3, and the only surviving evidence is the characters the
 * author typed. Not an inference — a reading.
 */
export function writtenAsDouble(literal: string): boolean {
  return /[.eE]/.test(literal)
}

/**
 * The document laid out again, with its doubles intact.
 *
 * `JSON.stringify` writes the double 3 as `3`, because to JavaScript it
 * is the same number — so laying a document out with it destroys the one
 * piece of evidence that says `double` rather than `integer`. Format and
 * the tidying of a pasted document both go through here, and both used
 * to silently turn `{"a": 3.0}` into an integer before anything had a
 * chance to read it.
 *
 * So the literals that were written with a point are noted on the way
 * in, and put back on the way out, from the end of the text forwards so
 * that each splice leaves the earlier offsets alone.
 */
export function tidyJson(text: string, indent = 2): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const doubles = new Set<string>()
  for (const [path, span] of valueSpans(text)) {
    const literal = text.slice(span.from, span.to)
    if (writtenAsDouble(literal) && Number.isInteger(Number(literal))) doubles.add(path)
  }
  const out = JSON.stringify(parsed, null, indent)
  if (doubles.size === 0) return out
  const puts: { at: number }[] = []
  for (const [path, span] of valueSpans(out)) {
    if (!doubles.has(path)) continue
    const literal = out.slice(span.from, span.to)
    if (!writtenAsDouble(literal) && Number.isInteger(Number(literal))) puts.push({ at: span.to })
  }
  let result = out
  for (const { at } of puts.toSorted((a, b) => b.at - a.at))
    result = `${result.slice(0, at)}.0${result.slice(at)}`
  return result
}
