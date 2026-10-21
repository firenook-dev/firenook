// One copyable block of code with optional dialect tabs: a firebase.json
// snippet in a section's gate, the connection snippet for an app, a
// document as code in the Firestore inspector. Its title sits on the row of
// its Copy button, so what is copied is named where it is copied from; the
// tabs, when there are several dialects, sit between the two. Every block
// says its language, so the code is in colour wherever it is shown.

import { Button, Tabs } from '@cloudflare/kumo'
import { useState } from 'react'
import { CopyGlyph, PanelTitle, useCopied } from '@/components/kit'
import type { CodeLanguage } from '@/lib/code-language'
import { useCodeHighlight } from './use-code-highlight'

export type { CodeLanguage }

/** One tab of a block: what it is called, the code it holds and its language. */
export interface CodeDialect {
  id: string
  label: string
  code: string
  language: CodeLanguage
}

/** What a block shows: one piece of code, or one per dialect behind tabs. */
type CodeContent =
  | {
      /** One block without tabs. */
      code: string
      language: CodeLanguage
      dialects?: never
    }
  | {
      /** One block per dialect, behind segmented tabs. */
      dialects: readonly CodeDialect[]
      code?: never
      language?: never
    }

export function CodeBlock({
  label,
  dialects,
  code,
  language,
  value,
  onValueChange,
  testId,
}: CodeContent & {
  /** What the block holds ("Add it to firebase.json", "This document as code"). */
  label?: string
  /** The dialect shown, when the caller keeps it (Firestore remembers its last). */
  value?: string
  onValueChange?: (id: string) => void
  /** The block's test id; its Copy button is `<testId>-copy` (`copy-code` without one). */
  testId?: string
}) {
  const { copied, copy } = useCopied()
  const [own, setOwn] = useState(dialects?.[0]?.id)
  const current = value ?? own
  const shown = dialects?.find((dialect) => dialect.id === current) ?? dialects?.[0]
  const text = shown?.code ?? code ?? ''
  const shownLanguage = shown?.language ?? language
  const coloured = useCodeHighlight(text, shownLanguage)
  const choose = (id: string) => {
    setOwn(id)
    onValueChange?.(id)
  }
  return (
    <div className="grid min-w-0 gap-2" data-testid={testId} data-language={shownLanguage}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        {label ? <PanelTitle as="h4">{label}</PanelTitle> : <span />}
        <Button
          variant="secondary"
          size="sm"
          icon={<CopyGlyph copied={copied} />}
          onClick={() => void copy(text)}
          data-testid={testId ? `${testId}-copy` : 'copy-code'}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {dialects && dialects.length > 1 && (
        <Tabs
          size="sm"
          variant="segmented"
          value={shown?.id ?? ''}
          onValueChange={choose}
          tabs={dialects.map((dialect) => ({ value: dialect.id, label: dialect.label }))}
        />
      )}
      <pre className="max-h-80 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line">
        {coloured}
      </pre>
    </div>
  )
}
