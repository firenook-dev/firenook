// Where a line came from, as the quiet chip a log row draws (`LogLine`'s
// `SOURCE_CHIP`, `TypeBadge`'s recipe): the function's short name (`hello`
// for `us-central1-hello`, the region in the tooltip), else the extension
// instance, else the service. The same chip stands in the Logs rows, the
// Logs inspector and the Overview's recent problems.
//
// With `onPick` it is a button that hands its filter item to the page,
// which adds it to its query: `function:us-central1-hello`, `instance:resize-images`,
// `service:firestore` — the keys `linkToLogs` and the facets write. A line
// that names its function only in the terminal label it was printed under
// (`functions[us-central1-hello]`, before the line carries the function
// itself) is matched by that label as a phrase, which the engine's word
// search finds in the line's source.

import { Tooltip, cn } from '@cloudflare/kumo'
import type { MouseEvent } from 'react'
import { SOURCE_CHIP } from '@/components/console/log-line'
import { filterValueText, quoteFilterText } from '@/lib/filter'
import { serviceLabel } from '@/lib/services'

/** What a line says about where it came from (`LogEntry`'s fields). */
export interface SourceFields {
  service: string
  /** The terminal's label when narrower than the service: `functions[us-central1-hello]`. */
  source?: string | null | undefined
  function?: string | null | undefined
  extension?: string | null | undefined
}

/** The filter item a chip adds: a term with a Logs key, or a phrase. */
export type SourceToken =
  | { key: 'function' | 'instance' | 'service'; value: string }
  | { phrase: string }

export interface LineSource {
  /** What the chip shows: `hello`, `resize-images`, `firestore`. */
  text: string
  /** What it is, in words, for the tooltip: "Function us-central1-hello in us-central1". */
  description: string
  /** What a click does, for assistive technology: "Filter by function us-central1-hello". */
  filter: string
  token: SourceToken
}

// A Functions region: `us-central1`, `europe-west1`, `northamerica-northeast1`.
const REGION = /^([a-z]+-[a-z]+[0-9]+)-(.+)$/

/** `us-central1-hello` → `{ name: 'hello', region: 'us-central1' }`; an id without a region is its own name. */
export function functionName(id: string): { name: string; region: string | undefined } {
  const match = REGION.exec(id)
  return match?.[1] && match[2]
    ? { name: match[2], region: match[1] }
    : { name: id, region: undefined }
}

/** `functions[us-central1-hello]` → `['functions', 'us-central1-hello']`. */
function splitLabel(label: string): [string, string] | undefined {
  const open = label.indexOf('[')
  if (open <= 0 || !label.endsWith(']')) return undefined
  const inner = label.slice(open + 1, -1)
  return inner ? [label.slice(0, open), inner] : undefined
}

function fromFunction(id: string, token: SourceToken): LineSource {
  const { name, region } = functionName(id)
  return {
    text: name,
    description: region ? `Function ${id} in ${region}` : `Function ${id}`,
    filter: `Filter by function ${id}`,
    token,
  }
}

function fromInstance(id: string, token: SourceToken): LineSource {
  return {
    text: id,
    description: `Extension instance ${id}`,
    filter: `Filter by extension instance ${id}`,
    token,
  }
}

/** Where a log line came from, as the chip draws it. */
export function lineSource(line: SourceFields): LineSource {
  if (line.function) return fromFunction(line.function, { key: 'function', value: line.function })
  if (line.extension)
    return fromInstance(line.extension, { key: 'instance', value: line.extension })
  const label = line.source ? splitLabel(line.source) : undefined
  if (label && line.source) {
    const [family, inner] = label
    if (family === 'functions') return fromFunction(inner, { phrase: line.source })
    if (family === 'extensions') return fromInstance(inner, { phrase: line.source })
  }
  return {
    text: line.service,
    description: serviceLabel(line.service),
    filter: `Filter by service ${line.service}`,
    token: { key: 'service', value: line.service },
  }
}

/**
 * The Overview's problems name their source by the terminal's label or the
 * service alone (`OverviewProblem.source`): `functions[us-central1-hello]`,
 * `extensions[resize-images]`, `firestore`.
 */
export function labelSource(label: string): LineSource {
  const parts = splitLabel(label)
  return lineSource(parts ? { service: parts[0], source: label } : { service: label })
}

/** The token as filter text: `function:us-central1-hello`, `"functions[us-central1-hello]"`. */
export function sourceTokenText(token: SourceToken): string {
  if ('phrase' in token) return quoteFilterText(token.phrase)
  return `${token.key}:${filterValueText(token.value)}`
}

export function SourceChip({
  source,
  onPick,
  tabIndex,
  className,
  testId,
}: {
  source: LineSource
  /** Makes the chip a button that adds its filter item. */
  onPick?: ((token: SourceToken) => void) | undefined
  /** -1 inside a list whose own keys move between rows. */
  tabIndex?: number | undefined
  className?: string | undefined
  testId?: string | undefined
}) {
  if (!onPick)
    return (
      <Tooltip
        content={source.description}
        render={
          <span className={cn(SOURCE_CHIP, className)} data-testid={testId}>
            <span className="truncate">{source.text}</span>
          </span>
        }
      />
    )
  const pick = (event: MouseEvent) => {
    // The row under the chip opens on a click; the chip's click is its own.
    event.stopPropagation()
    onPick(source.token)
  }
  return (
    <Tooltip
      content={`${source.description} · Click to filter by it`}
      render={
        <button
          type="button"
          aria-label={source.filter}
          tabIndex={tabIndex}
          onClick={pick}
          className={cn(
            SOURCE_CHIP,
            'outline-none hover:text-kumo-default focus-visible:ring focus-visible:ring-kumo-focus',
            className,
          )}
          data-testid={testId}
        >
          {/* The chip is a flex box, which cuts no text with an ellipsis itself. */}
          <span className="truncate">{source.text}</span>
        </button>
      }
    />
  )
}
