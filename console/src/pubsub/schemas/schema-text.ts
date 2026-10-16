// A schema's text as the Schemas page handles it: a definition shown
// indented whatever way it was stored (the engine keeps it as written, often
// on one line), two definitions compared by what they say rather than by
// their spaces, the parser's reason placed in the text where it can be,
// and the templates a new schema starts from.

import type { CodeMark } from '@/components/code-editor'
import type { PubsubSchemaCheck } from '@/api/generated/messaging/PubsubSchemaCheck'

/** A definition indented two spaces when it is JSON; as it is otherwise. */
export function prettyDefinition(definition: string): string {
  try {
    return JSON.stringify(JSON.parse(definition), null, 2)
  } catch {
    return definition
  }
}

/** A definition with its spaces taken out, for comparing; the text itself when it is not JSON. */
export function normalDefinition(definition: string): string {
  try {
    return JSON.stringify(JSON.parse(definition))
  } catch {
    return definition.trim()
  }
}

/** Whether two definitions say the same thing (spaces and line breaks aside). */
export function sameDefinition(a: string, b: string): boolean {
  return normalDefinition(a) === normalDefinition(b)
}

/** The offset of a one-based line and column in `text`. */
export function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let index = 0; index < line - 1 && index < lines.length; index += 1)
    offset += (lines[index]?.length ?? 0) + 1
  return Math.min(offset + Math.max(0, column - 1), text.length)
}

/**
 * Where the parser's reason points in the text: its line and column when
 * it has them (JSON syntax), else the quoted name it ends with ("Unknown
 * primitive type: strin" → the first `"strin"`), else nowhere.
 */
export function checkMarks(text: string, check: PubsubSchemaCheck | undefined): CodeMark[] {
  if (!check || check.ok) return []
  const message = check.reason ?? check.engineMessage ?? 'The definition does not parse.'
  if (check.line !== null) {
    const from = offsetAt(text, check.line, check.column ?? 1)
    return [{ from, to: Math.min(text.length, from + 1), severity: 'error', message }]
  }
  const named = /:\s*"?([\w.$-]+)"?\s*$/.exec(message)?.[1]
  if (named) {
    const at = text.indexOf(`"${named}"`)
    if (at !== -1) return [{ from: at, to: at + named.length + 2, severity: 'error', message }]
  }
  return []
}

/** The one line under the editor: what the parser says, or that it parses. */
export function checkLine(check: PubsubSchemaCheck | undefined): string | undefined {
  if (!check) return undefined
  if (check.ok) return undefined
  const where = check.line !== null ? ` (line ${check.line}, column ${check.column ?? 1})` : ''
  return `${check.reason ?? check.engineMessage ?? 'The definition does not parse.'}${where}`
}

export interface SchemaTemplate {
  id: 'record' | 'enum' | 'union' | 'nested'
  label: string
  definition: string
}

/** What a new schema starts from: the shapes a message most often takes. */
export const SCHEMA_TEMPLATES: readonly SchemaTemplate[] = [
  {
    id: 'record',
    label: 'Record',
    definition: prettyDefinition(
      JSON.stringify({
        type: 'record',
        name: 'OrderEvent',
        fields: [
          { name: 'orderId', type: 'string' },
          { name: 'amount', type: 'double' },
        ],
      }),
    ),
  },
  {
    id: 'enum',
    label: 'Record with an enum',
    definition: prettyDefinition(
      JSON.stringify({
        type: 'record',
        name: 'StatusChanged',
        fields: [
          { name: 'orderId', type: 'string' },
          {
            name: 'status',
            type: { type: 'enum', name: 'Status', symbols: ['PLACED', 'PAID', 'SHIPPED'] },
          },
        ],
      }),
    ),
  },
  {
    id: 'union',
    label: 'Optional field (union with null)',
    definition: prettyDefinition(
      JSON.stringify({
        type: 'record',
        name: 'OrderNote',
        fields: [
          { name: 'orderId', type: 'string' },
          { name: 'note', type: ['null', 'string'], default: null },
        ],
      }),
    ),
  },
  {
    id: 'nested',
    label: 'Nested record and array',
    definition: prettyDefinition(
      JSON.stringify({
        type: 'record',
        name: 'Order',
        fields: [
          { name: 'orderId', type: 'string' },
          {
            name: 'customer',
            type: {
              type: 'record',
              name: 'Customer',
              fields: [
                { name: 'id', type: 'string' },
                { name: 'email', type: 'string' },
              ],
            },
          },
          { name: 'items', type: { type: 'array', items: 'string' } },
        ],
      }),
    ),
  },
]

/** "1a2b3c4d" → "1a2b3c4d"; a revision id as it is shown (the engine's are eight hex digits). */
export function revisionLabel(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}
