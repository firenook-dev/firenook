// Levels, services, states, providers: one list of toggles that writes the
// page's `q`, so the URL stays the truth and a facet is only a quicker way
// to type a term. Pressing one adds its term (`level:error`) or takes it
// out; on hover a row offers Only (this term replaces the group's terms)
// and Hide (the negated term, `-level:debug`, drawn struck through and
// announced as `aria-pressed="mixed"`).
//
// The text is edited where it stands: a term is removed by its own span in
// the filter, so everything else the developer typed — words, phrases,
// other keys, their order — is left exactly as it was.
//
// A facet may also write more than one term, or a negated one: Auth's
// "Unverified email" is `has:email -is:verified`, its "Never signed in"
// `-has:sign-in`, the Inbox's "Unused" `-is:used`. Such a compound facet is
// pressed when every one of its terms is in the filter as written, and
// pressing it writes the missing ones (taking out any term it contradicts,
// `is:verified` for `-is:verified`) or takes all of them out. It is its own
// negation already, so it offers neither Only nor Hide.

import { cn } from '@cloudflare/kumo'
import { CheckIcon } from '@phosphor-icons/react'
import { formatNumber } from '@/lib/format'
import { type FilterTerm, parseFilter } from '@/lib/filter'

export interface Facet {
  /** The term it writes: `level:error`. */
  term: string
  label: string
  count?: number | undefined
  tone?: 'danger' | 'warning' | undefined
}

export interface FacetGroup {
  label: string
  facets: readonly Facet[]
}

export type FacetState = 'on' | 'negated' | 'off'

/** A facet's term split into its key and value, lowercased for comparing. */
function split(term: string): { key: string; value: string } {
  const at = term.search(/[:=]/)
  if (at === -1) return { key: term.toLowerCase(), value: '' }
  return {
    key: term.slice(0, at).toLowerCase(),
    value: term
      .slice(at + 1)
      .replace(/^"|"$/g, '')
      .toLowerCase(),
  }
}

/** The plain-equality terms of a filter, with their spans; none when it does not parse. */
function termsOf(q: string): FilterTerm[] {
  const parsed = parseFilter(q, false)
  return parsed.ok ? parsed.query.terms.filter((term) => term.op === 'eq') : []
}

function same(term: FilterTerm, facet: { key: string; value: string }): boolean {
  return term.key.toLowerCase() === facet.key && term.value.toLowerCase() === facet.value
}

/** One term a compound facet writes, as it is compared, and where it stands in the facet's text. */
interface FacetPart {
  key: string
  value: string
  negated: boolean
  text: string
}

/**
 * The terms of a compound facet — several, or a negated one — or
 * `undefined` for a facet of one plain term, which keeps the rules above.
 */
function compoundParts(term: string): FacetPart[] | undefined {
  const parsed = parseFilter(term, false)
  if (!parsed.ok) return undefined
  const { terms, words, regexes } = parsed.query
  if (words.length > 0 || regexes.length > 0 || terms.some((part) => part.op !== 'eq'))
    return undefined
  if (terms.length < 2 && !terms.some((part) => part.negated)) return undefined
  return terms.map((part) => ({
    key: part.key.toLowerCase(),
    value: part.value.toLowerCase(),
    negated: part.negated,
    text: term.slice(part.from, part.to),
  }))
}

/** Whether a facet writes several terms or a negated one (no Only, no Hide). */
export function isCompoundFacet(term: string): boolean {
  return compoundParts(term) !== undefined
}

function holds(present: readonly FilterTerm[], part: FacetPart, negated = part.negated): boolean {
  return present.some((candidate) => same(candidate, part) && candidate.negated === negated)
}

/** Whether `q` holds the facet's term, its negation, or neither. */
export function facetState(q: string, term: string): FacetState {
  const parts = compoundParts(term)
  if (parts) {
    const present = termsOf(q)
    return parts.every((part) => holds(present, part)) ? 'on' : 'off'
  }
  const facet = split(term)
  const found = termsOf(q).filter((candidate) => same(candidate, facet))
  if (found.some((candidate) => !candidate.negated)) return 'on'
  if (found.some((candidate) => candidate.negated)) return 'negated'
  return 'off'
}

/** `q` without the items at these spans; the space around each goes with it, nothing else moves. */
function removeSpans(q: string, spans: readonly { from: number; to: number }[]): string {
  let text = q
  for (const span of [...spans].toSorted((a, b) => b.from - a.from)) {
    const left = text.slice(0, span.from).replace(/\s+$/, '')
    const right = text.slice(span.to).replace(/^\s+/, '')
    text = left && right ? `${left} ${right}` : left || right
  }
  return text
}

function append(q: string, term: string): string {
  const base = q.replace(/\s+$/, '')
  return base ? `${base} ${term}` : term
}

/**
 * Pressing a facet: off → its term is added; on → its term goes; hidden →
 * its negation goes. A compound facet that is on loses all its terms; one
 * that is off gains the terms it lacks, and the terms they contradict go.
 */
export function toggleFacet(q: string, term: string): string {
  const parts = compoundParts(term)
  if (parts) {
    const present = termsOf(q)
    if (parts.every((part) => holds(present, part)))
      return removeSpans(
        q,
        present.filter((candidate) =>
          parts.some((part) => same(candidate, part) && candidate.negated === part.negated),
        ),
      )
    const kept = removeSpans(
      q,
      present.filter((candidate) =>
        parts.some((part) => same(candidate, part) && candidate.negated !== part.negated),
      ),
    )
    return parts
      .filter((part) => !holds(present, part))
      .reduce((text, part) => append(text, part.text), kept)
  }
  const facet = split(term)
  const terms = termsOf(q).filter((candidate) => same(candidate, facet))
  const state = facetState(q, term)
  if (state === 'off') return append(q, term)
  return removeSpans(
    q,
    terms.filter((candidate) => candidate.negated === (state === 'negated')),
  )
}

/** Hide: the facet's positive term goes and its negation is added (once). */
export function hideFacet(q: string, term: string): string {
  const facet = split(term)
  const terms = termsOf(q).filter((candidate) => same(candidate, facet))
  const kept = removeSpans(
    q,
    terms.filter((candidate) => !candidate.negated),
  )
  return terms.some((candidate) => candidate.negated) ? kept : append(kept, `-${term}`)
}

/** Only: every term of the group's keys goes, shown or hidden, and this one is the group's term. */
export function onlyFacet(q: string, term: string, group: readonly Facet[]): string {
  const keys = new Set(group.map((facet) => split(facet.term).key))
  keys.add(split(term).key)
  const gone = termsOf(q).filter((candidate) => keys.has(candidate.key.toLowerCase()))
  return append(removeSpans(q, gone), term)
}

export function FacetList({
  groups,
  value,
  onChange,
  exclusions = true,
  testId = 'facets',
}: {
  groups: readonly FacetGroup[]
  /** The page's `q`. */
  value: string
  onChange: (q: string) => void
  /** Offer Only and Hide on hover (default true). */
  exclusions?: boolean
  testId?: string
}) {
  return (
    <div className="grid content-start gap-4" data-testid={testId}>
      {groups.map((group) => (
        <div key={group.label} className="grid gap-0.5" role="group" aria-label={group.label}>
          <span className="px-2 pb-0.5 text-[11px] text-kumo-subtle">{group.label}</span>
          {group.facets.map((facet) => {
            const state = facetState(value, facet.term)
            const excludable = exclusions && !isCompoundFacet(facet.term)
            return (
              <div
                key={facet.term}
                className="group/facet relative"
                data-testid="facet"
                data-state={state}
              >
                <button
                  type="button"
                  aria-pressed={state === 'on' ? true : state === 'negated' ? 'mixed' : false}
                  onClick={() => onChange(toggleFacet(value, facet.term))}
                  className={cn(
                    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:ink',
                    state === 'on' && 'bg-kumo-tint',
                  )}
                  data-term={facet.term}
                >
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm ring',
                      state === 'on'
                        ? 'bg-kumo-contrast ring-kumo-contrast'
                        : 'bg-kumo-base ring-kumo-hairline',
                    )}
                    aria-hidden
                  >
                    {state === 'on' && (
                      <CheckIcon size={10} weight="bold" className="text-kumo-inverse" />
                    )}
                    {state === 'negated' && <span className="h-px w-2 bg-kumo-subtle" />}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[13px]',
                      state === 'negated' ? 'text-kumo-subtle line-through' : 'text-kumo-default',
                    )}
                  >
                    {facet.label}
                  </span>
                  {facet.count !== undefined && (
                    <span
                      className={cn(
                        'shrink-0 font-mono text-[11px] tabular-nums',
                        excludable &&
                          'group-hover/facet:invisible group-focus-within/facet:invisible',
                        facet.tone === 'danger'
                          ? 'text-kumo-danger'
                          : facet.tone === 'warning'
                            ? 'text-kumo-warning'
                            : 'text-kumo-subtle',
                      )}
                    >
                      {formatNumber(facet.count)}
                    </span>
                  )}
                </button>
                {excludable && (
                  // Over the count, on the row's own ground: the two words
                  // that change the group, where the figure was.
                  <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-focus-within/facet:pointer-events-auto group-focus-within/facet:opacity-100 group-hover/facet:pointer-events-auto group-hover/facet:opacity-100">
                    <FacetAction
                      label="Only"
                      title={`Show only ${facet.label}`}
                      onClick={() => onChange(onlyFacet(value, facet.term, group.facets))}
                    />
                    <FacetAction
                      label="Hide"
                      title={`Hide ${facet.label}`}
                      onClick={() => onChange(hideFacet(value, facet.term))}
                    />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function FacetAction({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="h-5 rounded px-1.5 text-[11px] text-kumo-subtle hover:ink hover:text-kumo-default"
      data-testid={`facet-${label.toLowerCase()}`}
    >
      {label}
    </button>
  )
}
