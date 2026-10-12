// Two lines under the function's toolbar: how it is reached and what it
// has done. Line one is the URL as apps reach it (the Functions service's
// advertised address, never the console's own origin) for kinds that
// answer on one, or the trigger in a sentence for the rest, then the
// options the emulator applies. Line two counts once: runs, failures,
// p50, p95 and the last run, over what the engine keeps.

import { Tooltip } from '@cloudflare/kumo'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import { CopyField } from '@/components/console/copy-button'
import { RelativeTime } from '@/components/console/relative-time'
import { formatDuration, formatNumber } from '@/lib/format'
import { sentenceParts, triggerSentence } from '../trigger-text'

/** A sentence with its code in the data face. */
export function Sentence({ text, testId }: { text: string; testId?: string }) {
  return (
    <span className="min-w-0" data-testid={testId}>
      {sentenceParts(text).map((part, index) =>
        part.code ? (
          // The parts of one sentence never reorder: their index is their identity.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className="font-mono text-[12px] text-kumo-default">
            {part.text}
          </span>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  )
}

/** "who may call it": the invoker list in words. */
function invokerText(invoker: readonly string[]): string | undefined {
  if (invoker.length === 0) return undefined
  if (invoker.includes('public')) return 'public'
  if (invoker.includes('private')) return 'private'
  return `invoker ${invoker.join(', ')}`
}

export function SummaryStrip({
  summary,
  url,
}: {
  summary: FunctionSummary
  /** The URL as apps reach it, for kinds that answer on one. */
  url: string | undefined
}) {
  const options = [
    `timeout ${formatDuration(summary.timeoutSeconds * 1000)}`,
    `codebase ${summary.codebase}`,
    invokerText(summary.trigger.invoker),
  ].filter(Boolean)
  const stats = summary.stats
  return (
    <div
      className="grid shrink-0 gap-1 border-b border-kumo-line px-3 py-2 text-[12px] text-kumo-subtle"
      data-testid="function-summary"
    >
      <div className="flex min-w-0 items-center gap-2">
        {url ? (
          <>
            <CopyField value={url} className="min-w-0 truncate text-[12px]" testId="function-url">
              {url}
            </CopyField>
            <Tooltip
              content="The Functions service at the address the suite gives your app, not the console's own."
              render={
                <span className="shrink-0 cursor-default text-[11px]">as your app reaches it</span>
              }
            />
          </>
        ) : (
          <Sentence text={triggerSentence(summary)} testId="function-sentence" />
        )}
        <span className="ml-auto shrink-0 truncate pl-3">{options.join(' · ')}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" data-testid="function-stats">
        <Figure value={stats.runs} />
        <span>{stats.runs === 1 ? 'run' : 'runs'}</span>
        <span aria-hidden>·</span>
        {stats.failures > 0 ? (
          <span className="text-kumo-danger">
            <Figure value={stats.failures} danger /> failed
          </span>
        ) : (
          <span>none failed</span>
        )}
        {stats.inFlight > 0 && (
          <>
            <span aria-hidden>·</span>
            <Figure value={stats.inFlight} />
            <span>running</span>
          </>
        )}
        {stats.p50Ms !== null && (
          <>
            <span aria-hidden>·</span>
            <span>p50</span>
            <span className="font-mono text-[11px] text-kumo-default tabular-nums">
              {formatDuration(stats.p50Ms)}
            </span>
          </>
        )}
        {stats.p95Ms !== null && (
          <>
            <span aria-hidden>·</span>
            <span>p95</span>
            <span className="font-mono text-[11px] text-kumo-default tabular-nums">
              {formatDuration(stats.p95Ms)}
            </span>
          </>
        )}
        {stats.last && (
          <>
            <span aria-hidden>·</span>
            <span>last</span>
            <RelativeTime iso={stats.last.startedAt} className="text-kumo-default" />
          </>
        )}
      </div>
    </div>
  )
}

function Figure({ value, danger = false }: { value: number; danger?: boolean }) {
  return (
    <span
      className={`font-mono text-[11px] tabular-nums ${danger ? 'text-kumo-danger' : 'text-kumo-default'}`}
    >
      {formatNumber(value)}
    </span>
  )
}
