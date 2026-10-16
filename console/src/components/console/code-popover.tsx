// "Copy as code": the thing an inspector shows (a document, an object, a
// user, a message, a task, a request) as the code that reads, writes or
// sends it, behind a Code button in the inspector's footer. One popover for
// every section: a `CodeBlock` with a tab per dialect (labels from the one
// list, `CODE_DIALECTS`, through `codeTab`), a note under it (where the
// code is sent, which token it carries), and the last tab chosen remembered
// per `kind` in this browser, so a developer who writes Python sees Python
// first everywhere they open that kind again.
//
// Only where the code is worth copying: a value the developer cannot type
// themselves (the real ids, tokens, metadata), never a draft printed back.

import { Button, Popover, Tooltip, cn } from '@cloudflare/kumo'
import { CodeIcon } from '@phosphor-icons/react'
import { type ReactNode, useState } from 'react'
import { type CodeDialect, CodeBlock } from './code-block'

const REMEMBERED = 'firenook.console.code-dialect.'

function remembered(kind: string): string | undefined {
  try {
    return localStorage.getItem(`${REMEMBERED}${kind}`) ?? undefined
  } catch {
    return undefined
  }
}

function remember(kind: string, id: string): void {
  try {
    localStorage.setItem(`${REMEMBERED}${kind}`, id)
  } catch {
    // Refused storage: the choice lasts while the popover is open.
  }
}

export interface CodePopoverProps {
  /** What the code is, sentence case: the block's title, the tooltip, the icon's name ("This user as code"). */
  title: string
  /** One tab per dialect, in order (`codeTab(id, code)` for one of `CODE_DIALECTS`). */
  tabs: readonly CodeDialect[]
  /** What kind of thing it is (`auth.user`): the last tab chosen for a kind opens first next time. */
  kind: string
  /** Under the code: where it is sent, what the token is. A function gets the tab shown. */
  note?: ReactNode | ((tab: string) => ReactNode)
  /** A control beside the title (Storage's Read / Upload). */
  header?: ReactNode
  /** The trigger's word beside the icon; false when the footer has no room (`useInspectorRoom().labels`). */
  label?: boolean
  disabled?: boolean
  /** The popover's width, px. */
  width?: 560 | 600
  side?: 'top' | 'bottom'
  /** Controlled open state, for a caller that reads something only while it is open. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The trigger's test id; the popover is `<testId>-popover`, the block `<testId>-block`. */
  testId: string
}

export function CodePopover({
  title,
  tabs,
  kind,
  note,
  header,
  label = true,
  disabled = false,
  width = 560,
  side = 'top',
  open,
  onOpenChange,
  testId,
}: CodePopoverProps) {
  const [chosen, setChosen] = useState(() => remembered(kind))
  const shown = tabs.find((tab) => tab.id === chosen)?.id ?? tabs[0]?.id ?? ''
  const choose = (id: string) => {
    setChosen(id)
    remember(kind, id)
  }
  const trigger = label ? (
    <Button
      variant="ghost"
      size="sm"
      icon={<CodeIcon />}
      aria-label={title}
      disabled={disabled}
      data-testid={testId}
    >
      Code
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={<CodeIcon />}
      aria-label={title}
      disabled={disabled}
      data-testid={testId}
    />
  )
  const below = typeof note === 'function' ? note(shown) : note
  return (
    <Popover
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <Tooltip content={title} render={<Popover.Trigger render={trigger} />} />
      <Popover.Content
        className={cn('max-w-[calc(100vw-2rem)]', width === 600 ? 'w-[600px]' : 'w-[560px]')}
        side={side}
        align="start"
      >
        {/* Kumo's Popover.Content passes no data attributes on: the test id sits inside. */}
        <div className="grid gap-2" data-testid={`${testId}-popover`}>
          {header}
          <CodeBlock
            label={title}
            value={shown}
            onValueChange={choose}
            dialects={tabs}
            testId={`${testId}-block`}
          />
          {below && <div className="text-[12px] text-kumo-subtle">{below}</div>}
        </div>
      </Popover.Content>
    </Popover>
  )
}
