// What a publish did, said once in the composer's problem strip for six
// seconds: the id it got and who it reached, or for a job, that it finished.
// "1 function skipped — background triggers are paused" is a fact of this
// publish, said here with it, not a banner.

import type { PubsubPublishResult } from '@/api/generated/messaging/PubsubPublishResult'
import type { Job } from '@/lib/jobs'
import { formatNumber } from '@/lib/format'

/** How long a result line stays. */
export const RESULT_MS = 6_000

/** "Published 1 · id 1188 → 2 subscriptions, 1 function". */
export function publishedText(result: PubsubPublishResult): string {
  const count = result.messageIds.length
  const ids =
    count === 1
      ? ` · id ${result.messageIds[0] ?? ''}`
      : count > 1
        ? ` · ids ${result.messageIds[0] ?? ''}–${result.messageIds.at(-1) ?? ''}`
        : ''
  const reached = [
    `${formatNumber(result.subscriptions)} ${result.subscriptions === 1 ? 'subscription' : 'subscriptions'}`,
    `${formatNumber(result.functions)} ${result.functions === 1 ? 'function' : 'functions'}`,
  ].join(', ')
  return `Published ${formatNumber(count)}${ids} → ${reached}`
}

/** "1 function skipped — background triggers are paused", when any were. */
export function skippedText(result: PubsubPublishResult): string | undefined {
  if (result.functionsSkipped === 0) return undefined
  return `${formatNumber(result.functionsSkipped)} ${result.functionsSkipped === 1 ? 'function' : 'functions'} skipped — background triggers are paused`
}

/** A publish job's progress beside its Stop button: "12 of 20 · every second". */
export function jobProgressText(job: Pick<Job, 'done' | 'total'>, interval: string): string {
  const of =
    job.total === null
      ? formatNumber(job.done)
      : `${formatNumber(job.done)} of ${formatNumber(job.total)}`
  return interval === 'at once' ? `${of} sent` : `${of} · ${interval}`
}

/** How a finished publish job ended, in a sentence. */
export function jobEndText(
  job: Pick<Job, 'state' | 'done' | 'total' | 'message' | 'errorCount'>,
  topicId: string,
): string {
  const sent = `${formatNumber(job.done)} ${job.done === 1 ? 'message' : 'messages'}`
  if (job.state === 'done')
    return job.errorCount > 0
      ? `Published ${sent} to ${topicId}; ${formatNumber(job.errorCount)} failed`
      : `Published ${sent} to ${topicId}`
  if (job.state === 'cancelled') return `Stopped after ${sent}`
  return `The publish failed after ${sent}${job.message ? `: ${job.message}` : ''}`
}

export function PublishResult({
  text,
  detail,
  tone = 'success',
  onOpen,
  testId = 'pubsub-publish-result',
}: {
  text: string
  /** A second sentence, quieter: the skipped functions. */
  detail?: string | undefined
  tone?: 'success' | 'danger'
  /** Opens the message the publish made (the id in the line). */
  onOpen?: (() => void) | undefined
  testId?: string
}) {
  return (
    <div className="grid gap-0.5 text-[13px]" role="status" data-testid={testId}>
      <span className={tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-default'}>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-sm text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {text}
          </button>
        ) : (
          text
        )}
      </span>
      {detail && <span className="text-[12px] text-kumo-warning">{detail}</span>}
    </div>
  )
}
