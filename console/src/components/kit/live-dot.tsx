export type LiveState = 'live' | 'reconnecting' | 'offline'

/**
 * The console's live indicator. "live" means the console channel is
 * connected and the view updates without polling; the counter shows changes
 * since the view opened. Never a spinner for data already on screen.
 * @category Status
 */
export function LiveDot({
  state = 'live',
  changes,
  compact = false,
}: {
  state?: LiveState
  changes?: number
  /** Dot and counter only: a crowded toolbar can spare the word, not the state. */
  compact?: boolean
}) {
  const label = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Offline'
  const colour =
    state === 'live'
      ? 'bg-kumo-success'
      : state === 'reconnecting'
        ? 'bg-kumo-warning'
        : 'bg-kumo-danger'
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
      <span className="relative flex size-2">
        {state === 'live' ? (
          <span className={`absolute inline-flex size-full rounded-full ${colour} opacity-60`} />
        ) : null}
        <span className={`relative inline-flex size-2 rounded-full ${colour}`} />
      </span>
      <span className={compact ? 'sr-only' : undefined}>{label}</span>
      {changes ? ` ${compact ? '' : '· '}${changes} ${changes === 1 ? 'change' : 'changes'}` : ''}
    </span>
  )
}
