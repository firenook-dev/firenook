// The Logs page's server data. Every answer comes from the engine, which
// keeps the log and does the work: pages of lines (before, after or around
// a line), the facets' counts, the volume histogram, one line by cursor and
// the streamed download. Nothing here counts or filters lines.
//
// Pages are fetched by the feed (`feed.ts`), never cached: the feed store
// holds the lines on screen and the `logs.entries` topic extends them, so a
// page in the query cache would be a second copy that only grows stale. The
// facets and the histogram are queries, marked stale by the topic and
// refetched while lines arrive; a line by cursor never changes.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError, parseErrorBody } from '@/api/client'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import type { LogHistogram } from '@/api/generated/observe/LogHistogram'
import type { LogPage } from '@/api/generated/observe/LogPage'

/** The filter and the window every Logs request reads: the URL's `q`, `from` and `to`. */
export interface LogsView {
  q: string
  from?: string | undefined
  to?: string | undefined
}

/** Lines the first page holds: the newest 500 matching. */
export const PAGE_SIZE = 500
/** Lines on each side of a line opened by its cursor (`entry=`). */
export const AROUND_EACH = 100
/** Buckets in the volume strip. */
export const HISTOGRAM_BUCKETS = 60

/** Logs' query keys: the section id, then the project, then what the answer is of. */
export const logsKeys = {
  all: (project: string) => ['logs', project] as const,
  facets: (project: string, view: LogsView) =>
    ['logs', project, 'facets', view.q, view.from ?? '', view.to ?? ''] as const,
  histogram: (project: string, view: LogsView) =>
    ['logs', project, 'histogram', view.q, view.from ?? '', view.to ?? ''] as const,
  entry: (project: string, cursor: string) => ['logs', project, 'entry', cursor] as const,
}

/** The span of the filter text a refusal is about (UTF-16 offsets). */
export interface FilterSpan {
  from: number
  to: number
}

/**
 * A Logs request the engine refused or could not answer. A refused filter
 * (a regex Rust's syntax lacks) carries the span the engine named, which
 * the filter field underlines; the console's shared `ApiError` keeps only
 * the code, the message and the fix.
 */
export class LogsRequestError extends ApiError {
  readonly span: FilterSpan | undefined

  constructor(
    status: number,
    message: string,
    code: ApiError['code'],
    fix: string | undefined,
    span: FilterSpan | undefined,
  ) {
    super(status, message, code, fix)
    this.name = 'LogsRequestError'
    this.span = span
  }
}

function spanOf(body: unknown): FilterSpan | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const span = (body as { span?: unknown }).span
  if (typeof span !== 'object' || span === null) return undefined
  const { from, to } = span as { from?: unknown; to?: unknown }
  return typeof from === 'number' && typeof to === 'number' ? { from, to } : undefined
}

/** The query string of a view and whatever else a request adds; empty values are left out. */
export function logsSearch(
  view: LogsView,
  extra: Record<string, string | number | undefined> = {},
): URLSearchParams {
  const search = new URLSearchParams()
  const entries: [string, string | number | undefined][] = [
    ['q', view.q.trim() === '' ? undefined : view.q],
    ['from', view.from],
    ['to', view.to],
    ...Object.entries(extra),
  ]
  for (const [key, value] of entries)
    if (value !== undefined && value !== '') search.set(key, String(value))
  return search
}

async function logsGet<T>(path: string, search: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const query = search.size > 0 ? `?${search}` : ''
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}${query}`, {
      signal: signal ?? null,
      headers: { accept: 'application/json', 'x-firenook-console': '1' },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new LogsRequestError(
      0,
      `The engine did not answer: ${reason}`,
      'network',
      undefined,
      undefined,
    )
  }
  if (response.ok) return (await response.json()) as T
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  const fallback = `${response.status} ${response.statusText}`.trim()
  const parsed = parseErrorBody(response.status, body, fallback)
  throw new LogsRequestError(response.status, parsed.message, parsed.code, parsed.fix, spanOf(body))
}

/** Where a page of lines is read from: the newest (before a line, or the end), after a line, or around one. */
export type PagePosition = { before?: string | undefined } | { after: string } | { around: string }

/** `GET /logs/entries`: a page of matching lines, oldest first, with where to go on. */
export function fetchLogPage(
  view: LogsView,
  position: PagePosition,
  signal?: AbortSignal,
  limit = PAGE_SIZE,
): Promise<LogPage> {
  const extra: Record<string, string | number | undefined> =
    'around' in position
      ? { around: position.around, each: AROUND_EACH }
      : 'after' in position
        ? { after: position.after, limit }
        : { before: position.before, limit }
  return logsGet<LogPage>('/logs/entries', logsSearch(view, extra), signal)
}

/** `GET /logs/facets`: how many lines carry each value, and how many match (never counted here). */
export const facetsQuery = (project: string, view: LogsView) =>
  queryOptions({
    queryKey: logsKeys.facets(project, view),
    queryFn: ({ signal }) => logsGet<LogFacets>('/logs/facets', logsSearch(view), signal),
    // Kept current by the feed: marked stale as lines arrive (`useLogCounts`).
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failures, error) =>
      failures < 1 && !(error instanceof ApiError && error.code === 'invalid-argument'),
  })

/** `GET /logs/histogram`: the volume strip's buckets, by level. */
export const histogramQuery = (project: string, view: LogsView) =>
  queryOptions({
    queryKey: logsKeys.histogram(project, view),
    queryFn: ({ signal }) =>
      logsGet<LogHistogram>(
        '/logs/histogram',
        logsSearch(view, { buckets: HISTOGRAM_BUCKETS }),
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failures, error) =>
      failures < 1 && !(error instanceof ApiError && error.code === 'invalid-argument'),
  })

/** `GET /logs/entries/{cursor}`: one line; a kept line never changes, and a gone one stays gone. */
export const entryQuery = (project: string, cursor: string) =>
  queryOptions({
    queryKey: logsKeys.entry(project, cursor),
    queryFn: ({ signal }) =>
      logsGet<LogEntry>(
        `/logs/entries/${encodeURIComponent(cursor)}`,
        new URLSearchParams(),
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** Where the engine streams the lines a view matches as a file: NDJSON or text. */
export function exportUrl(view: LogsView, format: 'ndjson' | 'text'): string {
  return `${API_BASE}/logs/entries:export?${logsSearch(view, { format })}`
}
