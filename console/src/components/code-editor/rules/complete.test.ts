import {
  type Completion,
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { dialectOf } from './complete'
import { rulesLanguage } from './language'
import type { RulesLanguageOptions } from './options'
import { outline } from './outline'

const CARET = '‸'

function stateAt(source: string, options: RulesLanguageOptions = {}) {
  const pos = source.indexOf(CARET)
  if (pos < 0) throw new Error('no caret')
  const doc = source.slice(0, pos) + source.slice(pos + CARET.length)
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [rulesLanguage(options)],
  })
  return { state, pos }
}

async function complete(
  source: string,
  { options = {}, explicit = false }: { options?: RulesLanguageOptions; explicit?: boolean } = {},
): Promise<CompletionResult | null> {
  const { state, pos } = stateAt(source, options)
  const sources = state.languageDataAt<CompletionSource>('autocomplete', pos)
  expect(sources).toHaveLength(1)
  return sources[0]!(new CompletionContext(state, pos, explicit))
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? []
}

function option(result: CompletionResult | null, label: string, detail?: string): Completion {
  const found = result?.options.find(
    (o) => o.label === label && (detail === undefined || o.detail === detail),
  )
  if (!found) throw new Error(`no ${label} in ${labels(result).join(', ')}`)
  return found
}

/** The labels with the highest boost, which CodeMirror lists first. */
function top(result: CompletionResult | null): string[] {
  const options = result?.options ?? []
  const best = Math.max(...options.map((o) => o.boost ?? 0))
  return options.filter((o) => (o.boost ?? 0) === best).map((o) => o.label)
}

const DOCS = (body: string) =>
  `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`

const ORDERS = (condition: string) =>
  DOCS(`    function signedIn() { return request.auth != null; }
    match /users/{uid} {
      function isOwner() { return signedIn() && request.auth.uid == uid; }
      match /orders/{orderId} {
        allow read: if ${condition};
      }
    }
    match /admins/{adminId} {
      function isAdmin() { return true; }
    }`)

describe('statements', () => {
  it('offers the file header and the service at the top', async () => {
    const result = await complete(CARET, { explicit: true })
    expect(labels(result)).toEqual(['rules_version', 'rules_version', 'service', 'service'])
    expect(option(result, 'service', 'cloud.firestore { … }').info).toMatch(/cloud.firestore/)
  })

  it('offers the documents root and functions directly inside the service', async () => {
    const result = await complete(`service cloud.firestore {\n  m${CARET}\n}`)
    expect(new Set(labels(result))).toEqual(new Set(['match', 'function']))
    expect(option(result, 'match', '/databases/{database}/documents { … }')).toBeTruthy()
  })

  it('offers match, allow and function inside a match', async () => {
    const result = await complete(DOCS(`    match /a/{b} {\n      ${CARET}\n    }`), {
      explicit: true,
    })
    expect(new Set(labels(result))).toEqual(new Set(['match', 'allow', 'function']))
    for (const label of ['match', 'allow', 'function'])
      expect(option(result, label).info).toBeTruthy()
    expect(option(result, 'allow', '…: if …;')).toBeTruthy()
    expect(option(result, 'match', '/…/{…} { … }')).toBeTruthy()
  })

  it('offers let and return inside a function', async () => {
    const result = await complete(DOCS(`    function f() {\n      ${CARET}\n    }`), {
      explicit: true,
    })
    expect(new Set(labels(result))).toEqual(new Set(['let', 'return']))
  })

  it('offers statements again after a semicolon', async () => {
    const result = await complete(
      DOCS(`    match /a/{b} {\n      allow read: if true; al${CARET}\n    }`),
    )
    expect(labels(result)).toContain('allow')
  })

  it('waits for a letter unless asked', async () => {
    expect(await complete(DOCS(`    match /a/{b} {\n      ${CARET}\n    }`))).toBeNull()
  })

  it('offers the product name after service and the root after match', async () => {
    expect(labels(await complete(`service ${CARET}`, { explicit: true }))).toEqual([
      'cloud.firestore',
    ])
    expect(labels(await complete(`service cloud.fi${CARET}`))).toEqual(['firestore'])
    expect(
      labels(await complete(`service cloud.firestore {\n  match ${CARET}`, { explicit: true })),
    ).toEqual(['/databases/{database}/documents'])
  })
})

describe('allow', () => {
  it('offers the operations after allow', async () => {
    const result = await complete(DOCS(`    match /a/{b} {\n      allow ${CARET}`), {
      explicit: true,
    })
    expect(labels(result)).toEqual(['read', 'write', 'get', 'list', 'create', 'update', 'delete'])
    expect(option(result, 'read').detail).toBe('get + list')
    expect(option(result, 'write').detail).toBe('create + update + delete')
  })

  it('leaves out the operations already listed', async () => {
    const result = await complete(DOCS(`    match /a/{b} {\n      allow read, cr${CARET}`))
    expect(labels(result)).not.toContain('read')
    expect(labels(result)).toContain('create')
  })

  it('offers if after the colon', async () => {
    expect(
      labels(
        await complete(DOCS(`    match /a/{b} {\n      allow read: ${CARET}`), { explicit: true }),
      ),
    ).toEqual(['if'])
  })
})

describe('members', () => {
  it('lists the request', async () => {
    const result = await complete(ORDERS(`request.${CARET}`))
    expect(labels(result)).toEqual(['auth', 'method', 'path', 'query', 'resource', 'time'])
    expect(option(result, 'time').detail).toBe('timestamp')
    expect(option(result, 'resource').info).toMatch(/write/)
  })

  it('lists auth, the token and its firebase claims', async () => {
    expect(labels(await complete(ORDERS(`request.auth.${CARET}`)))).toEqual(['uid', 'token'])
    const token = await complete(ORDERS(`request.auth.token.${CARET}`), {
      options: { claims: () => ['admin', 'role', 'email', 'https://example.test/tier'] },
    })
    expect(labels(token)).toEqual(
      expect.arrayContaining([
        'email',
        'email_verified',
        'phone_number',
        'name',
        'sub',
        'firebase.sign_in_provider',
        'firebase.identities',
        'firebase.tenant',
        'iat',
        'exp',
        'auth_time',
        'admin',
        'role',
        'https://example.test/tier',
        'keys',
      ]),
    )
    // A custom claim that repeats a standard one is offered once.
    expect(labels(token).filter((label) => label === 'email')).toHaveLength(1)
    expect(option(token, 'admin').detail).toBe('custom claim')
    expect(top(token)).not.toContain('keys')
    expect(labels(await complete(ORDERS(`request.auth.token.firebase.${CARET}`)))).toEqual([
      'sign_in_provider',
      'identities',
      'tenant',
    ])
  })

  it('asks for the custom claims each time, and waits for an answer that is on its way', async () => {
    let asked = 0
    const token = await complete(ORDERS(`request.auth.token.${CARET}`), {
      options: {
        claims: async () => {
          asked += 1
          return ['tier']
        },
      },
    })
    expect(asked).toBe(1)
    expect(option(token, 'tier').detail).toBe('custom claim')
    // A source that fails leaves the standard claims.
    const failed = await complete(ORDERS(`request.auth.token.${CARET}`), {
      options: { claims: () => Promise.reject(new Error('Auth is not running')) },
    })
    expect(labels(failed)).toContain('email')
    expect(labels(failed)).not.toContain('tier')
  })

  it('lists the query', async () => {
    expect(labels(await complete(ORDERS(`request.query.${CARET}`)))).toEqual([
      'limit',
      'offset',
      'orderBy',
    ])
  })

  it('lists a resource, the incoming one and the stored one', async () => {
    expect(labels(await complete(ORDERS(`request.resource.${CARET}`)))).toEqual([
      'data',
      'id',
      '__name__',
    ])
    expect(labels(await complete(ORDERS(`resource.${CARET}`)))).toEqual(['data', 'id', '__name__'])
  })

  it('narrows to what has been typed after the dot', async () => {
    const source = ORDERS(`request.au${CARET}`)
    const result = await complete(source)
    expect(result?.from).toBe(source.indexOf(CARET) - 'au'.length)
    expect(labels(result)).toContain('auth')
    expect(result?.validFor).toBeInstanceOf(RegExp)
  })
})

/** Options whose `fields` answers with `seen` and records what it was asked. */
function fields(seen: string[]) {
  const asked: string[] = []
  return {
    asked,
    options: {
      fields: (pattern: string) => {
        asked.push(pattern)
        return seen
      },
    },
  }
}

describe('document fields', () => {
  it("offers the fields of the enclosing match's collection, then the map's methods", async () => {
    const { asked, options } = fields(['total', 'status', 'address', 'address.city', 'items.sku'])
    const result = await complete(ORDERS(`request.resource.data.${CARET}`), { options })
    expect(asked).toEqual(['users/*/orders'])
    expect(labels(result).slice(0, 4)).toEqual(['total', 'status', 'address', 'items'])
    expect(labels(result)).toEqual(
      expect.arrayContaining(['diff', 'get', 'keys', 'size', 'values']),
    )
    expect(top(result)).toEqual(['total', 'status', 'address', 'items'])
    expect(option(result, 'address').detail).toBe('map field')
    expect(option(result, 'total').detail).toBe('field')
    expect(option(result, 'total').info).toMatch(/users\/\*\/orders/)
  })

  it('offers them after resource.data too', async () => {
    const { asked, options } = fields(['total'])
    expect(labels(await complete(ORDERS(`resource.data.${CARET}`), { options }))).toContain('total')
    expect(asked).toEqual(['users/*/orders'])
  })

  it('waits for fields that arrive later', async () => {
    const pending = complete(ORDERS(`resource.data.${CARET}`), {
      options: { fields: async () => ['total', 'createdAt'] },
    })
    expect(pending).toBeInstanceOf(Promise)
    expect(labels(await pending).slice(0, 2)).toEqual(['total', 'createdAt'])
  })

  it('falls back to the methods when fields fail', async () => {
    const rejected = await complete(ORDERS(`resource.data.${CARET}`), {
      options: { fields: () => Promise.reject(new Error('offline')) },
    })
    expect(labels(rejected)).toEqual(['diff', 'get', 'keys', 'size', 'values'])
    const thrown = await complete(ORDERS(`resource.data.${CARET}`), {
      options: {
        fields: () => {
          throw new Error('broken')
        },
      },
    })
    expect(labels(thrown)).toEqual(['diff', 'get', 'keys', 'size', 'values'])
  })

  it('offers the keys nested in a map field', async () => {
    const { options } = fields(['address', 'address.city', 'address.geo.lat', 'total'])
    const result = await complete(ORDERS(`resource.data.address.${CARET}`), { options })
    expect(labels(result).slice(0, 2)).toEqual(['city', 'geo'])
    expect(labels(result)).toContain('keys')
  })

  it('offers every method below a field not known to be a map', async () => {
    const { options } = fields(['total'])
    const result = await complete(ORDERS(`resource.data.total.${CARET}`), { options })
    expect(labels(result)).toEqual(expect.arrayContaining(['size', 'matches', 'diff', 'toMillis']))
  })

  it('asks for nothing where the document is not known', async () => {
    const { asked, options } = fields(['total'])
    const result = await complete(
      DOCS(`    match /posts/{rest=**} {\n      allow read: if resource.data.${CARET}`),
      { options },
    )
    expect(asked).toEqual([])
    expect(labels(result)).toEqual(['diff', 'get', 'keys', 'size', 'values'])
  })

  it('reads the collection from the path a get() names', async () => {
    const { asked, options } = fields(['role'])
    const result = await complete(
      ORDERS(`get(/databases/$(database)/documents/users/$(request.auth.uid)).data.${CARET}`),
      { options },
    )
    expect(asked).toEqual(['users'])
    expect(labels(result)[0]).toBe('role')
  })
})

describe('globals and namespaces', () => {
  it('offers the variables, functions and namespaces in a condition', async () => {
    const result = await complete(ORDERS(CARET), { explicit: true })
    expect(labels(result)).toEqual(
      expect.arrayContaining([
        'request',
        'resource',
        'get',
        'exists',
        'getAfter',
        'existsAfter',
        'debug',
        'math',
        'timestamp',
        'duration',
        'latlng',
        'hashing',
        'true',
        'false',
        'null',
      ]),
    )
    expect(option(result, 'get').detail).toBe('(path) → Resource')
    expect(option(result, 'exists').detail).toBe('(path) → bool')
    for (const o of result!.options) expect(typeof o.info).toBe('string')
  })

  it('lists each namespace', async () => {
    expect(labels(await complete(ORDERS(`math.${CARET}`)))).toEqual([
      'abs',
      'ceil',
      'floor',
      'round',
      'sqrt',
      'pow',
      'isInfinite',
      'isNaN',
    ])
    expect(labels(await complete(ORDERS(`timestamp.${CARET}`)))).toEqual(['date', 'value'])
    expect(labels(await complete(ORDERS(`duration.${CARET}`)))).toEqual(['abs', 'time', 'value'])
    expect(labels(await complete(ORDERS(`latlng.${CARET}`)))).toEqual(['value'])
    expect(labels(await complete(ORDERS(`hashing.${CARET}`)))).toEqual([
      'crc32',
      'crc32c',
      'md5',
      'sha256',
    ])
    const pow = option(await complete(ORDERS(`math.${CARET}`)), 'pow')
    expect(pow.detail).toBe('(base, exponent) → float')
  })
})

describe('methods', () => {
  const STRING = ['size', 'matches', 'lower', 'upper', 'split', 'trim', 'replace', 'toUtf8']
  const LIST = ['concat', 'hasAll', 'hasAny', 'hasOnly', 'join', 'removeAll', 'size', 'toSet']
  const DIFF = ['addedKeys', 'affectedKeys', 'changedKeys', 'removedKeys', 'unchangedKeys']
  const SET = ['difference', 'hasAll', 'hasAny', 'hasOnly', 'intersection', 'size', 'union']
  const TIMESTAMP = [
    'date',
    'day',
    'dayOfWeek',
    'dayOfYear',
    'hours',
    'minutes',
    'month',
    'nanos',
    'seconds',
    'time',
    'toMillis',
    'year',
  ]

  it('offers every method on an expression of unknown type', async () => {
    const result = await complete(ORDERS(`someValue.${CARET}`))
    expect(labels(result)).toEqual(
      expect.arrayContaining([...STRING, ...LIST, ...DIFF, ...SET, ...TIMESTAMP, 'keys', 'values']),
    )
    // Each name once, with the types that have it.
    expect(labels(result).filter((label) => label === 'size')).toHaveLength(1)
    expect(option(result, 'size').detail).toMatch(/string, list, map, set/)
  })

  it('ranks the methods of a recognised receiver first', async () => {
    expect(top(await complete(ORDERS(`request.auth.uid.${CARET}`)))).toEqual(STRING)
    expect(
      top(await complete(ORDERS(`request.resource.data.diff(resource.data).${CARET}`))),
    ).toEqual(DIFF)
    expect(top(await complete(ORDERS(`someMap.diff(other).affectedKeys().${CARET}`)))).toEqual(SET)
    expect(top(await complete(ORDERS(`resource.data.keys().${CARET}`)))).toEqual(LIST)
    expect(top(await complete(ORDERS(`request.time.${CARET}`)))).toEqual(TIMESTAMP)
    expect(top(await complete(ORDERS(`duration.value(1, 'd').${CARET}`)))).toEqual([
      'nanos',
      'seconds',
    ])
    expect(top(await complete(ORDERS(`'abc'.${CARET}`)))).toEqual(STRING)
    expect(top(await complete(ORDERS(`['a', 'b'].${CARET}`)))).toEqual(LIST)
    // The rest are still there, below.
    expect(labels(await complete(ORDERS(`request.auth.uid.${CARET}`)))).toContain('toMillis')
  })

  it('follows a recursive wildcard as a path and the others as strings', async () => {
    expect(
      top(await complete(DOCS(`    match /posts/{rest=**} {\n      allow read: if rest.${CARET}`))),
    ).toEqual(['bind'])
    expect(top(await complete(ORDERS(`orderId.${CARET}`)))).toEqual(STRING)
  })

  it('offers nothing after a number', async () => {
    expect(await complete(ORDERS(`request.time.toMillis().${CARET}`))).toBeNull()
  })

  it('describes each method from the reference', async () => {
    const diff = await complete(ORDERS(`a.diff(b).${CARET}`))
    expect(option(diff, 'affectedKeys').info).toMatch(/added, removed or changed/)
    expect(option(diff, 'affectedKeys').detail).toBe('() → set')
    const text = await complete(ORDERS(`request.auth.uid.${CARET}`))
    expect(option(text, 'matches').detail).toBe('(re) → bool')
    expect(option(text, 'matches').info).toMatch(/RE2/)
  })
})

describe('names in scope', () => {
  it('offers the wildcards of every enclosing match', async () => {
    const result = await complete(ORDERS(CARET), { explicit: true })
    expect(labels(result)).toEqual(expect.arrayContaining(['database', 'uid', 'orderId']))
    expect(option(result, 'uid').info).toMatch(/match \/users\/\{uid\}/)
  })

  it('offers the functions declared around, and not those in a sibling match', async () => {
    const result = await complete(ORDERS(CARET), { explicit: true })
    expect(labels(result)).toEqual(expect.arrayContaining(['signedIn', 'isOwner']))
    expect(labels(result)).not.toContain('isAdmin')
    expect(option(result, 'isOwner').type).toBe('function')
  })

  it('does not offer a function inside itself', async () => {
    const result = await complete(
      DOCS(`    function a() { return b(); }\n    function b() { return ${CARET} }`),
      { explicit: true },
    )
    expect(labels(result)).toContain('a')
    expect(labels(result)).not.toContain('b')
  })

  it("offers a function's parameters and the lets before the cursor", async () => {
    const result = await complete(
      DOCS(
        `    function f(user, doc) {\n      let owner = doc.owner;\n      let later = 1;\n      return o${CARET}`,
      ),
    )
    expect(labels(result)).toEqual(expect.arrayContaining(['user', 'doc', 'owner', 'later']))
    const half = await complete(
      DOCS(`    function f(user) {\n      let owner = user == ${CARET}`),
      { explicit: true },
    )
    expect(labels(half)).toContain('user')
    expect(labels(half)).not.toContain('owner')
  })

  it('offers in and is after an operand, and types after is', async () => {
    expect(labels(await complete(ORDERS(`uid i${CARET}`)))).toEqual(['in', 'is'])
    expect(labels(await complete(ORDERS(`uid is ${CARET}`), { explicit: true }))).toEqual([
      'bool',
      'int',
      'float',
      'number',
      'string',
      'list',
      'map',
      'timestamp',
      'duration',
      'path',
      'latlng',
    ])
  })
})

describe('where completion stays quiet', () => {
  it('says nothing in comments, strings or paths', async () => {
    expect(await complete(ORDERS(`true // request.${CARET}`))).toBeNull()
    expect(await complete(ORDERS(`true /* request.${CARET} */`))).toBeNull()
    expect(await complete(ORDERS(`x == 'request.${CARET}'`))).toBeNull()
    expect(await complete(ORDERS(`exists(/databases/abc${CARET})`))).toBeNull()
    expect(await complete(DOCS(`    match /us${CARET}`))).toBeNull()
  })

  it('answers again after a closed string', async () => {
    expect(labels(await complete(ORDERS(`'abc'.${CARET}`)))).toContain('size')
  })

  it('says nothing where a name is being declared', async () => {
    expect(await complete(DOCS(`    function is${CARET}`))).toBeNull()
    expect(await complete(DOCS(`    function f(us${CARET}`))).toBeNull()
    expect(await complete(DOCS(`    function f() { let ow${CARET}`))).toBeNull()
  })
})

describe('applying a completion', () => {
  let view: EditorView | null = null
  afterEach(() => {
    view?.destroy()
    view = null
  })

  async function apply(
    source: string,
    label: string,
    { options = {}, detail }: { options?: RulesLanguageOptions; detail?: string } = {},
  ) {
    const result = await complete(source, { options, explicit: true })
    const picked = option(result, label, detail)
    const { state, pos } = stateAt(source, options)
    view = new EditorView({ state, parent: document.body })
    if (typeof picked.apply === 'function') picked.apply(view, picked, result!.from, pos)
    else
      view.dispatch({
        changes: { from: result!.from, to: pos, insert: picked.apply ?? picked.label },
      })
    const { main } = view.state.selection
    return { doc: view.state.doc.toString(), selected: view.state.sliceDoc(main.from, main.to) }
  }

  it('writes a call with its parameters to fill in', async () => {
    const { doc, selected } = await apply(ORDERS(`math.p${CARET}`), 'pow')
    expect(doc).toContain('math.pow(base, exponent)')
    expect(selected).toBe('base')
  })

  it('writes the document path for get()', async () => {
    const { doc, selected } = await apply(ORDERS(`ge${CARET}`), 'get')
    expect(doc).toContain('get(/databases/$(database)/documents/path)')
    expect(selected).toBe('path')
  })

  it('writes just the name when a parenthesis follows', async () => {
    const { doc } = await apply(ORDERS(`exi${CARET}(x)`), 'exists')
    expect(doc).toContain('if exists(x);')
  })

  it('reaches a field that is not a name by index', async () => {
    const { doc } = await apply(ORDERS(`resource.data.${CARET}`), 'first-name', {
      options: { fields: () => ['first-name'] },
    })
    expect(doc).toContain("if resource.data['first-name'];")
  })

  it('expands a statement snippet with indentation', async () => {
    const { doc, selected } = await apply(
      DOCS(`    match /a/{b} {\n      ${CARET}\n    }`),
      'match',
      {
        detail: '/…/{…} { … }',
      },
    )
    expect(doc).toContain(
      'match /a/{b} {\n      match /collection/{document} {\n        \n      }\n    }',
    )
    expect(selected).toBe('collection')
  })

  it('writes an allow statement with its operation selected', async () => {
    const { doc, selected } = await apply(
      DOCS(`    match /a/{b} {\n      al${CARET}\n    }`),
      'allow',
      {
        detail: '…: if …;',
      },
    )
    expect(doc).toContain('      allow read: if condition;\n')
    expect(selected).toBe('read')
  })

  it('writes a user function with its parameters', async () => {
    const { doc, selected } = await apply(
      DOCS(
        `    function owns(user, doc) { return true; }\n    match /a/{b} {\n      allow read: if ow${CARET}`,
      ),
      'owns',
    )
    expect(doc).toContain('allow read: if owns(user, doc)')
    expect(selected).toBe('user')
  })
})

const BUCKET = (body: string) =>
  `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${body}\n  }\n}\n`

const USERS = (condition: string) =>
  BUCKET(`    match /users/{uid}/{allPaths=**} {\n      allow write: if ${condition};\n    }`)

describe('the Storage dialect', () => {
  const storage: RulesLanguageOptions = { dialect: 'storage' }

  it('is read from the service header when the page does not say', () => {
    expect(dialectOf(outline(BUCKET('')))).toBe('storage')
    expect(dialectOf(outline('service cloud.firestore {}'))).toBe('firestore')
    expect(dialectOf(outline(''))).toBe('firestore')
  })

  it('offers the Storage service, its name and its root', async () => {
    const header = await complete(CARET, { explicit: true, options: storage })
    expect(option(header, 'service', 'firebase.storage { … }').info).toMatch(/firebase.storage/)
    expect(
      labels(await complete(`service ${CARET}`, { explicit: true, options: storage })),
    ).toEqual(['firebase.storage'])
    expect(labels(await complete(`service firebase.st${CARET}`))).toEqual(['storage'])
    expect(
      labels(await complete(`service firebase.storage {\n  match ${CARET}`, { explicit: true })),
    ).toEqual(['/b/{bucket}/o'])
    const inService = await complete(`service firebase.storage {\n  m${CARET}\n}`)
    expect(option(inService, 'match', '/b/{bucket}/o { … }')).toBeTruthy()
    expect(option(inService, 'match').info).toMatch(/files/)
  })

  it('names the operations in terms of files', async () => {
    const result = await complete(BUCKET(`    match /a/{b} {\n      allow ${CARET}`), {
      explicit: true,
    })
    expect(option(result, 'create').info).toMatch(/Uploading a file/)
    expect(option(result, 'list').info).toMatch(/listAll/)
    expect(option(result, 'update').info).toMatch(/metadata/)
  })

  it('reads request.resource as the file an upload proposes, not a document', async () => {
    const result = await complete(USERS(`request.resource.${CARET}`))
    expect(labels(result)).toEqual(expect.arrayContaining(['size', 'contentType', 'metadata']))
    expect(labels(result)).not.toContain('data')
    expect(option(result, 'size').detail).toBe('int')
  })

  it('reads resource as the file with the fourteen keys the rules see', async () => {
    const result = await complete(USERS(`resource.${CARET}`))
    expect(new Set(labels(result))).toEqual(
      new Set([
        'name',
        'bucket',
        'size',
        'contentType',
        'contentDisposition',
        'contentEncoding',
        'metadata',
        'generation',
        'metageneration',
        'timeCreated',
        'updated',
        'md5Hash',
        'crc32c',
        'etag',
      ]),
    )
  })

  it('has a request without a query', async () => {
    const result = await complete(USERS(`request.${CARET}`))
    expect(new Set(labels(result))).toEqual(new Set(['auth', 'method', 'path', 'resource', 'time']))
  })

  it('offers custom metadata keys sampled from the folder the match starts with', async () => {
    const asked: string[] = []
    const options: RulesLanguageOptions = {
      metadataKeys: async (prefix) => {
        asked.push(prefix)
        return ['ownerUid', 'source', 'has-dash']
      },
    }
    const result = await complete(USERS(`request.resource.metadata.${CARET}`), { options })
    expect(asked).toEqual(['users/'])
    expect(labels(result)).toEqual(expect.arrayContaining(['ownerUid', 'source', 'has-dash']))
    expect(option(result, 'ownerUid').detail).toBe('metadata key')
    expect(labels(result)).toEqual(expect.arrayContaining(['keys', 'size']))
    const atRoot = await complete(
      BUCKET(`    match /{file} {\n      allow read: if resource.metadata.${CARET}`),
      { options },
    )
    expect(asked.at(-1)).toBe('')
    expect(labels(atRoot)).toContain('ownerUid')
  })

  it('reads Firestore through firestore.get and firestore.exists, not get() and exists()', async () => {
    const globals = await complete(USERS(CARET), { explicit: true })
    expect(labels(globals)).toEqual(expect.arrayContaining(['request', 'resource', 'firestore']))
    for (const gone of ['get', 'exists', 'getAfter', 'existsAfter'])
      expect(labels(globals)).not.toContain(gone)
    const namespace = await complete(USERS(`firestore.${CARET}`))
    expect(new Set(labels(namespace))).toEqual(new Set(['get', 'exists']))
    const read = await complete(
      USERS(`firestore.get(/databases/(default)/documents/users/$(uid)).${CARET}`),
    )
    expect(labels(read)).toEqual(expect.arrayContaining(['data', 'id']))
  })

  it('keeps the Storage names out of Firestore rules', async () => {
    const result = await complete(ORDERS(CARET), { explicit: true })
    expect(labels(result)).not.toContain('firestore')
    expect(labels(await complete(ORDERS(`request.resource.${CARET}`)))).toContain('data')
    expect(labels(await complete(ORDERS(`resource.${CARET}`)))).not.toContain('contentType')
  })

  it('writes the document path for firestore.get()', async () => {
    const source = USERS(`firestore.g${CARET}`)
    const result = await complete(source)
    const picked = option(result, 'get')
    const { state, pos } = stateAt(source)
    const view = new EditorView({ state, parent: document.body })
    try {
      if (typeof picked.apply === 'function') picked.apply(view, picked, result!.from, pos)
      const { main } = view.state.selection
      expect(view.state.doc.toString()).toContain(
        'firestore.get(/databases/(default)/documents/path)',
      )
      expect(view.state.sliceDoc(main.from, main.to)).toBe('path')
    } finally {
      view.destroy()
    }
  })
})
