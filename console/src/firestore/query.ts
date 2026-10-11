// The workbench query: the same clauses an app writes, kept as data, printed
// as the SDK chain developers already know, parsed back from it, and encoded
// as the REST StructuredQuery the engine runs.

import { quoteFieldSegment } from './rest'
import {
  type FirestoreValueType,
  type FsValue,
  type RestValue,
  decodeFields,
  encodeValue,
} from './value'

export const OPERATORS = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'array-contains',
  'in',
  'not-in',
  'array-contains-any',
] as const
export type Operator = (typeof OPERATORS)[number]

/**
 * The fields a query leaves out every document *without*, where that is
 * not what a reader of the query would expect.
 *
 * Firestore returns only documents that have every field the query sorts
 * by, and only documents that have the field a `!=` or `not-in` compares —
 * so `orderBy("referredBy")` on a collection where a quarter of the
 * documents have it shows a quarter of the collection, and says nothing.
 * Measured: 250 documents of 1,000, and a grid that looked complete. An
 * equality or a range on a field leaves out the same documents, but there
 * nobody expected them back.
 */
export function presenceFields(query: WorkbenchQuery): string[] {
  const fields = new Set<string>()
  for (const order of query.orderBy) if (order.field !== '__name__') fields.add(order.field)
  for (const clause of query.where)
    if (clause.op === '!=' || clause.op === 'not-in') fields.add(clause.field)
  return [...fields]
}

export interface WhereClause {
  field: string
  op: Operator
  value: FsValue
}

export interface OrderClause {
  field: string
  direction: 'asc' | 'desc'
}

export interface WorkbenchQuery {
  where: WhereClause[]
  orderBy: OrderClause[]
  limit: number
}

export const DEFAULT_LIMIT = 100

export const EMPTY_QUERY: WorkbenchQuery = { where: [], orderBy: [], limit: DEFAULT_LIMIT }

export function isEmptyQuery(query: WorkbenchQuery): boolean {
  return query.where.length === 0 && query.orderBy.length === 0 && query.limit === DEFAULT_LIMIT
}

// ---------------------------------------------------------------------------
// Text form: `where("status", "==", "paid").orderBy("createdAt", "desc").limit(50)`

export function printQuery(query: WorkbenchQuery): string {
  const parts: string[] = []
  for (const clause of query.where)
    parts.push(
      `where(${JSON.stringify(clause.field)}, ${JSON.stringify(clause.op)}, ${printLiteral(clause.value)})`,
    )
  for (const order of query.orderBy)
    parts.push(
      order.direction === 'desc'
        ? `orderBy(${JSON.stringify(order.field)}, "desc")`
        : `orderBy(${JSON.stringify(order.field)})`,
    )
  if (query.limit !== DEFAULT_LIMIT) parts.push(`limit(${query.limit})`)
  return parts.join('.')
}

export function printLiteral(value: FsValue): string {
  switch (value.type) {
    case 'string':
      return JSON.stringify(value.value)
    case 'number':
      return String(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'null':
      return 'null'
    case 'timestamp':
      return `Timestamp(${JSON.stringify(value.value)})`
    case 'reference':
      return `doc(${JSON.stringify(value.path)})`
    case 'geopoint':
      return `GeoPoint(${value.latitude}, ${value.longitude})`
    case 'array':
      return `[${value.items.map(printLiteral).join(', ')}]`
    case 'map':
      return JSON.stringify(
        Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, printLiteral(v)])),
      )
    case 'bytes':
      return `Bytes(${JSON.stringify(value.base64)})`
    case 'vector':
      return `Vector(${JSON.stringify(value.values)})`
  }
}

export class QueryParseError extends Error {
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.name = 'QueryParseError'
    this.position = position
  }
}

type Token =
  | { kind: 'ident'; text: string; at: number }
  | { kind: 'string'; text: string; at: number }
  | { kind: 'number'; value: number; at: number }
  | { kind: 'punct'; text: string; at: number }
  | { kind: 'end'; at: number }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ''
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      let text = ''
      index += 1
      const start = index
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          index += 1
          const escaped = source[index]
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : (escaped ?? '')
        } else text += source[index]
        index += 1
      }
      if (source[index] !== quote) throw new QueryParseError('Unterminated string', start - 1)
      index += 1
      tokens.push({ kind: 'string', text, at: start - 1 })
      continue
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index
      index += 1
      while (index < source.length && /[0-9._eE+-]/.test(source[index] ?? '')) index += 1
      const raw = source.slice(start, index)
      const value = Number(raw)
      if (Number.isNaN(value)) throw new QueryParseError(`Not a number: ${raw}`, start)
      tokens.push({ kind: 'number', value, at: start })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index
      while (index < source.length && /[A-Za-z0-9_$.-]/.test(source[index] ?? '')) index += 1
      tokens.push({ kind: 'ident', text: source.slice(start, index), at: start })
      continue
    }
    if ('().,[]{}:'.includes(char)) {
      tokens.push({ kind: 'punct', text: char, at: index })
      index += 1
      continue
    }
    if (['==', '!=', '<=', '>=', '<', '>'].some((op) => source.startsWith(op, index))) {
      const op =
        ['==', '!=', '<=', '>='].find((candidate) => source.startsWith(candidate, index)) ?? char
      tokens.push({ kind: 'punct', text: op, at: index })
      index += op.length
      continue
    }
    throw new QueryParseError(`Unexpected character ${JSON.stringify(char)}`, index)
  }
  tokens.push({ kind: 'end', at: source.length })
  return tokens
}

/**
 * Parses the SDK chain. Accepts `where(...)`, `orderBy(...)`, `limit(n)`,
 * joined by `.` or whitespace, with an optional `query(collection(db, "x"), …)`
 * wrapper around them; literals are strings, numbers, booleans, null, arrays,
 * `Timestamp("…")`/`new Date("…")`, `doc("path")`/`ref("path")` and
 * `GeoPoint(lat, lng)`.
 */
export function parseQuery(source: string): WorkbenchQuery {
  const tokens = tokenize(source)
  let position = 0
  const peek = () => tokens[position] ?? { kind: 'end', at: source.length }
  const next = () => {
    const token = peek()
    position += 1
    return token
  }
  const expectPunct = (text: string) => {
    const token = next()
    if (token.kind !== 'punct' || token.text !== text)
      throw new QueryParseError(`Expected ${text}`, token.at)
  }
  const query: WorkbenchQuery = { where: [], orderBy: [], limit: DEFAULT_LIMIT }

  function literal(): FsValue {
    const token = next()
    if (token.kind === 'string') return { type: 'string', value: token.text }
    if (token.kind === 'number')
      return { type: 'number', value: token.value, integer: Number.isInteger(token.value) }
    if (token.kind === 'punct' && token.text === '[') {
      const items: FsValue[] = []
      while (!(peek().kind === 'punct' && (peek() as { text: string }).text === ']')) {
        items.push(literal())
        if (peek().kind === 'punct' && (peek() as { text: string }).text === ',') next()
      }
      expectPunct(']')
      return { type: 'array', items }
    }
    if (token.kind === 'ident') {
      const name = token.text
      if (name === 'true') return { type: 'boolean', value: true }
      if (name === 'false') return { type: 'boolean', value: false }
      if (name === 'null') return { type: 'null' }
      if (name === 'new') return literal()
      const args = callArguments()
      const first = args[0]
      if (name === 'Timestamp' || name === 'Date' || name === 'Timestamp.fromDate') {
        if (first?.type === 'string') {
          const date = new Date(first.value)
          if (Number.isNaN(date.getTime())) throw new QueryParseError('Not a date', token.at)
          return { type: 'timestamp', value: date.toISOString() }
        }
        if (first?.type === 'timestamp') return first
        throw new QueryParseError('Timestamp takes an ISO string', token.at)
      }
      if (name === 'doc' || name === 'ref' || name === 'DocumentReference') {
        const path = args
          .filter((arg) => arg.type === 'string')
          .map((arg) => arg.value)
          .join('/')
        if (!path) throw new QueryParseError('doc() takes a path', token.at)
        return { type: 'reference', value: path, path }
      }
      if (name === 'GeoPoint') {
        const [latitude, longitude] = args
        if (latitude?.type !== 'number' || longitude?.type !== 'number')
          throw new QueryParseError('GeoPoint takes two numbers', token.at)
        return { type: 'geopoint', latitude: latitude.value, longitude: longitude.value }
      }
      throw new QueryParseError(`Unknown value ${name}`, token.at)
    }
    throw new QueryParseError('Expected a value', token.at)
  }

  function callArguments(): FsValue[] {
    expectPunct('(')
    const args: FsValue[] = []
    while (!(peek().kind === 'punct' && (peek() as { text: string }).text === ')')) {
      if (peek().kind === 'end') throw new QueryParseError('Expected )', peek().at)
      args.push(literal())
      if (peek().kind === 'punct' && (peek() as { text: string }).text === ',') next()
    }
    expectPunct(')')
    return args
  }

  function stringArgument(args: FsValue[], index: number, what: string, at: number): string {
    const value = args[index]
    if (value?.type !== 'string') throw new QueryParseError(`${what} must be a string`, at)
    return value.value
  }

  while (peek().kind !== 'end') {
    const token = next()
    if (token.kind === 'punct' && (token.text === '.' || token.text === ',' || token.text === ')'))
      continue
    if (token.kind !== 'ident')
      throw new QueryParseError('Expected where, orderBy or limit', token.at)
    const name = token.text.replace(/^query\./, '')
    if (name === 'query') {
      // `query(collection(db, "x"), where(...), ...)`: the clauses are its
      // arguments, so only the opening parenthesis is consumed.
      if (peek().kind === 'punct' && (peek() as { text: string }).text === '(') next()
      continue
    }
    if (name === 'collection' || name === 'collectionGroup' || name === 'db') {
      // The source of an SDK snippet says nothing the path bar does not.
      if (peek().kind === 'punct' && (peek() as { text: string }).text === '(') {
        let depth = 0
        do {
          const inner = next()
          if (inner.kind === 'punct' && inner.text === '(') depth += 1
          if (inner.kind === 'punct' && inner.text === ')') depth -= 1
          if (inner.kind === 'end') throw new QueryParseError('Expected )', inner.at)
        } while (depth > 0)
      }
      continue
    }
    const args = callArguments()
    if (name === 'where') {
      const field = stringArgument(args, 0, 'The field', token.at)
      const op = stringArgument(args, 1, 'The operator', token.at) as Operator
      if (!OPERATORS.includes(op)) throw new QueryParseError(`Unknown operator ${op}`, token.at)
      const value = args[2]
      if (!value) throw new QueryParseError('where() takes field, operator, value', token.at)
      query.where.push({ field, op, value })
    } else if (name === 'orderBy') {
      const field = stringArgument(args, 0, 'The field', token.at)
      const direction = args[1]
      query.orderBy.push({
        field,
        direction: direction?.type === 'string' && direction.value === 'desc' ? 'desc' : 'asc',
      })
    } else if (name === 'limit' || name === 'limitToLast') {
      const value = args[0]
      if (value?.type !== 'number' || value.value < 1)
        throw new QueryParseError('limit() takes a positive number', token.at)
      query.limit = Math.floor(value.value)
    } else {
      throw new QueryParseError(`Unknown clause ${name}`, token.at)
    }
  }
  return query
}

// ---------------------------------------------------------------------------
// REST StructuredQuery

export interface StructuredQuery {
  from: Array<{ collectionId: string; allDescendants?: boolean }>
  where?: unknown
  orderBy?: Array<{ field: { fieldPath: string }; direction: 'ASCENDING' | 'DESCENDING' }>
  limit?: number
  startAt?: { values: RestValue[]; before: boolean }
  select?: { fields: Array<{ fieldPath: string }> }
}

const REST_OPERATORS: Record<Operator, string> = {
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS',
  in: 'IN',
  'not-in': 'NOT_IN',
  'array-contains-any': 'ARRAY_CONTAINS_ANY',
}

export function fieldPathText(field: string): string {
  return field.split('.').map(quoteFieldSegment).join('.')
}

/** The effective order: the requested fields plus `__name__`, which makes cursors exact. */
export function effectiveOrder(query: WorkbenchQuery): OrderClause[] {
  if (query.orderBy.some((order) => order.field === '__name__')) return query.orderBy
  const last = query.orderBy.at(-1)
  return [...query.orderBy, { field: '__name__', direction: last?.direction ?? 'asc' }]
}

export function toStructuredQuery(
  collectionId: string,
  group: boolean,
  query: WorkbenchQuery,
  documentRoot: string,
  cursor?: RestValue[],
): StructuredQuery {
  const filters = query.where.map((clause) => {
    if (clause.value.type === 'null' && (clause.op === '==' || clause.op === '!='))
      return {
        unaryFilter: {
          op: clause.op === '==' ? 'IS_NULL' : 'IS_NOT_NULL',
          field: { fieldPath: fieldPathText(clause.field) },
        },
      }
    if (
      clause.value.type === 'number' &&
      Number.isNaN(clause.value.value) &&
      (clause.op === '==' || clause.op === '!=')
    )
      return {
        unaryFilter: {
          op: clause.op === '==' ? 'IS_NAN' : 'IS_NOT_NAN',
          field: { fieldPath: fieldPathText(clause.field) },
        },
      }
    return {
      fieldFilter: {
        field: { fieldPath: fieldPathText(clause.field) },
        op: REST_OPERATORS[clause.op],
        value: encodeValue(clause.value, documentRoot),
      },
    }
  })
  const structured: StructuredQuery = {
    from: [{ collectionId, allDescendants: group }],
    orderBy: effectiveOrder(query).map((order) => ({
      field: { fieldPath: fieldPathText(order.field) },
      direction: order.direction === 'desc' ? 'DESCENDING' : 'ASCENDING',
    })),
    limit: query.limit,
  }
  if (filters.length === 1) structured.where = filters[0]
  else if (filters.length > 1) structured.where = { compositeFilter: { op: 'AND', filters } }
  if (cursor) structured.startAt = { values: cursor, before: false }
  return structured
}

// ---------------------------------------------------------------------------
// Copy as code

export type CodeTarget = 'web' | 'admin' | 'flutter' | 'rest'

export const CODE_TARGETS: Array<{ id: CodeTarget; label: string }> = [
  { id: 'web', label: 'Web SDK (modular)' },
  { id: 'admin', label: 'Admin SDK (Node)' },
  { id: 'flutter', label: 'Flutter' },
  { id: 'rest', label: 'REST (curl)' },
]

function literalFor(target: CodeTarget, value: FsValue): string {
  switch (value.type) {
    case 'string':
      return target === 'flutter'
        ? `'${value.value.replace(/'/g, "\\'")}'`
        : JSON.stringify(value.value)
    case 'number':
      // A double with no fractional part is the one thing Firestore keeps
      // that JavaScript cannot say out loud: `269` goes back as an
      // integer. Dart has two number types and can.
      return target === 'flutter' && !value.integer && Number.isInteger(value.value)
        ? `${value.value}.0`
        : String(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'null':
      return 'null'
    case 'timestamp':
      return target === 'web'
        ? `Timestamp.fromDate(new Date(${JSON.stringify(value.value)}))`
        : target === 'admin'
          ? `Timestamp.fromDate(new Date(${JSON.stringify(value.value)}))`
          : target === 'flutter'
            ? `Timestamp.fromDate(DateTime.parse('${value.value}'))`
            : JSON.stringify(value.value)
    case 'reference':
      return target === 'web'
        ? `doc(db, ${JSON.stringify(value.path)})`
        : target === 'admin'
          ? `db.doc(${JSON.stringify(value.path)})`
          : target === 'flutter'
            ? `FirebaseFirestore.instance.doc('${value.path}')`
            : JSON.stringify(value.path)
    case 'geopoint':
      return target === 'flutter'
        ? `GeoPoint(${value.latitude}, ${value.longitude})`
        : `new GeoPoint(${value.latitude}, ${value.longitude})`
    case 'array':
      return `[${value.items.map((item) => literalFor(target, item)).join(', ')}]`
    case 'map':
      return `{${Object.entries(value.fields)
        .map(
          ([key, item]) =>
            `${target === 'flutter' ? `'${key}'` : JSON.stringify(key)}: ${literalFor(target, item)}`,
        )
        .join(', ')}}`
    case 'bytes':
      return target === 'web'
        ? `Bytes.fromBase64String(${JSON.stringify(value.base64)})`
        : target === 'admin'
          ? `Buffer.from(${JSON.stringify(value.base64)}, 'base64')`
          : target === 'flutter'
            ? `Blob(base64Decode('${value.base64}'))`
            : JSON.stringify(value.base64)
    case 'vector':
      return JSON.stringify(value.values)
  }
}

/**
 * One entry of a document, laid out over as many lines as it needs. A
 * document is nested and a one-line literal is unreadable past the first
 * map, so containers open and leaves stay where `literalFor` put them.
 */
function prettyLiteral(target: CodeTarget, value: FsValue, depth: number): string {
  const pad = '  '.repeat(depth + 1)
  const close = '  '.repeat(depth)
  const key = (name: string) => (target === 'flutter' ? `'${name}'` : JSON.stringify(name))
  if (value.type === 'map') {
    const entries = Object.entries(value.fields)
    if (entries.length === 0) return '{}'
    const lines = entries.map(
      ([name, item]) => `${pad}${key(name)}: ${prettyLiteral(target, item, depth + 1)}`,
    )
    return `{\n${lines.join(',\n')}\n${close}}`
  }
  if (value.type === 'array' && value.items.some((item) => item.type === 'map')) {
    const lines = value.items.map((item) => `${pad}${prettyLiteral(target, item, depth + 1)}`)
    return `[\n${lines.join(',\n')}\n${close}]`
  }
  return literalFor(target, value)
}

/** The SDK names a snippet uses, so the import line it opens with compiles. */
const CONSTRUCTORS: ReadonlyArray<[FirestoreValueType, string]> = [
  ['timestamp', 'Timestamp'],
  ['geopoint', 'GeoPoint'],
  ['bytes', 'Bytes'],
]

function usedTypes(value: FsValue, found: Set<FirestoreValueType>): Set<FirestoreValueType> {
  found.add(value.type)
  if (value.type === 'map') for (const item of Object.values(value.fields)) usedTypes(item, found)
  if (value.type === 'array') for (const item of value.items) usedTypes(item, found)
  return found
}

/**
 * The fields a dialect cannot write back as what they are. Only one is
 * left: JavaScript has a single number type, so a double that happens to
 * be whole goes back to Firestore as an integer. Saying so beats being
 * quietly wrong — the whole worth of copying a real document rather than
 * asking somebody to write the call from memory is that the types survive.
 */
function lossyPaths(value: FsValue, at: string, out: string[]): string[] {
  if (value.type === 'number' && !value.integer && Number.isInteger(value.value)) out.push(at)
  if (value.type === 'map')
    for (const [name, item] of Object.entries(value.fields)) lossyPaths(item, `${at}.${name}`, out)
  if (value.type === 'array')
    value.items.forEach((item, index) => lossyPaths(item, `${at}[${index}]`, out))
  return out
}

export function documentAsCode(
  target: CodeTarget,
  path: string,
  restFields: Record<string, RestValue>,
  scope: { project: string; database: string; origin: string },
): string {
  if (target === 'rest') {
    const root = `projects/${scope.project}/databases/${scope.database}/documents`
    return `curl -sS -X PATCH "${scope.origin}/v1/${root}/${path}" \\\n  -H "Authorization: Bearer owner" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ fields: restFields })}'\n`
  }

  // Built from the REST fields, which carry the types, and not from the
  // plain JSON beside them, which does not. Printing the JSON is what
  // this did, and it meant a timestamp came back as a string, a geopoint
  // as a map and a reference as a path — running the snippet wrote a
  // different document than the one it was copied from.
  const fields = decodeFields(restFields)
  const document: FsValue = { type: 'map', fields }
  const body = prettyLiteral(target, document, 0)
  const used = usedTypes(document, new Set())
  const lossy = lossyPaths(document, '', [])
  const note =
    target === 'flutter' || lossy.length === 0
      ? ''
      : `// ${lossy.map((at) => at.slice(1)).join(', ')} ${lossy.length === 1 ? 'holds a double' : 'hold doubles'} with no fractional part.\n// JavaScript has one number type, so this writes ${lossy.length === 1 ? 'an integer' : 'integers'}.\n`

  if (target === 'flutter') return `await FirebaseFirestore.instance.doc('${path}').set(${body});\n`
  const names = [
    'doc',
    'setDoc',
    ...CONSTRUCTORS.filter(([type]) => used.has(type)).map(([, name]) => name),
  ]
  if (target === 'web')
    return `import { ${names.join(', ')} } from "firebase/firestore";\n\n${note}await setDoc(doc(db, ${JSON.stringify(path)}), ${body});\n`
  return `${note}await db.doc(${JSON.stringify(path)}).set(${body});\n`
}
