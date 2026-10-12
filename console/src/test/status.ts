// A whole `ConsoleStatus` for unit tests, with every field a real engine
// sends, so a test states only what it is about.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { SectionStatus } from '@/api/generated/SectionStatus'

/** A section's status: ready unless told otherwise. */
export function sectionEntry(
  id: string,
  overrides: Partial<Omit<SectionStatus, 'id'>> = {},
): SectionStatus {
  return { id, state: 'ready', reason: null, detail: null, fixes: [], summary: null, ...overrides }
}

export function testStatus(overrides: Partial<ConsoleStatus> = {}): ConsoleStatus {
  return {
    projectId: 'demo-console',
    engine: { name: 'Firenook', version: null, revision: null, consoleBuild: 'test' },
    services: [],
    instance: 'instance-1',
    startedAt: '2026-01-01T00:00:00Z',
    sections: [],
    features: { diagnostics: true },
    unsupported: [],
    backgroundTriggers: { enabled: true, since: null, dropped: [] },
    data: {
      mode: 'memory',
      stateDir: null,
      resumed: false,
      importedFrom: null,
      exportOnExit: null,
      durability: 'write-behind',
    },
    foreignProjects: [],
    ...overrides,
  }
}
