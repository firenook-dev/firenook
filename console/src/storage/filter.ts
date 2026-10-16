// Storage's filter fields, in the foundation's one grammar: bare words match
// the name below the folder, and `type:image/*`, `size:>5MB`,
// `updated:>-1h`, `created:<2026-10-01`, `meta.ownerUid:u_9f3k2` (the key
// after `meta.` keeps its case), `has:token`, `-has:type`. The engine
// validates and evaluates the same specs (`filter_fields.rs`); both sides
// are held to `filter-cases.json` (`filter.test.ts` runs it here, the
// crate's test there), so a filter the field accepts is one the engine
// answers.
//
// `ListMeta.fields` from `GET /storage/objects/meta` is the same list; this
// copy draws the field before that answer arrives, and the completions add
// what the folder in view holds — its content types and custom keys.

import type { FieldSpecInfo } from '@/api/generated/FieldSpecInfo'
import type { StorageProfile } from '@/api/generated/storage/StorageProfile'
import type { FilterFieldSpec } from '@/components/console/filter-field'

/** The fields, as the engine declares them. */
export const STORAGE_FILTER_FIELDS: readonly FilterFieldSpec[] = [
  { key: 'name', kind: 'text', help: 'Name below the folder' },
  {
    key: 'type',
    aliases: ['contenttype'],
    kind: 'exact',
    help: 'Content type, like type:image/*',
  },
  { key: 'size', kind: 'bytes', help: 'Size, like size:>5MB' },
  { key: 'updated', kind: 'time', help: 'Last changed, like updated:>-1h' },
  { key: 'created', kind: 'time', help: 'Created, like created:<2026-10-01' },
  {
    key: 'meta',
    kind: 'path',
    help: 'Custom metadata, like meta.ownerUid:u_9f3k2',
    prefixes: ['meta.'],
  },
  {
    key: 'has',
    kind: 'enum',
    help: 'Has a field: has:token, -has:type',
    values: ['token', 'type', 'metadata', 'encoding', 'cache'],
  },
]

/** The placeholder, which teaches the grammar by example. */
export const FILTER_PLACEHOLDER = 'Filter — type:image/* size:>5MB updated:>-1h avatar'

/**
 * The fields the filter field offers: the engine's (or the built-in copy
 * until they arrive), with the folder's content types after `type:` and its
 * custom metadata keys after `meta.`.
 */
export function filterFields(
  served: readonly FieldSpecInfo[] | undefined,
  profile: StorageProfile | undefined,
): FilterFieldSpec[] {
  const base: readonly FilterFieldSpec[] = served ?? STORAGE_FILTER_FIELDS
  const suggestions: Readonly<Record<string, FilterFieldSpec['suggest']>> = {
    type: (prefix: string) => typeSuggestions(profile, prefix),
    meta: (prefix: string) =>
      (profile?.metadataKeys ?? []).filter((key) =>
        key.toLowerCase().startsWith(prefix.toLowerCase()),
      ),
  }
  return base.map((field) => withSuggest(field, suggestions[field.key]))
}

function withSuggest(field: FilterFieldSpec, suggest: FilterFieldSpec['suggest']): FilterFieldSpec {
  return suggest ? { ...field, suggest } : field
}

/** `image/*` before the exact types when a family holds more than one, then the types by count. */
export function typeSuggestions(profile: StorageProfile | undefined, prefix: string): string[] {
  const types = profile?.contentTypes.map((entry) => entry.contentType) ?? []
  const families = new Map<string, number>()
  for (const type of types) {
    const family = type.split('/')[0]
    if (family) families.set(family, (families.get(family) ?? 0) + 1)
  }
  const wild = [...families].filter(([, count]) => count > 1).map(([family]) => `${family}/*`)
  const lower = prefix.toLowerCase()
  return [...wild, ...types].filter((value) => value.toLowerCase().startsWith(lower))
}
