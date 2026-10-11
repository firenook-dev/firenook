// Starter rules for a collection, written from what its documents hold.
//
// A guess, said to be one: who owns a document is read from the path (a
// collection under `users/{userId}`, or `users` itself) or from an owner
// field the documents carry; failing both, any signed-in user, marked to
// be narrowed. Writes are checked against the fields and types the sample
// shows — the validation most hand-written rules leave out.

import type { FieldSample } from './schema-fields'

const OWNER_FIELDS = ['ownerId', 'owner', 'userId', 'uid', 'createdBy', 'authorId']

const RULE_TYPES: Partial<Record<string, string>> = {
  string: 'string',
  number: 'number',
  boolean: 'bool',
  timestamp: 'timestamp',
  map: 'map',
  array: 'list',
  reference: 'path',
  geopoint: 'latlng',
  bytes: 'bytes',
}

/** `users` → `userId`, `categories` → `categoryId`, `addresses` → `addressId`. */
export function wildcardName(collection: string, taken: ReadonlySet<string>): string {
  const word = collection.replace(/[^A-Za-z0-9_]/g, '') || 'doc'
  const singular = word.endsWith('ies')
    ? `${word.slice(0, -3)}y`
    : ['sses', 'shes', 'ches', 'xes'].some((ending) => word.endsWith(ending))
      ? word.slice(0, -2)
      : word.endsWith('s') && !word.endsWith('ss')
        ? word.slice(0, -1)
        : word
  let name = `${/^[0-9]/.test(singular) ? `d${singular}` : singular}Id`
  for (let index = 2; taken.has(name); index += 1) name = `${singular}Id${index}`
  return name
}

function access(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `data.${field}` : `data[${JSON.stringify(field)}]`
}

function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The match block, with a comment saying what it guessed. */
export function starterRules(
  pattern: string,
  fields: readonly FieldSample[],
  indent = '    ',
): string {
  const parts = pattern.split('/')
  const taken = new Set<string>()
  const segments: string[] = []
  const wildcards: Array<{ collection: string; name: string }> = []
  for (let index = 0; index < parts.length; index += 2) {
    const collection = parts[index] ?? 'items'
    const next = parts[index + 1]
    segments.push(collection)
    const name = wildcardName(collection, taken)
    taken.add(name)
    if (next === undefined || next === '*') {
      segments.push(`{${name}}`)
      wildcards.push({ collection, name })
    } else segments.push(next)
  }
  const own = wildcards.at(-1)?.name ?? 'docId'
  const usersAbove = wildcards.find((wildcard) => wildcard.collection === 'users')
  const top = fields.filter((field) => !field.field.includes('.'))
  const ownerField = OWNER_FIELDS.find((name) =>
    top.some((field) => field.field === name && field.type === 'string'),
  )

  let read: string
  let create: string
  let update: string
  let guess: string
  if (usersAbove && usersAbove.name !== own) {
    read = `request.auth != null && request.auth.uid == ${usersAbove.name}`
    create = read
    update = read
    guess = `the user named by {${usersAbove.name}} in the path owns these documents`
  } else if (pattern === 'users') {
    read = `request.auth != null && request.auth.uid == ${own}`
    create = read
    update = read
    guess = 'a user owns the document whose id is their uid'
  } else if (ownerField) {
    read = `request.auth != null && resource.data.${ownerField} == request.auth.uid`
    create = `request.auth != null && request.resource.data.${ownerField} == request.auth.uid`
    update = `${read}\n${indent}    && request.resource.data.${ownerField} == resource.data.${ownerField}`
    guess = `the user in ${ownerField} owns a document, and cannot hand it to someone else`
  } else {
    read = 'request.auth != null'
    create = read
    update = read
    guess = 'nothing says who owns these documents, so any signed-in user can; narrow this'
  }

  const name = capitalised(wildcards.at(-1)?.collection.replace(/[^A-Za-z0-9]/g, '') ?? 'Doc')
  const validate = `valid${name}`
  const required = top.filter((field) => field.present === field.of && field.of > 0)
  const checks = top.flatMap((field) => {
    const type = RULE_TYPES[field.type]
    if (!type) return []
    const check = `${access(field.field)} is ${type}`
    return field.present === field.of
      ? [check]
      : [`(!(${JSON.stringify(field.field)} in data) || ${check})`]
  })
  const clauses = [
    `data.keys().hasOnly([${top.map((field) => JSON.stringify(field.field)).join(', ')}])`,
    ...(required.length > 0
      ? [`data.keys().hasAll([${required.map((field) => JSON.stringify(field.field)).join(', ')}])`]
      : []),
    ...checks,
  ]
  const sampled = fields.find((field) => field.of > 0)?.of ?? 0

  const lines = [
    `// Starter rules for ${pattern}, from ${sampled} sampled document${sampled === 1 ? '' : 's'}.`,
    `// A guess: ${guess}. Check it before relying on it.`,
    `match /${segments.join('/')} {`,
    `  allow read: if ${read};`,
    `  allow create: if ${create}`,
    `    && ${validate}(request.resource.data);`,
    `  allow update: if ${update}`,
    `    && ${validate}(request.resource.data);`,
    `  allow delete: if ${read};`,
    '',
    `  function ${validate}(data) {`,
    `    return ${clauses.join(`\n${indent}      && `)};`,
    '  }',
    '}',
  ]
  return lines.map((line) => (line ? `${indent}${line}` : line)).join('\n')
}

/**
 * The text with a block put inside `match /databases/{database}/documents`,
 * just before it closes; at the end when there is no such block. Returns
 * the new text and the line the block starts on.
 */
export function insertBlock(source: string, block: string): { text: string; line: number } {
  const header = /match\s+\/databases\/\{[^}]+\}\/documents\s*\{/.exec(source)
  let at = source.length
  if (header) {
    let depth = 0
    for (let index = header.index + header[0].length - 1; index < source.length; index += 1) {
      const character = source[index]
      if (character === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index)
        index = end === -1 ? source.length : end
        continue
      }
      if (character === "'" || character === '"') {
        const close = source.indexOf(character, index + 1)
        index = close === -1 ? source.length : close
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          at = source.lastIndexOf('\n', index - 1) + 1
          break
        }
      }
    }
  }
  const before = source.slice(0, at)
  const lead = before === '' || before.endsWith('\n') ? '' : '\n'
  const text = `${before}${lead}\n${block}\n${source.slice(at)}`
  const line = `${before}${lead}\n`.split('\n').length
  return { text, line }
}
