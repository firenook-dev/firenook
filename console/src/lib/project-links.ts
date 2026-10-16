// Where Firenook lives outside the console: its documentation, its
// releases and its issue tracker, as the top bar's help menu offers them.
// A released engine's notes are its own release's page (the release
// workflow tags `npm-v<version>`); any other build gets the list.

import type { EngineInfo } from '@/api/generated/EngineInfo'
import { engineVersion } from './engine'

export const REPOSITORY_URL = 'https://github.com/firenook-dev/firenook'

export const DOCUMENTATION_URL = `${REPOSITORY_URL}#readme`

/** A version npm publishes: `0.2.0`, `0.2.0-next.2`; not a local build's. */
const PUBLISHED = /^\d+\.\d+\.\d+(-next\.\d+)?$/

export function releaseNotesUrl(engine: EngineInfo | undefined): string {
  const version = engine?.version
  return version && PUBLISHED.test(version)
    ? `${REPOSITORY_URL}/releases/tag/npm-v${version}`
    : `${REPOSITORY_URL}/releases`
}

/** A new issue, with the engine's version and source commit already in it. */
export function newIssueUrl(engine: EngineInfo | undefined): string {
  const build = [
    `Firenook ${engineVersion(engine)}`,
    engine?.revision ? `engine source ${engine.revision.slice(0, 12)}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')
  const body = ['**What happened**', '', '', '**What you expected**', '', '', `---\n${build}`].join(
    '\n',
  )
  return `${REPOSITORY_URL}/issues/new?${new URLSearchParams({ body })}`
}
