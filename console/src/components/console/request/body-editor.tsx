// The body of a composed request: none, JSON, text, a form or bytes. JSON
// gets the console's code editor (it marks what does not parse, and
// Format tidies it); text, a form (`a=1&b=2`) and base64 get a plain box
// in the data face. Switching kind keeps what was typed, so a person who
// picks the wrong one does not lose it.

import { Button, InputArea, Tabs, Text } from '@cloudflare/kumo'
import { BracketsCurlyIcon } from '@phosphor-icons/react'
import { CodeEditor } from '@/components/code-editor'
import type { BodyKind, RequestBody } from './types'

const KIND_LABELS: Record<BodyKind, string> = {
  none: 'None',
  json: 'JSON',
  text: 'Text',
  form: 'Form',
  base64: 'Base64',
}

const ALL_KINDS: readonly BodyKind[] = ['none', 'json', 'text', 'form', 'base64']

const PLACEHOLDERS: Record<Exclude<BodyKind, 'none' | 'json'>, string> = {
  text: 'Plain text, sent as text/plain',
  form: 'name=Ada&plan=pro',
  base64: 'Bytes as base64, sent decoded',
}

/** The JSON text tidied, or undefined when it does not parse. */
export function formatJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}

export function BodyEditor({
  value,
  onChange,
  kinds = ALL_KINDS,
  testId = 'request-body',
}: {
  value: RequestBody
  onChange: (body: RequestBody) => void
  /** The kinds this target takes (a callable: JSON only). */
  kinds?: readonly BodyKind[]
  testId?: string
}) {
  const formatted = value.kind === 'json' ? formatJson(value.text) : undefined
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid={testId} data-kind={value.kind}>
      {(kinds.length > 1 || value.kind === 'json') && (
        <div className="flex items-center justify-between gap-2">
          {kinds.length > 1 ? (
            <Tabs
              size="sm"
              variant="segmented"
              value={value.kind}
              onValueChange={(next) => onChange({ ...value, kind: next as BodyKind })}
              tabs={kinds.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
            />
          ) : (
            <span />
          )}
          {value.kind === 'json' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<BracketsCurlyIcon />}
              disabled={formatted === undefined || formatted === value.text}
              onClick={() => formatted !== undefined && onChange({ ...value, text: formatted })}
              data-testid={`${testId}-format`}
            >
              Format
            </Button>
          )}
        </div>
      )}
      {value.kind === 'none' ? (
        <Text size="sm" variant="secondary">
          No body is sent.
        </Text>
      ) : value.kind === 'json' ? (
        <div className="flex h-40 min-h-0 flex-col overflow-hidden rounded-md ring ring-kumo-line focus-within:ring-kumo-focus">
          <CodeEditor
            value={value.text}
            onChange={(text) => onChange({ ...value, text })}
            ariaLabel="Body"
            testId={`${testId}-json`}
          />
        </div>
      ) : (
        <InputArea
          size="sm"
          value={value.text}
          onValueChange={(text) => onChange({ ...value, text })}
          placeholder={PLACEHOLDERS[value.kind]}
          aria-label="Body"
          spellCheck={false}
          autoComplete="off"
          className="h-40 resize-none font-mono text-[12px] leading-5"
          data-testid={`${testId}-text`}
        />
      )}
    </div>
  )
}
