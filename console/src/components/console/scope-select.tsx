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

import { Select, cn } from '@cloudflare/kumo'

export interface ScopeItem<V extends string> {
  value: V
  /** What the list and the box print; the value itself when absent. */
  label?: string | undefined
  /** A second, quieter word in the list: a count, a region. */
  detail?: string | undefined
}

export function ScopeSelect<V extends string>({
  label,
  value,
  items,
  onChange,
  onOpen,
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
  /** Defaults to `label`. */
  ariaLabel?: string
  testId?: string
  className?: string
}) {
  // The value on screen stays in the list even when the engine no longer
  // lists it, so the box never shows a value its own menu cannot pick.
  const listed = items.some((item) => item.value === value)
    ? items
    : [...items, { value, label: undefined, detail: undefined }]
  const shown = listed.find((item) => item.value === value)
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <Select
        size="xs"
        value={value}
        onValueChange={(next) => onChange(next as V)}
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
              <span className="truncate font-mono text-[12px]">{item.label ?? item.value}</span>
              {item.detail && (
                <span className="ml-auto shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
                  {item.detail}
                </span>
              )}
            </span>
          </Select.Option>
        ))}
      </Select>
    </div>
  )
}
