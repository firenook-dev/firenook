// The window of the log, row one's scope in time: every line the engine
// keeps, the last minute to the last hour, since the last Functions reload
// (the engine remembers when, after the line itself has left its log), or
// a window of the developer's own. Firestore's scope picker's shape: a
// ghost trigger that reads "All lines" while nothing is narrowed, a
// framed one that names the window otherwise, and a menu whose items say
// what each window means.

import { Button, DropdownMenu, Input, Popover, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, ClockIcon } from '@phosphor-icons/react'
import { type ReactNode, useRef, useState } from 'react'
import { MenuCheck } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import {
  RANGE_PRESETS,
  type RangePreset,
  clockText,
  fromLocalInput,
  presetOf,
  rangeLabel,
  toLocalInput,
} from '../range'

export function RangePicker({
  from,
  to,
  lastReload,
  kept,
  onChange,
}: {
  from: string | undefined
  to: string | undefined
  /** When Functions last reloaded (RFC 3339), or null before the first. */
  lastReload: string | null | undefined
  /** Lines the engine keeps, for "All lines". */
  kept: number | undefined
  onChange: (window: { from: string | undefined; to: string | undefined }) => void
}) {
  const [menu, setMenu] = useState(false)
  const [custom, setCustom] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = presetOf(from, to)
  const narrowed = from !== undefined || to !== undefined
  const describe = (preset: RangePreset): string | undefined => {
    if (preset.id === 'all')
      return kept === undefined
        ? 'Everything the engine keeps'
        : `Everything the engine keeps (${formatNumber(kept)} lines)`
    if (preset.id === 'reload')
      return lastReload
        ? clockText(Date.parse(lastReload))
        : 'Functions have not reloaded since the engine started'
    return undefined
  }
  return (
    <>
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <Tooltip
          content="By the time each line was recorded."
          render={
            <DropdownMenu.Trigger
              render={
                <Button
                  ref={trigger}
                  variant={narrowed ? 'secondary' : 'ghost'}
                  size="sm"
                  icon={<ClockIcon />}
                  aria-label="Time range"
                  className="shrink-0"
                  data-testid="range-picker"
                  data-narrowed={narrowed || undefined}
                >
                  <span className="flex items-center gap-1 tabular-nums">
                    {rangeLabel(from, to)}
                    <CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" />
                  </span>
                </Button>
              }
            />
          }
        />
        <DropdownMenu.Content className="min-w-64">
          {/* Base UI throws unless a Label and its items share a Group. */}
          <DropdownMenu.Group>
            <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-kumo-subtle">
              Time range
            </DropdownMenu.Label>
            {RANGE_PRESETS.map((preset) => (
              <DropdownMenu.Item
                key={preset.id}
                className="items-start"
                disabled={preset.id === 'reload' && !lastReload}
                onClick={() => onChange({ from: preset.from, to: undefined })}
                data-testid={`range-${preset.id}`}
              >
                <Choice
                  title={preset.title}
                  detail={describe(preset)}
                  selected={current?.id === preset.id}
                />
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              className="items-start"
              onClick={() => setCustom(true)}
              data-testid="range-custom"
            >
              <Choice
                title="Custom range…"
                detail={narrowed && !current ? rangeLabel(from, to) : undefined}
                selected={narrowed && !current}
              />
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu>
      <Popover open={custom} onOpenChange={setCustom}>
        <Popover.Content anchor={trigger} align="start" className="w-80 p-0">
          <CustomRange
            from={from}
            to={to}
            onApply={(window) => {
              setCustom(false)
              onChange(window)
            }}
            onCancel={() => setCustom(false)}
          />
        </Popover.Content>
      </Popover>
    </>
  )
}

/** A menu row: its title, a second line, and the tick on the current one. */
function Choice({
  title,
  detail,
  selected,
}: {
  title: string
  detail: ReactNode
  selected: boolean
}) {
  return (
    <span className="flex w-full items-start gap-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-kumo-default">{title}</span>
        {detail !== undefined && (
          <span className="text-[12px] leading-[1.45] text-kumo-subtle">{detail}</span>
        )}
      </span>
      <MenuCheck on={selected} />
    </span>
  )
}

/** The custom window: from and to, to the second, in local time. */
function CustomRange({
  from,
  to,
  onApply,
  onCancel,
}: {
  from: string | undefined
  to: string | undefined
  onApply: (window: { from: string | undefined; to: string | undefined }) => void
  onCancel: () => void
}) {
  const [start, setStart] = useState(() => toLocalInput(from))
  const [end, setEnd] = useState(() => toLocalInput(to))
  const fromIso = fromLocalInput(start)
  const toIso = fromLocalInput(end)
  const backwards = fromIso !== undefined && toIso !== undefined && toIso < fromIso
  return (
    <form
      className="grid gap-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!backwards) onApply({ from: fromIso, to: toIso })
      }}
      data-testid="range-custom-form"
    >
      <div className="grid gap-0.5">
        <h3 className="m-0 text-[14px] font-semibold text-kumo-default">Custom range</h3>
        <p className="m-0 text-[13px] text-kumo-subtle">
          Local time. Leave either end open for everything before or after it.
        </p>
      </div>
      <label className="grid gap-1 text-[12px] text-kumo-subtle">
        From
        <Input
          type="datetime-local"
          step={1}
          size="sm"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          className="font-mono"
          aria-label="From"
          data-testid="range-custom-from"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-kumo-subtle">
        To
        <Input
          type="datetime-local"
          step={1}
          size="sm"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          className="font-mono"
          aria-label="To"
          data-testid="range-custom-to"
        />
      </label>
      {backwards && (
        <p className="m-0 text-[12px] text-kumo-danger" data-testid="range-custom-error">
          The end is before the start; swap them or move one.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={backwards || (fromIso === undefined && toIso === undefined)}
          data-testid="range-custom-apply"
        >
          Apply
        </Button>
      </div>
    </form>
  )
}
