// The one way the console copies. A control that copies says what it put on
// the clipboard — a toast from a keyboard shortcut, a row's menu or ⌘K, a
// tick on a button that has one (`useCopied`) — and says plainly when the
// browser would not let it: a page served over plain http to another
// machine has no clipboard, and a copy that fails in silence looks like a
// copy that worked.

import { toast } from './toasts'

export interface CopyNote {
  /** What was copied, after "Copied" in the toast: "the code 482913", "us-central1-api". */
  what?: string | undefined
  /** The whole toast title instead ("Copied 2 documents as JSON"). */
  title?: string | undefined
  /** A line under the title: Storage shows the value itself. */
  description?: string | undefined
  /** What the refusal toast suggests instead of selecting the text ("The code for ada@… is 482913."). */
  refused?: string | undefined
  /** Same key, same toast: a second copy replaces the first. */
  key?: string | undefined
}

/** The toast key copies share unless a caller names its own. */
export const COPY_TOAST = 'console.copy'

/**
 * Copies `text`. With `what` or `title`, a toast says what was copied;
 * without either, success is the caller's to show (a button's tick). A
 * refused write is always said, with what to do instead. Resolves `true`
 * once the clipboard has the text; never throws.
 */
export async function copyToClipboard(text: string, note: CopyNote = {}): Promise<boolean> {
  const key = note.key ?? COPY_TOAST
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    toast({
      key,
      title: 'The browser did not let the console copy',
      description: note.refused ?? 'Select the text and copy it yourself.',
      tone: 'warning',
    })
    return false
  }
  const title = note.title ?? (note.what === undefined ? undefined : `Copied ${note.what}`)
  if (title !== undefined) toast({ key, title, description: note.description, tone: 'success' })
  return true
}
