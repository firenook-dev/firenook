export type LiveState = 'live' | 'reconnecting' | 'offline'

/**
 * The console's live indicator. "live" means the console channel is
 * connected and the view updates without polling; the counter shows changes
 * since the view opened. Never a spinner for data already on screen.
 * @category Status
 */
export function LiveDot({ state = 'live', changes }: { state?: LiveState; changes?: number }) {
  const label = state === 'live' ? 'live' : state === 'reconnecting' ? 'reconnecting' : 'offline'
  const colour =
    state === 'live'
      ? 'bg-kumo-success'
      : state === 'reconnecting'
        ? 'bg-kumo-warning'
        : 'bg-kumo-danger'
  return (
    <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
      <span className="relative flex size-2">
        {state === 'live' ? (
          <span className={`absolute inline-flex size-full rounded-full ${colour} opacity-60`} />
        ) : null}
        <span className={`relative inline-flex size-2 rounded-full ${colour}`} />
      </span>
      {label}
      {changes ? ` · ${changes} ${changes === 1 ? 'change' : 'changes'}` : ''}
    </span>
  )
}
