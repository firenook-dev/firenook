// The body of a composed request: none, JSON, text, a form or bytes. JSON
// is the kit's JsonField (the code editor, what does not parse said with
// its line and column, and a Format that keeps every value as typed);
// text, a form (`a=1&b=2`) and base64 get a plain box in the data face.
// Switching kind keeps what was typed, so a person who picks the wrong one
// does not lose it.

import { InputArea, Tabs, Text } from '@cloudflare/kumo'
import { JsonField } from '../json-field'
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
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid={testId} data-kind={value.kind}>
      {kinds.length > 1 && (
        <div className="flex items-center gap-2">
          <Tabs
            size="sm"
            variant="segmented"
            value={value.kind}
            onValueChange={(next) => onChange({ ...value, kind: next as BodyKind })}
            tabs={kinds.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
          />
        </div>
      )}
      {value.kind === 'none' ? (
        <Text size="sm" variant="secondary">
          No body is sent.
        </Text>
      ) : value.kind === 'json' ? (
        <JsonField
          value={value.text}
          onChange={(text) => onChange({ ...value, text })}
          minLines={7}
          maxLines={16}
          ariaLabel="Body"
          testId={`${testId}-json`}
        />
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
