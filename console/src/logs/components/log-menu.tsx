// Row one's ⋯: what acts on the whole view rather than narrowing it —
// downloads of exactly what the filter matches (streamed by the engine),
// copying what is loaded, clearing the view (client-only, restorable),
// how rows are drawn (wrapped lines, the console-wide clock), keeping lines
// across engine restarts, and saved filters.

import { Button, DropdownMenu, Input, Popover, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  BroomIcon,
  ClipboardTextIcon,
  ClockIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { Kbd, MenuCheck } from '@/components/kit'
import { type ClockFormat, useClockFormat } from '@/lib/format'
import type { SavedFilter } from '../prefs'

const CLOCKS: readonly { value: ClockFormat; label: string; example: string }[] = [
  { value: 'time', label: 'Clock', example: '12:06:09.117' },
  { value: 'relative', label: 'Relative', example: '3 s ago' },
  { value: 'utc', label: 'UTC', example: '2026-10-12T04:06:09.117Z' },
]

export interface LogMenuActions {
  downloadNdjson: () => void
  downloadText: () => void
  copyVisible: () => void
  clearView: () => void
  showCleared: () => void
  setWrap: (wrap: boolean) => void
  setKeep: (keep: boolean) => void
  applySaved: (filter: SavedFilter) => void
  save: (name: string) => void
  forget: (name: string) => void
}

export function LogMenu({
  wrap,
  keep,
  cleared,
  canClear,
  hasFilter,
  saved,
  actions,
}: {
  wrap: boolean
  keep: boolean
  /** The view is cleared: "Show cleared lines" is offered. */
  cleared: boolean
  /** Why the view cannot be cleared now, when it cannot. */
  canClear: string | undefined
  /** The page has a filter or a window worth saving. */
  hasFilter: boolean
  saved: readonly SavedFilter[]
  actions: LogMenuActions
}) {
  const { format, setFormat } = useClockFormat()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip
          content="Downloads, the view and saved filters"
          render={
            <DropdownMenu.Trigger
              render={
                <Button
                  ref={trigger}
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<DotsThreeIcon weight="bold" />}
                  aria-label="More for the log"
                  className="shrink-0"
                  data-testid="log-menu"
                />
              }
            />
          }
        />
        <DropdownMenu.Content align="end" className="min-w-64">
          <DropdownMenu.Item
            icon={DownloadSimpleIcon}
            onClick={actions.downloadNdjson}
            data-testid="log-menu-ndjson"
          >
            Download as NDJSON
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={DownloadSimpleIcon}
            onClick={actions.downloadText}
            data-testid="log-menu-text"
          >
            Download as text
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={ClipboardTextIcon}
            onClick={actions.copyVisible}
            data-testid="log-menu-copy"
          >
            Copy visible lines
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={BroomIcon}
            disabled={canClear !== undefined}
            onClick={actions.clearView}
            className="gap-0"
            data-testid="log-menu-clear"
          >
            <span className="min-w-0 flex-1">Clear view</span>
            <span className="ml-4 shrink-0">
              <Kbd>x</Kbd>
            </span>
          </DropdownMenu.Item>
          {cleared && (
            <DropdownMenu.Item
              icon={ArrowCounterClockwiseIcon}
              onClick={actions.showCleared}
              data-testid="log-menu-show-cleared"
            >
              Show cleared lines
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={wrap}
            onCheckedChange={actions.setWrap}
            data-testid="log-menu-wrap"
          >
            <Tooltip
              content="Each message whole, wrapped. While lines arrive faster than 100 a second, new rows stay on one line so the view never jumps."
              side="left"
              render={<span className="flex-1">Wrap lines</span>}
            />
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger icon={ClockIcon} data-testid="log-menu-clock">
              Timestamps
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent className="min-w-60">
              <DropdownMenu.Group>
                <DropdownMenu.RadioGroup
                  value={format}
                  onValueChange={(value) => setFormat(value as ClockFormat)}
                >
                  {CLOCKS.map((clock) => (
                    <DropdownMenu.RadioItem
                      key={clock.value}
                      value={clock.value}
                      closeOnClick
                      className="items-start"
                      data-testid={`log-menu-clock-${clock.value}`}
                    >
                      <span className="flex w-full items-start gap-2">
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[13px]">{clock.label}</span>
                          <span className="font-mono text-[12px] text-kumo-subtle">
                            {clock.example}
                          </span>
                        </span>
                        <MenuCheck on={format === clock.value} />
                      </span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Group>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
          <DropdownMenu.CheckboxItem
            checked={keep}
            onCheckedChange={actions.setKeep}
            data-testid="log-menu-keep"
          >
            Keep lines across engine restarts
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger icon={BookmarkSimpleIcon} data-testid="log-menu-saved">
              Saved filters
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent className="min-w-60 max-w-96">
              {saved.map((filter) => (
                <DropdownMenu.Item
                  key={filter.name}
                  className="items-start gap-0"
                  onClick={() => actions.applySaved(filter)}
                  data-testid="log-menu-saved-filter"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px]">{filter.name}</span>
                    <span className="truncate font-mono text-[12px] text-kumo-subtle">
                      {filter.q || 'Every line'}
                    </span>
                  </span>
                  <Tooltip
                    content={`Forget ${filter.name}`}
                    render={
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Forget ${filter.name}`}
                        className="ml-3 flex size-6 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:ink hover:text-kumo-danger"
                        onClick={(event) => {
                          event.stopPropagation()
                          actions.forget(filter.name)
                        }}
                        onKeyDown={() => undefined}
                      >
                        <TrashIcon size={14} />
                      </span>
                    }
                  />
                </DropdownMenu.Item>
              ))}
              {saved.length > 0 && <DropdownMenu.Separator />}
              <DropdownMenu.Item
                icon={FloppyDiskIcon}
                disabled={!hasFilter}
                onClick={() => setSaving(true)}
                data-testid="log-menu-save"
              >
                Save this filter…
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu>
      <Popover open={saving} onOpenChange={setSaving}>
        <Popover.Content anchor={trigger} align="end" className="w-80 p-0">
          <SaveFilter
            onSave={(name) => {
              actions.save(name)
              setSaving(false)
            }}
            onCancel={() => setSaving(false)}
            taken={saved.map((filter) => filter.name)}
          />
        </Popover.Content>
      </Popover>
    </>
  )
}

function SaveFilter({
  onSave,
  onCancel,
  taken,
}: {
  onSave: (name: string) => void
  onCancel: () => void
  taken: readonly string[]
}) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <form
      className="grid gap-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed !== '') onSave(trimmed)
      }}
      data-testid="save-filter"
    >
      <div className="grid gap-0.5">
        <h3 className="m-0 text-[14px] font-semibold text-kumo-default">Save this filter</h3>
        <p className="m-0 text-[13px] text-kumo-subtle">
          Kept in this browser for this project, in ⌘K and this menu. Twelve at most.
        </p>
      </div>
      <Input
        size="sm"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Checkout functions, warnings and up"
        aria-label="Name"
        data-testid="save-filter-name"
      />
      {taken.includes(trimmed) && (
        <p className="m-0 text-[12px] text-kumo-subtle">Saving replaces the filter of this name.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={trimmed === ''}
          data-testid="save-filter-save"
        >
          Save
        </Button>
      </div>
    </form>
  )
}
