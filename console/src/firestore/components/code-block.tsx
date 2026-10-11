// A document as the code that writes it back, typed — the inspector's Code.
//
// The query line had one too, and it was taken out: the line is already
// the SDK chain, so the Web tab printed back what had just been typed,
// and with no filter it was `collection()` plus the grid's `limit(100)`,
// a page size nobody asked for that fetched a hundred documents of a
// collection the grid pages through whole. A document is different: its
// types are the one thing only the console knows.

import { Button, Tabs } from '@cloudflare/kumo'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { PanelTitle } from '@/components/kit'
import { useState } from 'react'
import { CODE_TARGETS, type CodeTarget } from '../query'

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
        <PanelTitle>{title}</PanelTitle>
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
