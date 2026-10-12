// A JSON value with the two ways a developer wants to read it: the tree,
// to fold and search and copy a path from, and the raw text, exactly as it
// came (or laid out, when only the value is here). One band above holds the
// switch, the tree's search — "2 of 5" with ↑ ↓ — and Copy JSON.

import { Button, Tabs, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { CopyGlyph, useCopied } from '@/components/kit'
import { CodeEditor } from '@/components/code-editor'
import { formatNumber } from '@/lib/format'
import { JsonTree } from './json-tree'
import type { JsonPath } from './json-tree-model'

/** The raw text a value reads as, two spaces, when no text came with it. */
function rawOf(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2) ?? String(value)
}

/** A hand-made square for the band: Kumo's extra-small one is 12 px at this root. */
const SQUARE =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-kumo-subtle outline-none hover:ink hover:text-kumo-default focus-visible:ring focus-visible:ring-kumo-focus disabled:text-kumo-inactive disabled:hover:bg-none'

export function JsonView({
  value,
  text,
  defaultTab = 'tree',
  mask,
  testId,
}: {
  value: unknown
  /** The text exactly as it came (a payload's own bytes), for the Raw tab. */
  text?: string | undefined
  defaultTab?: 'tree' | 'raw' | undefined
  /** Values the tree masks; the Raw tab is then not offered, since it would show them. */
  mask?: ((path: JsonPath) => boolean) | undefined
  testId?: string | undefined
}) {
  const [tab, setTab] = useState<'tree' | 'raw'>(mask ? 'tree' : defaultTab)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState({ count: 0, stopped: false })
  const [active, setActive] = useState(0)
  const { copied, copy } = useCopied()
  const raw = text ?? rawOf(value)
  const step = (by: 1 | -1) => {
    if (hits.count === 0) return
    setActive((current) => (current + by + hits.count) % hits.count)
  }
  const searching = query.trim() !== ''
  const ids = testId ?? 'json-view'

  return (
    <div className="flex min-h-[240px] min-w-0 flex-1 flex-col" data-testid={testId}>
      <div className="flex shrink-0 items-center gap-2 border-b border-kumo-line px-5 py-1.5">
        {mask === undefined && (
          <Tabs
            size="sm"
            variant="segmented"
            value={tab}
            onValueChange={(next) => setTab(next as 'tree' | 'raw')}
            tabs={[
              { value: 'tree', label: 'Tree' },
              { value: 'raw', label: 'Raw' },
            ]}
          />
        )}
        {tab === 'tree' && (
          // The path field's twin, small: flat at rest, a ground under the
          // pointer, the ring on focus.
          <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-1 rounded-md pr-0.5 pl-1.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:ink">
            <MagnifyingGlassIcon size={13} className="shrink-0 text-kumo-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  step(event.shiftKey ? -1 : 1)
                } else if (event.key === 'Escape' && query !== '') {
                  event.preventDefault()
                  event.stopPropagation()
                  setQuery('')
                }
              }}
              placeholder="Search keys and values"
              spellCheck={false}
              autoComplete="off"
              aria-label="Search keys and values"
              className="h-full min-w-0 flex-1 bg-transparent px-1 font-mono text-[12px] text-kumo-default outline-none placeholder:font-sans placeholder:text-kumo-inactive"
              data-testid={`${ids}-search`}
            />
            {searching && (
              <>
                <span
                  className="shrink-0 px-1 text-[11px] text-kumo-subtle tabular-nums"
                  aria-live="polite"
                  data-testid={`${ids}-hits`}
                >
                  {hits.count === 0
                    ? 'No match'
                    : `${formatNumber(Math.min(active, hits.count - 1) + 1)} of ${formatNumber(hits.count)}${hits.stopped ? '+' : ''}`}
                </span>
                <Tooltip
                  content="Previous match · ⇧↵"
                  render={
                    <button
                      type="button"
                      className={SQUARE}
                      aria-label="Previous match"
                      disabled={hits.count === 0}
                      onClick={() => step(-1)}
                    >
                      <CaretUpIcon size={12} />
                    </button>
                  }
                />
                <Tooltip
                  content="Next match · ↵"
                  render={
                    <button
                      type="button"
                      className={SQUARE}
                      aria-label="Next match"
                      disabled={hits.count === 0}
                      onClick={() => step(1)}
                    >
                      <CaretDownIcon size={12} />
                    </button>
                  }
                />
                <Tooltip
                  content="Clear the search"
                  render={
                    <button
                      type="button"
                      className={SQUARE}
                      aria-label="Clear the search"
                      onClick={() => setQuery('')}
                    >
                      <XIcon size={12} />
                    </button>
                  }
                />
              </>
            )}
          </label>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <Tooltip
            content={copied ? 'Copied' : 'Copy the JSON'}
            render={
              <Button
                variant="ghost"
                size="sm"
                icon={<CopyGlyph copied={copied} />}
                onClick={() => void copy(raw)}
                aria-label={copied ? 'Copied' : 'Copy the JSON'}
                data-testid={`${ids}-copy`}
              >
                Copy JSON
              </Button>
            }
          />
        </span>
      </div>
      {tab === 'tree' ? (
        <div className="flex min-h-0 flex-1 flex-col py-1">
          <JsonTree
            value={value}
            search={query}
            activeHit={searching && hits.count > 0 ? Math.min(active, hits.count - 1) : undefined}
            onHits={(count, stopped) => setHits({ count, stopped })}
            height="fill"
            mask={mask}
            ariaLabel="JSON tree"
            testId={`${ids}-tree`}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md ring ring-kumo-line">
            <CodeEditor
              value={raw}
              onChange={() => undefined}
              readOnly
              ariaLabel="Raw JSON"
              testId={`${ids}-raw`}
            />
          </div>
        </div>
      )}
    </div>
  )
}
