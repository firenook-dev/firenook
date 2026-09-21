// The workbench query: the same clauses an app writes, kept as data, printed
// as the SDK chain developers already know, parsed back from it, and encoded
// as the REST StructuredQuery the engine runs.

import { quoteFieldSegment } from './rest'
import { type FsValue, type RestValue, encodeValue } from './value'

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
      return String(value.value)
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
      return JSON.stringify(value.base64)
    case 'vector':
      return JSON.stringify(value.values)
  }
}

export function queryAsCode(
  target: CodeTarget,
  collectionPath: string,
  group: boolean,
  query: WorkbenchQuery,
  scope: { project: string; database: string; origin: string },
): string {
  const collectionId = collectionPath.split('/').at(-1) ?? collectionPath
  if (target === 'web') {
    const clauses = [
      ...query.where.map(
        (c) =>
          `  where(${JSON.stringify(c.field)}, ${JSON.stringify(c.op)}, ${literalFor('web', c.value)})`,
      ),
      ...query.orderBy.map(
        (o) => `  orderBy(${JSON.stringify(o.field)}${o.direction === 'desc' ? ', "desc"' : ''})`,
      ),
      `  limit(${query.limit})`,
    ]
    const source = group
      ? `collectionGroup(db, ${JSON.stringify(collectionId)})`
      : `collection(db, ${JSON.stringify(collectionPath)})`
    return `import { collection, collectionGroup, doc, getDocs, limit, orderBy, query, where, Timestamp, GeoPoint } from "firebase/firestore";\n\nconst q = query(\n  ${source},\n${clauses.join(',\n')}\n);\nconst snapshot = await getDocs(q);\nsnapshot.forEach((d) => console.log(d.id, d.data()));\n`
  }
  if (target === 'admin') {
    const source = group
      ? `db.collectionGroup(${JSON.stringify(collectionId)})`
      : `db.collection(${JSON.stringify(collectionPath)})`
    const chain = [
      ...query.where.map(
        (c) =>
          `.where(${JSON.stringify(c.field)}, ${JSON.stringify(c.op)}, ${literalFor('admin', c.value)})`,
      ),
      ...query.orderBy.map(
        (o) => `.orderBy(${JSON.stringify(o.field)}${o.direction === 'desc' ? ', "desc"' : ''})`,
      ),
      `.limit(${query.limit})`,
    ]
    return `import { getFirestore, Timestamp, GeoPoint } from "firebase-admin/firestore";\n\nconst db = getFirestore();\nconst snapshot = await ${source}\n  ${chain.join('\n  ')}\n  .get();\nsnapshot.forEach((d) => console.log(d.id, d.data()));\n`
  }
  if (target === 'flutter') {
    const source = group
      ? `FirebaseFirestore.instance.collectionGroup('${collectionId}')`
      : `FirebaseFirestore.instance.collection('${collectionPath}')`
    const flutterOp = (c: WhereClause) => {
      const value = literalFor('flutter', c.value)
      switch (c.op) {
        case '==':
          return `isEqualTo: ${value}`
        case '!=':
          return `isNotEqualTo: ${value}`
        case '<':
          return `isLessThan: ${value}`
        case '<=':
          return `isLessThanOrEqualTo: ${value}`
        case '>':
          return `isGreaterThan: ${value}`
        case '>=':
          return `isGreaterThanOrEqualTo: ${value}`
        case 'array-contains':
          return `arrayContains: ${value}`
        case 'array-contains-any':
          return `arrayContainsAny: ${value}`
        case 'in':
          return `whereIn: ${value}`
        case 'not-in':
          return `whereNotIn: ${value}`
      }
    }
    const chain = [
      ...query.where.map((c) => `.where('${c.field}', ${flutterOp(c)})`),
      ...query.orderBy.map(
        (o) => `.orderBy('${o.field}'${o.direction === 'desc' ? ', descending: true' : ''})`,
      ),
      `.limit(${query.limit})`,
    ]
    return `final snapshot = await ${source}\n    ${chain.join('\n    ')}\n    .get();\nfor (final d in snapshot.docs) {\n  print('\${d.id} \${d.data()}');\n}\n`
  }
  const root = `projects/${scope.project}/databases/${scope.database}/documents`
  const structured = toStructuredQuery(collectionId, group, query, root)
  const parent =
    group || !collectionPath.includes('/')
      ? ''
      : `/${collectionPath.slice(0, collectionPath.lastIndexOf('/'))}`
  return `curl -sS -X POST "${scope.origin}/v1/${root}${parent}:runQuery" \\\n  -H "Authorization: Bearer owner" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ structuredQuery: structured })}'\n`
}

export function documentAsCode(
  target: CodeTarget,
  path: string,
  json: Record<string, unknown>,
  restFields: Record<string, RestValue>,
  scope: { project: string; database: string; origin: string },
): string {
  const data = JSON.stringify(json, null, 2)
  if (target === 'web')
    return `import { doc, setDoc } from "firebase/firestore";\n\nawait setDoc(doc(db, ${JSON.stringify(path)}), ${data});\n`
  if (target === 'admin') return `await db.doc(${JSON.stringify(path)}).set(${data});\n`
  if (target === 'flutter')
    return `await FirebaseFirestore.instance.doc('${path}').set(${data.replace(/"([^"]+)":/g, "'$1':").replace(/"/g, "'")});\n`
  const root = `projects/${scope.project}/databases/${scope.database}/documents`
  return `curl -sS -X PATCH "${scope.origin}/v1/${root}/${path}" \\\n  -H "Authorization: Bearer owner" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ fields: restFields })}'\n`
}
