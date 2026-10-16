// The rules against the data, on either rules page: every place the data
// is (a collection, a folder of files), with the match blocks that govern
// it and what they allow; the places no rule covers, where every client
// request is denied; and the match blocks that reach nothing, which is
// usually a typo in a path. Only an emulator can draw this: it holds both
// the rules and the data. A page fills the rows; the frame, its states and
// the unused blocks are the same on both. The engine's warnings about the
// rules are the Problems strip's, not listed here again.

import { Text } from '@cloudflare/kumo'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RulesDiagnostic } from './text'

/** What a map check answers with, whichever service's rules it read. */
export interface MapCheck {
  diagnostics: RulesDiagnostic[]
}

export interface MapUnused {
  line: number
  path: string
}

export function RulesMapPanel<C extends MapCheck>({
  testId,
  check,
  checked,
  header,
  notice,
  map,
  title,
  aside,
  holds,
  unused,
  emptyText,
  rows,
  countingText,
  onReveal,
}: {
  testId: string
  check: UseQueryResult<C, Error>
  /** The text the page last checked; none before the rules load. */
  checked: string | undefined
  /** A bar over the map: the bucket and its starter menu. */
  header?: ReactNode
  /** A notice over the map: Firestore must run for rules that read it. */
  notice?: ReactNode
  /** The map, when the check has one; `null` while the engine is still counting. */
  map: { rows: number; unused: readonly MapUnused[] } | null | undefined
  /** "Collections in your data", "Folders that hold files". */
  title: string
  /** Beside the title: a note about how the rows are grouped. */
  aside?: ReactNode
  /** What the rules govern, in "Fix the errors … to see which rules govern your …": "data", "files". */
  holds: string
  /** The unused blocks' heading and what it says of them. */
  unused: { title: string; note: string }
  /** What an empty map says: "This database holds no documents yet." */
  emptyText: string
  rows: ReactNode
  /** Said while the engine counts what the map needs. */
  countingText?: string | undefined
  onReveal: (line: number) => void
}) {
  const errors = (check.data?.diagnostics ?? []).some((item) => item.severity === 'error')
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      {notice}
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(checked === undefined || check.isPending) && (
          <div className="p-4">
            <Text size="sm" variant="secondary">
              Reading the rules…
            </Text>
          </div>
        )}
        {check.isError && (
          <div className="p-4">
            <Text size="sm" variant="secondary">
              {check.error.message}
            </Text>
          </div>
        )}
        {errors && (
          <div className="p-4">
            <Text size="sm" variant="secondary">
              Fix the errors in the editor to see which rules govern your {holds}.
            </Text>
          </div>
        )}
        {check.data && !errors && map === null && countingText && (
          <div className="p-4" data-testid="rules-map-counting">
            <Text size="sm" variant="secondary">
              {countingText}
            </Text>
          </div>
        )}
        {map && (
          <>
            <section className="grid gap-2 px-3 py-3" data-testid="rules-map">
              <div className="flex items-baseline gap-2">
                <Text as="h3" size="xs" bold>
                  {title}
                </Text>
                {aside}
              </div>
              {map.rows === 0 ? (
                <Text size="sm" variant="secondary">
                  {emptyText}
                </Text>
              ) : (
                <ul className="grid gap-1">{rows}</ul>
              )}
            </section>
            {map.unused.length > 0 && (
              <section
                className="grid gap-2 border-t border-kumo-line px-3 py-3"
                data-testid="rules-unused"
              >
                <Text as="h3" size="xs" bold>
                  {unused.title}
                </Text>
                <Text size="xs" variant="secondary">
                  {unused.note}
                </Text>
                <ul className="grid gap-0.5">
                  {map.unused.map((item) => (
                    <li key={`${item.line}:${item.path}`}>
                      <button
                        type="button"
                        onClick={() => onReveal(item.line)}
                        className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:ink"
                      >
                        <span className="w-14 shrink-0 font-mono text-[11px] text-kumo-subtle">
                          line {item.line}
                        </span>
                        <span className="min-w-0 truncate font-mono text-[12px]">
                          match {item.path}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
