import { describe, expect, it } from 'vitest'
import { insertBlock, starterRules, wildcardName } from './starter'

const sample = (field: string, type: string, present = 10, of = 10) => ({
  field,
  type: type as 'string',
  present,
  of,
})

describe('starter rules', () => {
  it('names wildcards after their collection', () => {
    expect(wildcardName('users', new Set())).toBe('userId')
    expect(wildcardName('categories', new Set())).toBe('categoryId')
    expect(wildcardName('addresses', new Set())).toBe('addressId')
    expect(wildcardName('glass', new Set())).toBe('glassId')
    expect(wildcardName('users', new Set(['userId']))).toBe('userId2')
  })

  it('takes the owner from a users document above the collection', () => {
    const block = starterRules('users/*/orders', [sample('total', 'number')], '')
    expect(block).toContain('match /users/{userId}/orders/{orderId} {')
    expect(block).toContain('allow read: if request.auth != null && request.auth.uid == userId;')
    expect(block).toContain('function validOrders(data) {')
    expect(block).toContain('data.total is number')
  })

  it('takes the owner from an owner field, and keeps it from changing hands', () => {
    const block = starterRules(
      'posts',
      [sample('ownerId', 'string'), sample('title', 'string')],
      '',
    )
    expect(block).toContain('resource.data.ownerId == request.auth.uid')
    expect(block).toContain('request.resource.data.ownerId == request.auth.uid')
    expect(block).toContain('request.resource.data.ownerId == resource.data.ownerId')
  })

  it('says when it could not tell who owns a document', () => {
    const block = starterRules('events', [sample('kind', 'string')], '')
    expect(block).toContain('allow read: if request.auth != null;')
    expect(block).toMatch(/narrow this/)
  })

  it('checks required fields always and optional ones only when present', () => {
    const block = starterRules(
      'users',
      [sample('name', 'string'), sample('nick', 'string', 3, 10), sample('meta.x', 'string')],
      '',
    )
    expect(block).toContain('data.keys().hasOnly(["name", "nick"])')
    expect(block).toContain('data.keys().hasAll(["name"])')
    expect(block).toContain('data.name is string')
    expect(block).toContain('(!("nick" in data) || data.nick is string)')
    expect(block).not.toContain('meta.x')
  })
})

describe('putting a block into the rules', () => {
  const rules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    "    match /a/{b} { allow read: if '}' == '}'; } // a } in a comment",
    '  }',
    '}',
  ].join('\n')

  it('goes inside the documents block, before it closes', () => {
    const { text, line } = insertBlock(rules, '    match /x/{y} {}')
    const lines = text.split('\n')
    expect(lines[line - 1]).toBe('    match /x/{y} {}')
    expect(lines[line]).toBe('  }')
    expect(lines.at(-1)).toBe('}')
  })

  it('goes at the end when there is no documents block', () => {
    const { text, line } = insertBlock('service cloud.firestore {}', 'X')
    expect(text.split('\n')[line - 1]).toBe('X')
  })
})
