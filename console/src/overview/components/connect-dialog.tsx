// "Connect your app", the Overview's one action: the code that points an app
// at this engine, for every platform, with the ports in use, the project id
// and the host the app sees — printed by the console's one generator
// (`lib/connect.ts`), so it is the same text every page prints. A dialog,
// because it is wanted once per app and is the longest thing the page
// could hold; the platforms down its side, grouped by who runs the code.
// A demo project's snippets are complete and run as printed; another
// project keeps the app's own configuration. The host picker offers the
// engine's connect host, the address this page was opened at, the Android
// emulator's 10.0.2.2, or one typed, and the choice is kept per browser.
// The address names the platform (`/?connect=python`), so a link or ⌘K
// opens it on that one; closing it drops the parameter.

import { Button, Dialog, Input, Select, cn } from '@cloudflare/kumo'
import { CheckIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useRef, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import { CodeBlock } from '@/components/console/code-block'
import { connectSnippet, hostLiteral } from '@/lib/connect'
import { useConnectHost } from '../host'
import { CONNECT_TABS, type ConnectParam, type ConnectTab, connectTab } from '@/lib/connect-tabs'

/** The platforms down the dialog's side, by who runs the code. */
const GROUPS: readonly { label: string; params: readonly ConnectParam[] }[] = [
  { label: 'Apps', params: ['web', 'flutter', 'apple', 'android'] },
  { label: 'Servers', params: ['node', 'python', 'go', 'java'] },
  { label: 'Configuration', params: ['env', 'firebase-json'] },
]

/** The picker's entry for "type a host". */
const CUSTOM = '\u0000custom'

/** What a snippet is, under its code: who it is for and what to change. */
function snippetNote(tab: ConnectTab, demo: boolean): string {
  switch (tab.target) {
    case 'web':
    case 'flutter':
    case 'apple':
      return demo
        ? 'A demo project needs no real configuration, so this runs as printed. Run it once, before the app reads or writes anything.'
        : 'Keep your app’s own configuration; the lines after it point each SDK at the emulators. Run them once, before the app reads or writes anything.'
    case 'android':
      return 'Run these once, before the app reads or writes anything. On a device or the Android emulator, pick the host it reaches this machine at.'
    case 'admin-node':
    case 'python':
    case 'go':
    case 'java':
      return 'Server code: firenook emulators:exec sets every variable for the command it starts, and a demo credentials file where an SDK asks for one.'
    case 'env':
      return 'firenook emulators:exec sets the variables it marks for the command it starts; Functions get the last ones too.'
    case 'firebase-json':
      return 'The ports and host this engine runs on, for a project that should start the same way next time.'
  }
}

export function ConnectDialog({
  open,
  onOpenChange,
  status,
  engine,
  param,
  onParam,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: ConsoleStatus
  engine: OverviewEngineDetails | undefined
  param: ConnectParam | undefined
  /** A platform was picked here; the page keeps it in the address. */
  onParam: (param: ConnectParam) => void
}) {
  const host = useConnectHost(status)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="flex max-h-[min(88vh,760px)] flex-col p-0 sm:w-[min(1000px,calc(100vw-4rem))]">
        <div className="contents" data-testid="overview-connect">
          <div className="flex min-w-0 items-start justify-between gap-4 px-6 pt-5 pb-4">
            <div className="grid min-w-0 gap-1">
              <Dialog.Title className="text-lg font-semibold">Connect your app</Dialog.Title>
              <Dialog.Description className="text-[14px] text-kumo-subtle">
                The code that points an app at this engine, with its ports, host and project id
                filled in.
              </Dialog.Description>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <HostPicker host={host} />
              <Dialog.Close
                aria-label="Close"
                render={
                  <Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />
                }
              />
            </div>
          </div>
          <ConnectBody
            status={status}
            engine={engine}
            host={host.host}
            param={param}
            onParam={onParam}
          />
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

/** The dialog's body, which the design system draws on its own: the platforms, then the code. */
export function ConnectBody({
  status,
  engine,
  host,
  param,
  onParam,
}: {
  status: ConsoleStatus
  engine: OverviewEngineDetails | undefined
  /** The host the snippets name. */
  host: string
  param: ConnectParam | undefined
  onParam: (param: ConnectParam) => void
}) {
  const tab = connectTab(param)
  const code = connectSnippet(tab.target, {
    services: status.services.map((service) => service.name),
    host,
    status,
    bucket: engine?.config?.defaultBucket,
  })
  const demo = engine?.config?.demoProject ?? status.projectId.startsWith('demo-')
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[12.5rem_minmax(0,1fr)] border-t border-kumo-line">
      <Platforms current={tab.param as ConnectParam} onPick={onParam} />
      <div className="grid min-h-0 min-w-0 content-start gap-3 overflow-auto px-6 py-5">
        <CodeBlock
          label={tab.title}
          code={code}
          language={
            tab.target === 'firebase-json'
              ? 'json'
              : tab.target === 'env'
                ? 'shell'
                : tab.target === 'python'
                  ? 'python'
                  : tab.target === 'go'
                    ? 'go'
                    : 'js'
          }
          testId="overview-connect-snippet"
        />
        <p
          className="max-w-[72ch] text-[13px] text-kumo-subtle"
          data-testid="overview-connect-note"
        >
          {snippetNote(tab, demo)}
        </p>
      </div>
    </div>
  )
}

/**
 * The platforms, a vertical tab list: the one shown is marked, ↑ and ↓
 * move along the list (and show what they land on), Home and End go to
 * its ends.
 */
function Platforms({
  current,
  onPick,
}: {
  current: ConnectParam
  onPick: (param: ConnectParam) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const order = GROUPS.flatMap((group) => group.params)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = order.indexOf(current)
    const next =
      event.key === 'ArrowDown'
        ? order[Math.min(order.length - 1, at + 1)]
        : event.key === 'ArrowUp'
          ? order[Math.max(0, at - 1)]
          : event.key === 'Home'
            ? order[0]
            : event.key === 'End'
              ? order.at(-1)
              : undefined
    if (!next) return
    event.preventDefault()
    onPick(next)
    list.current?.querySelector<HTMLElement>(`[data-param="${next}"]`)?.focus()
  }
  return (
    <div
      ref={list}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Platform"
      className="grid content-start gap-4 overflow-auto border-r border-kumo-line bg-kumo-elevated px-3 py-4"
      onKeyDown={onKeyDown}
      data-testid="overview-connect-tabs"
    >
      {GROUPS.map((group) => (
        <div key={group.label} className="grid gap-0.5">
          <span className="px-2 pb-1 text-[11px] font-medium tracking-wide text-kumo-subtle uppercase">
            {group.label}
          </span>
          {group.params.map((param) => {
            const entry = CONNECT_TABS.find((candidate) => candidate.param === param)
            if (!entry) return null
            const selected = param === current
            return (
              <button
                key={param}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-param={param}
                onClick={() => onPick(param)}
                className={cn(
                  'flex h-8 min-w-0 items-center rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus',
                  selected
                    ? 'bg-kumo-base font-medium text-kumo-default shadow-xs ring ring-kumo-line'
                    : 'text-kumo-subtle hover:ink hover:text-kumo-default',
                )}
              >
                <span className="truncate">{entry.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function HostPicker({ host }: { host: ReturnType<typeof useConnectHost> }) {
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const options = host.custom
    ? [...host.options, { host: host.host, label: 'Typed' }]
    : host.options
  if (typing) {
    const apply = () => {
      host.chooseCustom(text)
      setTyping(false)
    }
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <Input
          size="sm"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setTyping(false)
            }
          }}
          placeholder="Host or IP address"
          aria-label="The host your app connects to"
          spellCheck={false}
          autoComplete="off"
          className="w-52 font-mono"
          data-testid="overview-host-input"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          shape="square"
          icon={<CheckIcon />}
          aria-label="Use this host"
          title="Use this host"
          disabled={text.trim() === ''}
        />
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<XIcon />}
          aria-label="Keep the current host"
          title="Keep the current host"
          onClick={() => setTyping(false)}
        />
      </form>
    )
  }
  return (
    <div className="min-w-0" data-testid="overview-host">
      <Select
        size="xs"
        value={host.host}
        onValueChange={(next) => {
          const value = String(next)
          if (value === CUSTOM) {
            setText(host.custom ? host.host : '')
            setTyping(true)
          } else host.choose(value)
        }}
        renderValue={() => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-kumo-subtle">Host</span>
            <span className="truncate font-mono">{hostLiteral(host.host)}</span>
          </span>
        )}
        aria-label="Host your app connects to"
        className="h-6.5 min-w-0 rounded-md"
      >
        {options.map((option) => (
          <Select.Option key={option.host} value={option.host}>
            <span className="flex min-w-0 items-center gap-3">
              <span className="truncate font-mono text-[12px]">{hostLiteral(option.host)}</span>
              <span className="ml-auto shrink-0 text-[12px] text-kumo-subtle">{option.label}</span>
            </span>
          </Select.Option>
        ))}
        <Select.Option value={CUSTOM}>
          <span className="text-[12px]">Custom…</span>
        </Select.Option>
      </Select>
    </div>
  )
}
