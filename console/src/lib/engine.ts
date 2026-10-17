// How the console names the engine it is talking to.
//
// The engine's crate version is a placeholder: Firenook is released as an
// npm package whose version the packaging checkout decides, while the binary
// is built from the pinned engine commit. The launcher passes the release in,
// so a binary started any other way has none — and says so rather than
// showing a number that means nothing.

import type { EngineInfo } from '@/api/generated/EngineInfo'

/** What the badge and the overview call this engine's version. */
export function engineVersion(engine: EngineInfo | undefined): string {
  if (!engine) return '…'
  return engine.version ?? 'unreleased build'
}

/** The engine source commit, short, for the detail beside the version. */
export function engineBuild(engine: EngineInfo | undefined): string | undefined {
  if (!engine?.revision) return undefined
  return `${engine.name} ${engineVersion(engine)}, engine source ${engine.revision.slice(0, 12)}`
}

/**
 * The version as the sidebar's foot writes it: `v0.2.0-next.2`. A local
 * build's commit suffix (`0.2.0-local.gfd8c2e181cf7`, as `git describe`
 * writes it) is left to the tooltip beside it; a build with no release
 * says so in words.
 */
export function engineVersionShort(engine: EngineInfo | undefined): string {
  const version = engineVersion(engine)
  if (!/^\d/.test(version)) return version
  return `v${version.replace(/\.g[0-9a-f]{7,40}$/, '')}`
}
