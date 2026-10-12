// How an instance is named and described everywhere the section draws it:
// its title, where its source came from, whether it starts offline, its
// state. One set of words, so the panel, the overview and the toolbar never
// disagree.

import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import type { ExtensionOrigin } from '@/api/generated/compute/ExtensionOrigin'
import type { StatusTone } from '@/components/kit'

/** Where the source came from, in words. */
export const ORIGIN_WORDS: Readonly<Record<ExtensionOrigin, string>> = {
  local: 'local',
  vendored: 'vendored',
  cache: 'shared cache',
  downloaded: 'downloaded',
}

/** What each origin means, for its tooltip. */
export const ORIGIN_HELP: Readonly<Record<ExtensionOrigin, string>> = {
  local: 'A local extension: its source is a directory in this project.',
  vendored: 'Copied into extensions/.sources, so it starts without the network.',
  cache: 'From the shared cache of downloaded extensions on this machine.',
  downloaded: 'Downloaded from the Extensions registry when the suite started.',
}

/** The instance's name: its display name, else the extension's name, else its id. */
export function instanceTitle(summary: ExtensionInstanceSummary): string {
  return summary.displayName ?? summary.name ?? summary.instanceId
}

/** The origin's word, or `unknown` while the instance has not loaded. */
export function originWord(summary: ExtensionInstanceSummary): string {
  return summary.origin ? ORIGIN_WORDS[summary.origin] : 'not loaded'
}

/** Whether it starts on a machine with no network, and the sentence behind the word. */
export function readiness(summary: ExtensionInstanceSummary): {
  word: string
  tone: StatusTone
  note: string
} {
  if (summary.offlineReady)
    return {
      word: 'Offline-ready',
      tone: 'success',
      note:
        summary.readinessNote ??
        (summary.kind === 'local'
          ? 'Its source is in this project, so it starts without the network.'
          : 'Its source is on this machine, so it starts without the network.'),
    }
  return {
    word: 'Needs network',
    tone: 'warning',
    note:
      summary.readinessNote ??
      'On a clean machine its source has to be downloaded first. Vendor it to keep a copy in the project.',
  }
}

/** The instance's state as a word and a tone: nothing to say while it runs. */
export function stateChip(
  summary: ExtensionInstanceSummary,
): { word: string; tone: StatusTone } | undefined {
  if (summary.state === 'loading') return { word: 'Loading', tone: 'neutral' }
  if (summary.state === 'failed') return { word: 'Did not load', tone: 'danger' }
  return undefined
}

/** `0.1.0`, `firebase/storage-resize-images@0.2.8`, or nothing known. */
export function versionText(summary: ExtensionInstanceSummary): string {
  return summary.version ?? '–'
}

/** The functions figure: `3`, `3 · 1 not emulated`. */
export function functionsText(summary: ExtensionInstanceSummary): string {
  if (summary.ignoredFunctionCount === 0) return String(summary.functionCount)
  return `${summary.functionCount} · ${summary.ignoredFunctionCount} not emulated`
}
