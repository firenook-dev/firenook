// "Connect your app": the code that points an app at this engine, for every
// platform, with the ports in use, the project id and the host the app
// sees — printed by the console's one generator (`lib/connect.ts`), so it is
// the same text every page prints. A demo project's snippets are complete
// and run as printed; another project keeps the app's own configuration.
// The host picker offers the engine's connect host, the address this page
// was opened at, the Android emulator's 10.0.2.2, or one typed, and the
// choice is kept per browser.

import { Button, Input, Select, Tabs } from '@cloudflare/kumo'
import { CheckIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import { CodeBlock } from '@/components/console/code-block'
import { connectSnippet, hostLiteral } from '@/lib/connect'
import { useConnectHost } from '../host'
import { reveal } from '../reveal'
import { CONNECT_TABS, type ConnectTab, connectTab } from '../connect-tabs'
import type { ConnectParam } from '../search'

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

export function ConnectSection({
  status,
  engine,
  param,
  onParam,
}: {
  status: ConsoleStatus
  engine: OverviewEngineDetails | undefined
  param: ConnectParam | undefined
  /** A tab was picked here; the page keeps it in the address. */
  onParam: (param: ConnectParam) => void
}) {
  const host = useConnectHost(status)
  const tab = connectTab(param)
  const section = useRef<HTMLElement>(null)
  // A tab picked here changes the address too; only a change from elsewhere
  // (⌘K, a card's "Connect", a link) brings the section into view.
  const picked = useRef(false)
  useEffect(() => {
    if (picked.current) {
      picked.current = false
      return
    }
    if (param) reveal(section.current)
  }, [param])

  const code = connectSnippet(tab.target, {
    services: status.services.map((service) => service.name),
    host: host.host,
    status,
    bucket: engine?.config?.defaultBucket,
  })
  const demo = engine?.config?.demoProject ?? status.projectId.startsWith('demo-')
  return (
    <section
      ref={section}
      id="overview-connect"
      className="grid gap-3"
      aria-labelledby="overview-connect-title"
      data-testid="overview-connect"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="overview-connect-title" className="text-lg font-semibold">
          Connect your app
        </h2>
        <HostPicker host={host} />
      </div>
      <div className="-mx-1 overflow-x-auto px-1 py-0.5" data-testid="overview-connect-tabs">
        <Tabs
          size="sm"
          variant="segmented"
          value={tab.param}
          onValueChange={(next) => {
            picked.current = next !== tab.param
            onParam(next as ConnectParam)
          }}
          tabs={CONNECT_TABS.map((entry) => ({ value: entry.param, label: entry.label }))}
          className="w-max"
        />
      </div>
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
      <p className="max-w-[72ch] text-[13px] text-kumo-subtle" data-testid="overview-connect-note">
        {snippetNote(tab, demo)}
      </p>
    </section>
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
        className="ml-auto flex items-center gap-1"
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
    <div className="ml-auto min-w-0" data-testid="overview-host">
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
