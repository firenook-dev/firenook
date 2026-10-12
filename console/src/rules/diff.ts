// A line diff, for comparing versions of a ruleset: the longest common run
// of lines kept, the rest marked as taken out or put in. A ruleset is at
// most 256 KB — a few thousand lines — so the plain table method is fast
// enough and simple enough to trust.

export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
  /** One-based line in the old text, for lines it has. */
  before?: number | undefined
  /** One-based line in the new text, for lines it has. */
  after?: number | undefined
}

/** Past this many cells the table would be slow; such texts are compared as wholly different. */
const LIMIT = 4_000_000

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length * b.length > LIMIT)
    return [
      ...a.map((text, index) => ({ kind: 'removed' as const, text, before: index + 1 })),
      ...b.map((text, index) => ({ kind: 'added' as const, text, after: index + 1 })),
    ]
  // lengths[i][j]: the longest common run of a[i..] and b[j..].
  const width = b.length + 1
  const lengths = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '', before: i + 1, after: j + 1 })
      i += 1
      j += 1
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: a[i] ?? '', before: i + 1 })
      i += 1
    } else {
      out.push({ kind: 'added', text: b[j] ?? '', after: j + 1 })
      j += 1
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: 'removed', text: a[i] ?? '', before: i + 1 })
  for (; j < b.length; j += 1) out.push({ kind: 'added', text: b[j] ?? '', after: j + 1 })
  return out
}

/** How many lines a diff takes out and puts in. */
export function diffSize(lines: readonly DiffLine[]): { removed: number; added: number } {
  let removed = 0
  let added = 0
  for (const line of lines) {
    if (line.kind === 'removed') removed += 1
    else if (line.kind === 'added') added += 1
  }
  return { removed, added }
}
