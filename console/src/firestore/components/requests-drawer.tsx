// The Requests drawer: every rules evaluation the engine made, newest
// first, scoped to the path on screen. The rule line that decided each one
// is right there, which is the answer to "why was this denied".

import { Badge, Button, Switch, Text } from '@cloudflare/kumo'
import { CaretDownIcon, CaretUpIcon, TrashIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { type RequestEvent, useRequests, useRequestsFeed } from '../requests'
import { relativeTime } from '../value'
import { useWorkbench } from './workbench-context'

export function RequestsDrawer({
  open,
  setOpen,
}: {
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const workbench = useWorkbench()
  const [scoped, setScoped] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>()
  useRequestsFeed(open)
  const status = useRequests((state) => state.status)
  const detail = useRequests((state) => state.detail)
  const events = useRequests((state) => state.events)
  const clear = useRequests((state) => state.clear)

  const scope = workbench.selectedDocument ?? workbench.path
  const shown = scoped && scope ? events.filter((event) => inScope(event, scope)) : events
  const denied = shown.filter((event) => event.outcome !== 'allow').length

  return (
    <section
      className={`flex shrink-0 flex-col rounded-lg bg-kumo-base ring ring-kumo-line ${open ? 'h-72' : 'h-9'}`}
      data-testid="requests-drawer"
    >
      <button
        type="button"
        className="flex h-9 shrink-0 items-center gap-3 px-3 text-left hover:bg-kumo-tint"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Text as="span" size="sm" bold>
          Requests
        </Text>
        {open && status === 'live' && (
          <Badge variant="success" appearance="dot">
            live
          </Badge>
        )}
        {open && status === 'unavailable' && (
          <span title={detail ?? ''}>
            <Badge variant="error" appearance="dot">
              unavailable
            </Badge>
          </span>
        )}
        {events.length > 0 && (
          <Text as="span" variant="secondary" size="sm">
            <span className="tabular-nums">{shown.length}</span>
            {denied > 0 && (
              <>
                {' '}
                · <span className="text-kumo-danger tabular-nums">{denied} denied</span>
              </>
            )}
          </Text>
        )}
        {!open && (
          <Text as="span" variant="secondary" size="sm">
            Every rules evaluation, with the line that decided it
          </Text>
        )}
        <span className="ml-auto flex items-center gap-2">
          {open && (
            <>
              <span
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-2"
              >
                <Switch
                  variant="neutral"
                  size="sm"
                  checked={scoped}
                  onClick={() => setScoped(!scoped)}
                  label={<span className="text-[13px]">Only this path</span>}
                />
              </span>
              <Button
                variant="ghost"
                size="xs"
                icon={<TrashIcon />}
                aria-label="Clear the list"
                onClick={(event) => {
                  event.stopPropagation()
                  clear()
                }}
              />
            </>
          )}
          {open ? <CaretDownIcon size={14} /> : <CaretUpIcon size={14} />}
        </span>
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-kumo-line">
          {shown.length === 0 ? (
            <div className="p-4">
              <Text variant="secondary" size="sm">
                {status === 'live'
                  ? 'No evaluations yet. Read or write from your app, or change "View as" and reload the grid.'
                  : status === 'unavailable'
                    ? (detail ?? 'The feed is unavailable.')
                    : 'Connecting…'}
              </Text>
            </div>
          ) : (
            <table className="w-full border-separate border-spacing-0 text-[13px]">
              <tbody>
                {shown.map((event) => (
                  <RequestRow
                    key={event.requestId}
                    event={event}
                    expanded={expanded === event.requestId}
                    onToggle={() =>
                      setExpanded(expanded === event.requestId ? undefined : event.requestId)
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

function inScope(event: RequestEvent, scope: string): boolean {
  return event.path === scope || event.path.startsWith(`${scope}/`)
}

function RequestRow({
  event,
  expanded,
  onToggle,
}: {
  event: RequestEvent
  expanded: boolean
  onToggle: () => void
}) {
  const deciding = event.lines.filter((line) => line.outcome === (event.outcome === 'allow'))
  return (
    <>
      <tr className="cursor-pointer hover:bg-kumo-tint" onClick={onToggle}>
        <td className="w-20 border-b border-kumo-hairline px-3 py-1.5 whitespace-nowrap text-kumo-subtle tabular-nums">
          <span title={event.time}>{relativeTime(event.time)}</span>
        </td>
        <td className="w-24 border-b border-kumo-hairline px-2 py-1.5">
          <Badge
            variant={
              event.outcome === 'allow' ? 'success' : event.outcome === 'deny' ? 'error' : 'warning'
            }
            appearance="dot"
          >
            {event.outcome === 'allow' ? 'allowed' : event.outcome === 'deny' ? 'denied' : 'error'}
          </Badge>
        </td>
        <td className="w-20 border-b border-kumo-hairline px-2 py-1.5 font-mono text-[12px]">
          {event.method}
        </td>
        <td className="border-b border-kumo-hairline px-2 py-1.5 font-mono text-[12px]">
          <span className="block max-w-[40vw] truncate" title={event.path}>
            {event.path}
          </span>
        </td>
        <td className="w-48 border-b border-kumo-hairline px-2 py-1.5">
          <span
            className="block truncate font-mono text-[12px] text-kumo-subtle"
            title={event.uid ?? 'anonymous'}
          >
            {event.uid ?? 'anonymous'}
          </span>
        </td>
        <td className="w-40 border-b border-kumo-hairline px-2 py-1.5 whitespace-nowrap font-mono text-[12px]">
          {deciding.length > 0
            ? deciding.map((line) => `line ${line.line}`).join(', ')
            : event.lines.length > 0
              ? `${event.lines.length} rule${event.lines.length === 1 ? '' : 's'} checked`
              : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="border-b border-kumo-hairline bg-kumo-control px-3 py-2">
            <pre className="max-h-56 overflow-auto font-mono text-[11px] leading-4 text-kumo-default">
              {JSON.stringify(event.raw, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}
