// The picker that leads a panel or a toolbar: "Bucket demo.appspot.com ▾",
// "Queue emails ▾", "Codebase default ▾". Bucket, queue, topic, codebase and
// database pickers are one control, set the way the Firestore database
// picker is (`database-picker.tsx`):
//
// - `xs`, so its text matches the 12 px filter under it (Kumo's `sm` Select
//   is 14 px while its `sm` Input is 12), at the filter's height;
// - named inside the box — a muted sans word and the value in the data face
//   — because Kumo's `label` is a form label stacked over the box, a second
//   row in a toolbar;
// - `min-w-0`, because Kumo wraps every Select in a one-column grid whose
//   track grows to its text, and a long value pushed the box and its caret
//   past the panel's edge;
// - opening it asks again (`onOpen`), so a bucket or queue created since the
//   page mounted is in the list.
//
// A list may end in a few actions after a rule ("New tenant…", "Manage
// tenants…"): choosing one runs it and leaves the value as it was, so the
// place to make the next scope is where the scopes are listed.

import { Select, cn } from '@cloudflare/kumo'
import type { Icon } from '@phosphor-icons/react'

export interface ScopeItem<V extends string> {
  value: V
  /** What the list and the box print; the value itself when absent. */
  label?: string | undefined
  /** A second, quieter word in the list: a count, a region. */
  detail?: string | undefined
  /** English before the value in the list only (a tenant's display name); the box shows the value. */
  note?: string | undefined
}

/** A row after the list's rule that does something instead of choosing a scope. */
export interface ScopeAction {
  id: string
  label: string
  icon?: Icon | undefined
  run: () => void
}

/** The value an action's row carries in the list, so it can never collide with a scope's. */
const ACTION = '\u0000action:'

export function ScopeSelect<V extends string>({
  label,
  value,
  items,
  onChange,
  onOpen,
  actions,
  ariaLabel,
  testId,
  className,
}: {
  /** The word inside the box before the value: "Bucket". */
  label: string
  value: V
  items: readonly ScopeItem<V>[]
  onChange: (value: V) => void
  /** Called when the list opens: refetch what it lists. */
  onOpen?: () => void
  /** Rows after a rule at the end of the list; choosing one keeps the value. */
  actions?: readonly ScopeAction[] | undefined
  /** Defaults to `label`. */
  ariaLabel?: string
  testId?: string
  className?: string
}) {
  // The value on screen stays in the list even when the engine no longer
  // lists it, so the box never shows a value its own menu cannot pick.
  const listed = items.some((item) => item.value === value)
    ? items
    : [...items, { value, label: undefined, detail: undefined, note: undefined }]
  const shown = listed.find((item) => item.value === value)
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <Select
        size="xs"
        value={value}
        onValueChange={(next) => {
          const chosen = String(next)
          if (chosen.startsWith(ACTION)) {
            actions?.find((action) => `${ACTION}${action.id}` === chosen)?.run()
            return
          }
          onChange(chosen as V)
        }}
        onOpenChange={(open) => {
          if (open) onOpen?.()
        }}
        renderValue={() => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-kumo-subtle">{label}</span>
            <span className="truncate font-mono">{shown?.label ?? value}</span>
          </span>
        )}
        aria-label={ariaLabel ?? label}
        className="h-6.5 w-full min-w-0 rounded-md"
      >
        {listed.map((item) => (
          <Select.Option key={item.value} value={item.value}>
            <span className="flex min-w-0 items-center gap-2">
              {item.note && (
                <span className="min-w-0 truncate font-sans text-[12px]">{item.note}</span>
              )}
              <span
                className={cn(
                  'truncate font-mono text-[12px]',
                  item.note ? 'shrink-0 text-kumo-subtle' : 'min-w-0',
                )}
              >
                {item.label ?? item.value}
              </span>
              {item.detail && (
                <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-kumo-subtle tabular-nums">
                  {item.detail}
                </span>
              )}
            </span>
          </Select.Option>
        ))}
        {actions && actions.length > 0 && <Select.Separator />}
        {actions?.map((action) => (
          <Select.Option key={action.id} value={`${ACTION}${action.id}`}>
            <span
              className="flex min-w-0 items-center gap-2 text-[13px]"
              data-testid={`scope-action-${action.id}`}
            >
              {action.icon && <action.icon size={14} className="shrink-0 text-kumo-subtle" />}
              <span className="truncate">{action.label}</span>
            </span>
          </Select.Option>
        ))}
      </Select>
    </div>
  )
}
