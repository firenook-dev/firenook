// Phosphor ships every icon in six weights: each icon's `defs` module is a
// `Map` from weight to its SVG paths, and the icon picks one when it
// renders (`weights.get(weight)`). The console draws three of them —
// regular (the default), bold and fill — so the other three are path data
// every icon carries into every chunk for nothing: about a third of an
// icon's bytes.
//
// `iconWeights()` is a build plugin that cuts the unused entries out of
// each `defs` module as the bundler reads it, so an icon still renders
// every weight the console uses and nothing else. An icon asked for a
// stripped weight would render empty, so `src/test/icon-weights.test.ts`
// fails when the console, the design system or Kumo starts using a weight
// outside `ICON_WEIGHTS`; add it here rather than working around the test.
//
// A `defs` module that does not have the shape this expects fails the
// build with its name: a Phosphor upgrade that changes the shape has to be
// looked at, never shipped half-stripped.

/** The Phosphor weights the console renders; every other weight is stripped at build time. */
export const ICON_WEIGHTS = Object.freeze(['regular', 'bold', 'fill'])

/** Every weight Phosphor ships. */
const PHOSPHOR_WEIGHTS = new Set(['bold', 'duotone', 'fill', 'light', 'regular', 'thin'])

/** The modules that hold each icon's weights. */
const DEFS = /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/

/**
 * Where the code at `start` (an opening bracket) closes, skipping strings
 * and comments, so a bracket inside path data or a comment never counts.
 */
function closing(code, start) {
  let depth = 0
  for (let at = start; at < code.length; at += 1) {
    const char = code[at]
    if (char === '"' || char === "'" || char === '`') {
      at += 1
      while (at < code.length && code[at] !== char) at += code[at] === '\\' ? 2 : 1
    } else if (char === '/' && code[at + 1] === '*') {
      at = code.indexOf('*/', at + 2) + 1
      if (at === 0) return -1
    } else if (char === '/' && code[at + 1] === '/') {
      at = code.indexOf('\n', at)
      if (at === -1) return -1
    } else if (char === '[' || char === '(' || char === '{') {
      depth += 1
    } else if (char === ']' || char === ')' || char === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return -1
}

/**
 * A `defs` module with only the kept weights' entries. Throws when the
 * module is not one `new Map([...])` of `["<weight>", <paths>]` entries
 * naming every kept weight.
 */
export function stripIconWeights(code, id = 'a Phosphor defs module', keep = ICON_WEIGHTS) {
  const fail = (why) => {
    throw new Error(`icon-weights: ${id}: ${why}`)
  }
  const map = code.indexOf('new Map([')
  if (map === -1 || code.indexOf('new Map([', map + 1) !== -1) fail('expected one `new Map([`')
  const list = map + 'new Map('.length
  const end = closing(code, list)
  if (end === -1) fail('the weight list does not close')
  const found = []
  const cuts = []
  let at = list + 1
  for (;;) {
    while (/[\s,]/.test(code[at] ?? '')) at += 1
    if (at >= end) break
    if (code[at] !== '[') fail(`expected an entry at offset ${at}`)
    const close = closing(code, at)
    if (close === -1 || close > end) fail(`an entry at offset ${at} does not close`)
    const weight = /^\[\s*"(\w+)"\s*,/.exec(code.slice(at, close))?.[1]
    if (!weight || !PHOSPHOR_WEIGHTS.has(weight)) fail(`unknown weight entry at offset ${at}`)
    found.push(weight)
    if (!keep.includes(weight)) {
      // The entry with the space before it and the comma after it, so the
      // list stays well formed.
      let from = at
      while (/\s/.test(code[from - 1] ?? '')) from -= 1
      let next = close + 1
      while (/\s/.test(code[next] ?? '')) next += 1
      cuts.push([from, code[next] === ',' ? next + 1 : close + 1])
    }
    at = close + 1
  }
  for (const weight of keep) if (!found.includes(weight)) fail(`has no ${weight} weight`)
  let out = code
  for (const [from, to] of cuts.toReversed()) out = out.slice(0, from) + out.slice(to)
  return out
}

/** The build plugin: strips every weight outside `ICON_WEIGHTS` from Phosphor's `defs` modules. */
export function iconWeights() {
  return {
    name: 'firenook-icon-weights',
    apply: 'build',
    transform: {
      filter: { id: DEFS },
      handler(code, id) {
        return { code: stripIconWeights(code, id), map: null }
      },
    },
  }
}
