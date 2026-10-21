// A block of code in colour once its language's parser has loaded, as plain
// text until then. The colouring module and the parsers arrive as their own
// chunks the first time any block needs them (`./code-highlight`), so a
// route that shows code pays nothing for colour before it paints.

import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { CodeLanguage } from '@/lib/code-language'

/** Past this many characters a block stays plain: a page of colour says nothing more. */
const LONGEST = 200_000

let highlight: Promise<typeof import('./code-highlight')> | undefined

/** What colours each language once loaded, shared by every block. */
const ready = new Map<CodeLanguage, (code: string) => ReactNode[]>()

/** `code` coloured for `language`, or as it is while the parser loads. */
export function useCodeHighlight(code: string, language: CodeLanguage | undefined): ReactNode {
  const [, setLoads] = useState(0)
  const colour = language ? ready.get(language) : undefined
  useEffect(() => {
    if (!language || ready.has(language)) return undefined
    let live = true
    highlight ??= import('./code-highlight')
    void highlight
      .then(async (module) => {
        const parser = await module.parserFor(language)
        ready.set(language, (text) => module.colour(text, parser))
        if (live) setLoads((loads) => loads + 1)
      })
      // A parser that cannot load leaves the block plain, which still reads.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [language])
  return useMemo(() => (colour && code.length <= LONGEST ? colour(code) : code), [code, colour])
}
