// The head of a section panel, set the way the Firestore schema panel's is:
// the panel's own toggle first and the scope picker beside it, then the
// filter under them, in one band with a hairline below. The band is inset
// like the toolbar (`px-3`), so the toggle at its head is where the
// toolbar's copy of it appears once the panel is hidden — one spot, pressed
// to hide and pressed again where it was to show. A panel has no footer.

import { InputGroup } from '@cloudflare/kumo'
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { PanelToggle } from '@/components/shell/section-panel'

export function PanelHeader({
  filter,
  children,
}: {
  /** The panel's filter (`PanelFilter`), on its own row inside the band. */
  filter?: ReactNode
  /** What leads the panel beside its toggle: the `ScopeSelect`. */
  children?: ReactNode
}) {
  return (
    <div
      className="grid shrink-0 gap-1.5 border-b border-kumo-line px-3 py-2"
      data-testid="panel-header"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <PanelToggle where="panel" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      </div>
      {filter}
    </div>
  )
}

/** The panel's filter: a magnifier, a clear ×, and Escape clears it and lets go. */
export function PanelFilter({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  /** Also its accessible name: "Filter queues". */
  placeholder: string
  testId?: string
}) {
  return (
    <InputGroup size="sm">
      <InputGroup.Addon>
        <MagnifyingGlassIcon size={14} />
      </InputGroup.Addon>
      <InputGroup.Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onChange('')
          event.currentTarget.blur()
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        data-testid={testId}
      />
      {value && (
        <InputGroup.Addon align="end">
          <InputGroup.Button
            variant="ghost"
            size="xs"
            shape="square"
            icon={<XIcon />}
            aria-label="Clear the filter"
            onClick={() => onChange('')}
          />
        </InputGroup.Addon>
      )}
    </InputGroup>
  )
}
