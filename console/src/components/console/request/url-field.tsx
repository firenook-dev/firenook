// Where a composed request goes. The fixed part of the address — the
// service's origin, a function's region and project — is muted before the
// part a person edits (a path, a query), so it reads as one address and
// types as the part that changes. The whole prefix is in the tooltip when
// a narrow panel shortens it.

import { InputGroup, Tooltip } from '@cloudflare/kumo'

export function UrlField({
  prefix,
  value,
  onChange,
  placeholder = '/path?query',
  onEnter,
  testId = 'request-url',
}: {
  /** Shown muted before the value: `…/demo-x/us-central1/greet`. */
  prefix: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Enter in the field (the composer sends). */
  onEnter?: () => void
  testId?: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <InputGroup size="sm" className="h-8 w-full rounded-lg">
        {prefix !== '' && (
          <InputGroup.Addon className="max-w-[55%] min-w-0 pr-0">
            <Tooltip
              content={prefix}
              render={
                <span
                  className="block truncate font-mono text-[12px] text-kumo-subtle"
                  dir="rtl"
                  data-testid={`${testId}-prefix`}
                >
                  {/* `dir="rtl"` cuts the start, which is the part that never changes; the
                      bidi isolate keeps the address itself reading left to right. */}
                  <bdi>{prefix}</bdi>
                </span>
              }
            />
          </InputGroup.Addon>
        )}
        <InputGroup.Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && onEnter) {
              event.preventDefault()
              onEnter()
            }
          }}
          placeholder={placeholder}
          aria-label="Address"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 pl-1 font-mono text-[12px]"
          data-testid={testId}
        />
      </InputGroup>
    </div>
  )
}
