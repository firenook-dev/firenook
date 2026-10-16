// Row one's ⋯: what acts on the whole view rather than narrowing it —
// downloads of exactly what the filter matches (streamed by the engine),
// copying what is loaded or a link to the view (its filter and window, the
// way to keep or share one), clearing the view (client-only, restorable),
// how rows are drawn (wrapped lines, the console-wide clock), and keeping
// lines across engine restarts.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  BroomIcon,
  ClipboardTextIcon,
  ClockIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  LinkSimpleIcon,
} from '@phosphor-icons/react'
import { Kbd, MenuCheck } from '@/components/kit'
import { type ClockFormat, useClockFormat } from '@/lib/format'

const CLOCKS: readonly { value: ClockFormat; label: string; example: string }[] = [
  { value: 'time', label: 'Clock', example: '12:06:09.117' },
  { value: 'relative', label: 'Relative', example: '3 s ago' },
  { value: 'utc', label: 'UTC', example: '2026-10-12T04:06:09.117Z' },
]

export interface LogMenuActions {
  downloadNdjson: () => void
  downloadText: () => void
  copyVisible: () => void
  /** Copies the address of this view: its filter and window. */
  copyLink: () => void
  clearView: () => void
  showCleared: () => void
  setWrap: (wrap: boolean) => void
  setKeep: (keep: boolean) => void
}

export function LogMenu({
  wrap,
  keep,
  cleared,
  canClear,
  actions,
}: {
  wrap: boolean
  keep: boolean
  /** The view is cleared: "Show cleared lines" is offered. */
  cleared: boolean
  /** Why the view cannot be cleared now, when it cannot. */
  canClear: string | undefined
  actions: LogMenuActions
}) {
  const { format, setFormat } = useClockFormat()
  return (
    <DropdownMenu>
      <Tooltip
        content="Downloads, a link to this view, and how lines are drawn"
        render={
          <DropdownMenu.Trigger
            render={
              <Button
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
        <DropdownMenu.Item
          icon={LinkSimpleIcon}
          onClick={actions.copyLink}
          data-testid="log-menu-copy-link"
        >
          Copy link to this view
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
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
