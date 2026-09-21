// Copy the current query, or a document, as the code that reproduces it.

import { Button, Popover, Tabs, Text } from '@cloudflare/kumo'
import { CheckIcon, CodeIcon, CopyIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { statusQuery } from '@/api/queries'
import { CODE_TARGETS, type CodeTarget, queryAsCode } from '../query'
import { useWorkbench } from './workbench-context'

export function CodePopover() {
  const workbench = useWorkbench()
  const status = useQuery(statusQuery)
  const [target, setTarget] = useState<CodeTarget>('web')
  if (!workbench.collectionPath) return null
  const code = queryAsCode(target, workbench.collectionPath, workbench.group, workbench.query, {
    project: workbench.project,
    database: workbench.database,
    origin: firestoreOrigin(status.data?.services),
  })
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="ghost" size="sm" icon={<CodeIcon />} aria-label="Copy the query as code">
            Code
          </Button>
        }
      />
      <Popover.Content className="w-[560px] max-w-[calc(100vw-2rem)]">
        <CodeBlock code={code} target={target} setTarget={setTarget} title="This query as code" />
      </Popover.Content>
    </Popover>
  )
}

/** Where an app sends REST calls: the Firestore port the engine advertises. */
export function firestoreOrigin(
  services: ReadonlyArray<{ name: string; host: string; port: number }> | undefined,
): string {
  const firestore = services?.find((service) => service.name === 'firestore')
  return firestore ? `http://${firestore.host}:${firestore.port}` : window.location.origin
}

export function CodeBlock({
  code,
  target,
  setTarget,
  title,
}: {
  code: string
  target: CodeTarget
  setTarget: (target: CodeTarget) => void
  title: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <Text variant="heading" as="h3">
          {title}
        </Text>
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <Tabs
        size="sm"
        variant="segmented"
        value={target}
        onValueChange={(value) => setTarget(value as CodeTarget)}
        tabs={CODE_TARGETS.map((item) => ({ value: item.id, label: item.label }))}
      />
      <pre className="max-h-80 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] leading-5 text-kumo-default">
        {code}
      </pre>
    </div>
  )
}
