import { describe, expect, it } from 'vitest'
import { RULES } from './fixture.test-support'
import { documentPattern, enclosingMatchPath, outline, wildcardsAt } from './outline'

/** The offset just after the nth `needle`, or at its start with `before`. */
function at(needle: string, { nth = 0, before = false } = {}): number {
  let found = -1
  for (let i = 0; i <= nth; i++) found = RULES.indexOf(needle, found + 1)
  if (found < 0) throw new Error(`no ${needle}`)
  return before ? found : found + needle.length
}

describe('the match path around a position', () => {
  it('joins the headers of nested matches, below the documents root', () => {
    expect(enclosingMatchPath(RULES, at('total <'))).toBe('/users/{uid}/orders/{orderId}')
    expect(enclosingMatchPath(RULES, at('allow read: if isOwner() ||'))).toBe('/users/{uid}')
  })

  it('answers inside a condition, not inside a header', () => {
    // In the header of the orders match, the orders match is not yet around.
    expect(enclosingMatchPath(RULES, at('/orders/{ord'))).toBe('/users/{uid}')
    expect(enclosingMatchPath(RULES, at('{uid', { nth: 0 }))).toBeNull()
  })

  it('answers inside a function declared in a match', () => {
    expect(enclosingMatchPath(RULES, at('request.auth.uid == uid'))).toBe('/users/{uid}')
  })

  it('is null at the documents root and outside every match', () => {
    expect(enclosingMatchPath(RULES, at('return request.auth != null'))).toBeNull()
    expect(enclosingMatchPath(RULES, at('service cloud.firestore {'))).toBeNull()
    expect(enclosingMatchPath(RULES, 0)).toBeNull()
  })

  it('keeps a recursive wildcard as written', () => {
    expect(enclosingMatchPath(RULES, at('request.query.limit'))).toBe('/posts/{rest=**}')
  })

  it('counts the first position inside a block and the last before its brace', () => {
    const open = at('match /users/{uid} {')
    expect(enclosingMatchPath(RULES, open)).toBe('/users/{uid}')
    expect(enclosingMatchPath(RULES, open - 1)).toBeNull()
    const close = RULES.indexOf('}\n\n    // Public')
    expect(enclosingMatchPath(RULES, close)).toBe('/users/{uid}')
    expect(enclosingMatchPath(RULES, close + 1)).toBeNull()
  })

  it('accepts a root and a collection in one header', () => {
    const text =
      'service cloud.firestore {\n  match /databases/{db}/documents/rooms/{room} {\n    allow read;\n  }\n}'
    expect(enclosingMatchPath(text, text.indexOf('allow'))).toBe('/rooms/{room}')
  })

  it('is null outside the documents tree, as in a Storage ruleset', () => {
    const text =
      'service firebase.storage {\n  match /b/{bucket}/o {\n    match /{file} { allow read; }\n  }\n}'
    expect(enclosingMatchPath(text, text.indexOf('allow'))).toBeNull()
  })

  it('treats an unclosed block as running to the end', () => {
    const text =
      'service cloud.firestore {\n  match /databases/{database}/documents {\n    match /a/{b} {\n      allow read: if '
    expect(enclosingMatchPath(text, text.length)).toBe('/a/{b}')
  })

  it('is not fooled by braces in strings and comments', () => {
    const text =
      "match /databases/{d}/documents {\n  match /a/{b} {\n    // }\n    allow read: if x == '}' /* } */ && "
    expect(enclosingMatchPath(text, text.length)).toBe('/a/{b}')
  })
})

describe('the collection pattern of a match path', () => {
  it('replaces wildcards with stars and drops the document', () => {
    expect(documentPattern('/users/{uid}/orders/{orderId}')).toBe('users/*/orders')
    expect(documentPattern('/users/{uid}')).toBe('users')
    expect(documentPattern('/config/settings')).toBe('config')
  })

  it('is null for a path that ends on a collection', () => {
    expect(documentPattern('/users')).toBeNull()
    expect(documentPattern('/users/{uid}/orders')).toBeNull()
    expect(documentPattern('')).toBeNull()
  })

  it('is null for a recursive wildcard', () => {
    expect(documentPattern('/posts/{rest=**}')).toBeNull()
    expect(documentPattern('/{document=**}')).toBeNull()
  })
})

describe('the wildcards in scope', () => {
  it('lists every enclosing match, innermost last', () => {
    expect(wildcardsAt(RULES, at('total <'))).toEqual(['database', 'uid', 'orderId'])
    expect(wildcardsAt(RULES, at('isAdmin();'))).toEqual(['database', 'uid'])
  })

  it('names a recursive wildcard without its stars', () => {
    expect(wildcardsAt(RULES, at('request.query.limit'))).toEqual(['database', 'rest'])
  })

  it("leaves out a header's own wildcards until its block", () => {
    expect(wildcardsAt(RULES, at('/orders/{ord'))).toEqual(['database', 'uid'])
    expect(wildcardsAt(RULES, at('service cloud.firestore {'))).toEqual([])
  })
})

describe('the outline', () => {
  it('finds the functions, their parameters and where they can be called', () => {
    const o = outline('match /a/{b} {\n  function f(x, y) {\n    let z = x;\n    return z;\n  }\n}')
    expect(o.functions).toHaveLength(1)
    const [f] = o.functions
    expect(f).toMatchObject({ name: 'f', params: ['x', 'y'] })
    expect(f!.scope?.kind).toBe('match')
    expect(o.bindings.map((b) => b.name)).toEqual(['z'])
  })

  it('tells a map literal from a block', () => {
    const o = outline("match /a/{b} {\n  allow read: if x in {'k': 1};\n}")
    expect(o.brackets.map((b) => b.kind)).toEqual(['match', 'map'])
  })
})
