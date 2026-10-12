// The one primary action of a composer: Send, or the target's own verb
// (Enqueue, Publish). ⌘↵ sends from anywhere in the composer, the body
// editor included; the key cap sits in the button so it is learnt where it
// is used.

import { Button } from '@cloudflare/kumo'
import { PaperPlaneRightIcon } from '@phosphor-icons/react'
import { describeKey, useShortcuts } from '@/lib/shortcuts'

export function SendButton({
  onSend,
  pending,
  label = 'Send',
  disabled = false,
  testId = 'request-send',
}: {
  onSend: () => void
  pending: boolean
  label?: string
  disabled?: boolean
  testId?: string
}) {
  useShortcuts({ id: 'composer', label: 'Request' }, [
    {
      key: 'Mod+Enter',
      label,
      allowInInputs: true,
      when: () => !pending && !disabled,
      run: () => onSend(),
    },
  ])
  return (
    <Button
      variant="primary"
      size="sm"
      icon={<PaperPlaneRightIcon />}
      loading={pending}
      disabled={disabled}
      onClick={onSend}
      className="h-8 shrink-0 rounded-lg"
      data-testid={testId}
    >
      <span className="flex items-center gap-1.5">
        {label}
        <kbd className="font-sans text-[10px] opacity-70">{describeKey('Mod+Enter')}</kbd>
      </span>
    </Button>
  )
}
