// Starter rules go into the text the developer is editing, inside the
// service's root match block, just before it closes — where a hand-written
// block would go — and nothing is in force until they Apply. Each page
// writes its own blocks (Firestore's from a collection's documents,
// Storage's from a folder's files or a template); putting them in the
// editor is the same on both.

import { toast } from '@/lib/toasts'
import type { RulesDraft } from './draft'

/** Firestore's root block: `match /databases/{database}/documents {`. */
export const FIRESTORE_ROOT = /match\s+\/databases\/\{[^}]+\}\/documents\s*\{/

/** Storage's root block: `match /b/{bucket}/o {`. */
export const STORAGE_ROOT = /match\s+\/b\/\{[^}]+\}\/o\s*\{/

/**
 * The text with a block put inside the root match block `root` finds, just
 * before it closes; at the end when there is no such block. Returns the new
 * text and the line the block starts on.
 */
export function insertBlock(
  source: string,
  block: string,
  root: RegExp,
): { text: string; line: number } {
  const header = root.exec(source)
  let at = source.length
  if (header) {
    let depth = 0
    for (let index = header.index + header[0].length - 1; index < source.length; index += 1) {
      const character = source[index]
      if (character === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index)
        index = end === -1 ? source.length : end
        continue
      }
      if (character === "'" || character === '"') {
        const close = source.indexOf(character, index + 1)
        index = close === -1 ? source.length : close
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          at = source.lastIndexOf('\n', index - 1) + 1
          break
        }
      }
    }
  }
  const before = source.slice(0, at)
  const lead = before === '' || before.endsWith('\n') ? '' : '\n'
  const text = `${before}${lead}\n${block}\n${source.slice(at)}`
  const line = `${before}${lead}\n`.split('\n').length
  return { text, line }
}

/**
 * Puts `blocks` in the draft, reveals the first, and says so in `title`
 * ("Starter rules for users are in the editor").
 */
export function insertStarter(
  draft: RulesDraft,
  blocks: readonly string[],
  root: RegExp,
  title: string,
  onReveal: (line: number) => void,
): void {
  let text = draft.source
  let first: number | undefined
  for (const block of blocks) {
    const inserted = insertBlock(text, block, root)
    text = inserted.text
    first ??= inserted.line
  }
  draft.setSource(text)
  if (first !== undefined) onReveal(first)
  toast({
    key: 'rules-starter',
    title,
    description: 'Read them, then Apply. Nothing is in force until you do.',
    tone: 'success',
  })
}
