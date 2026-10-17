// What the top bar says about the live channel: nothing while it is live,
// and its trouble when it has any (`liveTrouble`), drawn as a chip shaped
// like the bar's other controls (`LIVE_BADGE`, `LiveBadgeFace`). The shell
// wires it to the channel and makes it a link (`EngineBadge`); the design
// system draws each state from here.

import { StatusDot } from '@/components/kit'
import type { useLiveStatus } from '@/lib/live/channel'

type LiveState = ReturnType<typeof useLiveStatus.getState>['status']

/** The chip's box: the height, corners and ring of the search field beside it. */
export const LIVE_BADGE =
  'flex h-8 shrink-0 items-center rounded-lg bg-kumo-base px-2.5 ring ring-kumo-line'

/** What the live channel has to say, when it is not simply live. */
export interface LiveTrouble {
  tone: 'warning' | 'danger' | 'neutral'
  label: string
  why: string
  pulse?: boolean
}

export function liveTrouble(
  live: LiveState,
  updated: boolean,
  unreachable: boolean,
): LiveTrouble | undefined {
  if (updated)
    return {
      tone: 'neutral',
      label: 'Engine updated',
      why: 'The engine was updated. Reload to get its console.',
    }
  if (live === 'reconnecting')
    return {
      tone: 'warning',
      label: 'Reconnecting',
      why: 'Live updates are reconnecting, so what is on screen may be out of date.',
      pulse: true,
    }
  if (live === 'offline')
    return {
      tone: 'danger',
      label: 'Engine stopped',
      why: 'The engine stopped. The console reconnects by itself when it is back.',
    }
  if (live === 'too-many')
    return {
      tone: 'warning',
      label: 'Too many console tabs',
      why: 'This engine already serves 64 console connections. Close a console tab.',
    }
  if (unreachable && live === 'connecting')
    return {
      tone: 'danger',
      label: 'Engine unreachable',
      why: 'The console could not reach the engine.',
    }
  return undefined
}

/** The chip's face: the trouble's dot and word. */
export function LiveBadgeFace({ trouble }: { trouble: LiveTrouble }) {
  return (
    <StatusDot
      tone={trouble.tone}
      label={trouble.label}
      pulse={trouble.pulse ?? false}
      className="text-[13px]"
    />
  )
}
