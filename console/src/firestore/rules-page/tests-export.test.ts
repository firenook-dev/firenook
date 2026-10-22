import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ViewAs } from '@/lib/identity'
import { EMPTY_FORM, type PlaygroundForm } from './requests'
import { exportTests } from './tests-export'
import type { TestCase } from './tests-store'

// The exported file the conformance suite runs with `@firebase/rules-unit-testing`
// against the engine and the official emulator
// (`conformance/src/rules/run-rules-unit-testing.ts`). Rewrite it after a
// deliberate change to the export with UPDATE_CONFORMANCE_EXPORTS=1.
// This file's folder, under `console/src` (the test DOM gives `import.meta.url` an http scheme).
const CONFORMANCE_EXPORT = join(
  import.meta.dirname,
  '../../../../conformance/fixtures/rules-unit-testing-v1/console-firestore.test.ts',
)

const as = (viewAs: ViewAs) => ({ kind: 'as', viewAs }) as const
const alice = as({ kind: 'custom', uid: 'alice', claims: {} })
const bob = as({ kind: 'custom', uid: 'bob', claims: {} })
const carol = as({ kind: 'custom', uid: 'carol', claims: { admin: true } })
const anonymous = as({ kind: 'anonymous' })

function test(
  name: string,
  form: Partial<PlaygroundForm>,
  expected: 'allow' | 'deny',
  seed?: TestCase['seed'],
): TestCase {
  return { id: name, name, expected, form: { ...EMPTY_FORM, ...form }, seed }
}

const profile = { name: { stringValue: 'Alice' } }
const post = { author: { stringValue: 'alice' }, title: { stringValue: 'Hello' } }

const CASES: TestCase[] = [
  test('alice reads her profile', { path: 'users/alice', who: alice }, 'allow', profile),
  test('bob reads alice', { path: 'users/alice', who: bob }, 'deny', profile),
  test('signed out reads alice', { path: 'users/alice', who: anonymous }, 'deny', profile),
  test('signed out reads a post', { path: 'posts/p1', who: anonymous }, 'allow', post),
  test(
    'alice posts as herself',
    { method: 'create', path: 'posts/p2', data: '{"author":"alice","title":"Hi"}', who: alice },
    'allow',
  ),
  test(
    'alice posts as bob',
    { method: 'create', path: 'posts/p3', data: '{"author":"bob","title":"Hi"}', who: alice },
    'deny',
  ),
  test(
    'bob edits alice',
    { method: 'update', path: 'posts/p1', data: '{"title":"Mine"}', who: bob },
    'deny',
    post,
  ),
  test('an admin reads settings', { path: 'admin/settings', who: carol }, 'allow', {
    open: { booleanValue: true },
  }),
  test('alice reads settings', { path: 'admin/settings', who: alice }, 'deny', {
    open: { booleanValue: true },
  }),
  test('signed out lists posts', { method: 'list', path: 'posts', who: anonymous }, 'allow'),
  test('signed out lists users', { method: 'list', path: 'users', who: anonymous }, 'deny'),
]

describe('the Firestore tests as a rules-unit-testing file', () => {
  const file = exportTests(CASES, {
    project: 'demo-firenook-rules-testing',
    rulesFile: 'firestore.rules',
  })

  it('is the file the conformance suite runs against the engine', () => {
    if (process.env.UPDATE_CONFORMANCE_EXPORTS === '1') writeFileSync(CONFORMANCE_EXPORT, file)
    expect(file).toBe(readFileSync(CONFORMANCE_EXPORT, 'utf8'))
  })

  it('asserts each verdict as the identity the case names', () => {
    expect(file).toContain('const db = env.authenticatedContext("alice", {}).firestore()')
    expect(file).toContain('const db = env.unauthenticatedContext().firestore()')
    expect(file).toContain(
      'const db = env.authenticatedContext("carol", {"admin":true}).firestore()',
    )
    expect(file).toContain('await assertFails(getDoc(doc(db, "users/alice")))')
    expect(file).toContain('await assertSucceeds(getDocs(collection(db, "posts")))')
  })
})
