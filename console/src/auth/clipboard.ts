// Copying from a keyboard shortcut, a row's menu or a toast, where no button
// is there to tick: the toast says what was copied, or that the browser would
// not let the console copy (a page served over plain http to another machine
// has no clipboard).

import { toast } from '@/lib/toasts'

/** Copies `text`; the toast names `what` ("the code 482913", "the link"). */
export async function copyWithToast(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast({ key: 'auth.copy', title: `Copied ${what}`, tone: 'success' })
    return true
  } catch {
    toast({
      key: 'auth.copy',
      title: 'The browser did not let the console copy',
      description: 'Select the text and copy it yourself.',
      tone: 'warning',
    })
    return false
  }
}
