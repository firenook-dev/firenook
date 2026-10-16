// The Access column while the page acts as a client: what this identity may
// do with each file — `read · delete` in quiet text when allowed, a lock and
// `no read` when refused — with the deciding line in the tooltip. From a
// dry run, so nothing is recorded among the decisions.

import { Tooltip } from '@cloudflare/kumo'
import { LockSimpleIcon } from '@phosphor-icons/react'
import type { StorageAccessVerdict } from '@/api/generated/storage/StorageAccessVerdict'

export function AccessCell({
  verdicts,
  lineText,
}: {
  /** The file's verdicts from the access check; `undefined` while it is asked. */
  verdicts: readonly StorageAccessVerdict[] | undefined
  /** The rules' text of a line, for the tooltip. */
  lineText: (line: number) => string | undefined
}) {
  const read = verdicts?.find((verdict) => verdict.method === 'get')
  const remove = verdicts?.find((verdict) => verdict.method === 'delete')
  if (!read || !remove) return <span className="text-[11px] text-kumo-inactive">…</span>
  const allowed = [read.outcome === 'allow' && 'read', remove.outcome === 'allow' && 'delete']
    .filter(Boolean)
    .join(' · ')
  const refused = read.outcome !== 'allow'
  const decider = refused ? read : remove.outcome !== 'allow' ? remove : read
  const text = decider.line === null ? undefined : lineText(decider.line)
  const tip = (
    <span className="grid max-w-96 gap-1 text-[12px]">
      {decider.line === null ? (
        <span>No allow matched, so the rules refused by default.</span>
      ) : (
        <span>
          Line {decider.line}
          {text ? (
            <>
              : <span className="font-mono text-[11px]">{text}</span>
            </>
          ) : null}
        </span>
      )}
      <span className="text-kumo-subtle">From a dry run: nothing was recorded.</span>
    </span>
  )
  return (
    <Tooltip
      content={tip}
      render={
        <span
          className="flex min-w-0 cursor-default items-center gap-1 text-[11px]"
          data-testid="access-cell"
          data-read={read.outcome}
        >
          {refused ? (
            <>
              <LockSimpleIcon size={12} className="shrink-0 text-kumo-danger" aria-hidden />
              <span className="truncate text-kumo-default">
                no read{read.line !== null ? ` (line ${read.line})` : ''}
              </span>
            </>
          ) : (
            <span className="truncate text-kumo-subtle">{allowed || 'no access'}</span>
          )}
        </span>
      }
    />
  )
}
