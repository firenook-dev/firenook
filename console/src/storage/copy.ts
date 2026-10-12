// Copying a value to the clipboard from a Storage control, with the toast
// that says what went there (keyed, so a second copy replaces the first).

import { toast } from '@/lib/toasts'

/** Copies `text`; `what` names it in the toast ("the gs:// URL"). */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast({ key: 'storage-copy', title: `Copied ${what}`, description: text })
  } catch {
    toast({
      key: 'storage-copy',
      title: 'Could not copy',
      description: 'The browser refused the clipboard; select the text and copy it instead.',
      tone: 'danger',
    })
  }
}
