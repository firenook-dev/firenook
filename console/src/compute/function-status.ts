// A function's status in words — whether it receives anything, and if not,
// which of the ways — as the Extensions Functions tab and Eventarc's
// channels draw it. Quiet while it receives; colour only where it does not.

import type { FunctionStatus } from '@/api/generated/compute/FunctionStatus'
import type { StatusTone } from '@/components/kit'

export const STATUS_WORDS: Readonly<Record<FunctionStatus, { word: string; tone: StatusTone }>> = {
  receiving: { word: 'Receiving', tone: 'success' },
  ignored: { word: 'Not emulated', tone: 'warning' },
  noService: { word: 'No service', tone: 'warning' },
  paused: { word: 'Paused', tone: 'neutral' },
  removed: { word: 'Removed', tone: 'neutral' },
}
