// The Logs filter's fields: the engine's `LOG_FIELDS`
// (`crates/console-front/src/observe/fields.rs`) written again for the
// filter field, so a filter the browser accepts is one the engine accepts
// and both say the same thing about one it does not. `filter-cases.json`
// holds both to it: the engine runs the cases against its fields, Vitest
// runs them against these and checks these are the file's own.
//
// Completion adds what the engine has counted: the functions, extension
// instances and codebases in the facets the page already holds, and every
// kind the engine writes. Nothing is asked for to complete a value.

import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { LOG_KINDS } from '@/api/generated/observe/logKinds'
import type { FilterFieldSpec } from '@/components/console/filter-field'
import { asciiLower } from '@/lib/filter'

/** The fields as the engine declares them, in its order. */
export const LOG_FIELDS: readonly FilterFieldSpec[] = [
  {
    key: 'level',
    aliases: ['severity'],
    kind: 'enum',
    help: 'How serious the line is',
    values: ['debug', 'info', 'warn', 'error'],
  },
  {
    key: 'service',
    aliases: ['emulator'],
    kind: 'enum',
    help: 'The emulator that wrote it',
    values: ['hub', 'firestore', 'auth', 'storage', 'functions', 'pubsub', 'eventarc', 'tasks'],
  },
  {
    key: 'function',
    aliases: ['fn'],
    kind: 'exact',
    help: 'Functions trigger id; end with * for a prefix',
  },
  { key: 'instance', aliases: ['ext', 'extension'], kind: 'exact', help: 'Extension instance' },
  { key: 'codebase', kind: 'exact', help: 'Functions codebase' },
  { key: 'execution', aliases: ['exec'], kind: 'exact', help: 'One function invocation' },
  {
    key: 'kind',
    kind: 'exact',
    help: 'What happened, like function.failed; end with * for a prefix',
  },
  {
    key: 'is',
    kind: 'enum',
    help: 'Problems, engine internals or markers',
    values: ['problem', 'internal', 'marker'],
  },
  {
    key: 'payload',
    kind: 'path',
    help: 'A field of the structured payload; * for any value',
    prefixes: ['payload.'],
  },
]

/** Values that start with what is typed, most lines first (the facets' order), at most 50. */
function starting(values: readonly string[], prefix: string): string[] {
  const typed = asciiLower(prefix)
  return values.filter((value) => asciiLower(value).startsWith(typed)).slice(0, 50)
}

/** The values a facet counted, "Other" (past the engine's 4,096 labels) left out. */
function counted(counts: LogFacets['functions'] | undefined): string[] {
  return (counts ?? []).map((count) => count.value).filter((value) => value !== 'Other')
}

/**
 * The fields with completion from what the engine counted: functions,
 * instances and codebases from the facets on screen, kinds from the
 * engine's list (the facets' first, so the kinds in the log lead).
 */
export function logFields(facets: LogFacets | undefined): readonly FilterFieldSpec[] {
  const suggested: Record<string, (prefix: string) => readonly string[]> = {
    function: (prefix) => starting(counted(facets?.functions), prefix),
    instance: (prefix) => starting(counted(facets?.instances), prefix),
    codebase: (prefix) => starting(counted(facets?.codebases), prefix),
    kind: (prefix) => {
      const seen = counted(facets?.kinds)
      const kinds = LOG_KINDS.map((info) => info.kind).filter((kind) => !seen.includes(kind))
      return starting([...seen, ...kinds], prefix)
    },
  }
  return LOG_FIELDS.map((field) => {
    const suggest = suggested[field.key]
    return suggest ? Object.assign({}, field, { suggest }) : field
  })
}

/** The placeholder: one example of each kind of item, as the spec writes it. */
export const LOGS_PLACEHOLDER =
  'Filter: words, -exclude, level:warn, function:hello, payload.orderId:"o_1", /regex/i'
