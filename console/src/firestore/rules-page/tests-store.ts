// Firestore's saved rules tests: the rules kit's store and runner
// (`src/rules/tests-core.ts`) over the playground's form. Kept per project
// and database in this browser, run against the text in the editor every
// time it changes, exported as a `@firebase/rules-unit-testing` file.

import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { EvaluateResult } from '@/api/generated/EvaluateResult'
import type { FirestoreRestValue } from '@/api/generated/FirestoreRestValue'
import { type TestCaseBase, createRulesTests } from '@/rules/tests-core'
import type { Who } from '@/rules/who'
import { evaluateRules } from './api'
import { type PlaygroundForm, toEvaluateRequest } from './requests'

export interface TestCase extends TestCaseBase {
  form: PlaygroundForm
  /** The document as it was when the case was saved, for an exported test to set up. */
  seed?: Record<string, FirestoreRestValue> | null | undefined
}

/** Whether a stored item is a case this page can run. */
function isTestCase(item: unknown): item is TestCase {
  return Boolean(item && typeof item === 'object' && 'form' in item && 'expected' in item)
}

/**
 * A case saved before the playground asked through the console's identity
 * picker: "Not signed in", or a uid with an email and claims typed as JSON,
 * which is the custom identity it always was.
 */
function revive(test: TestCase): TestCase {
  const who = test.form.who as
    | Who
    | { kind: 'anonymous' }
    | {
        kind: 'user'
        uid: string
        email?: string
        claims: string
      }
  if (who.kind === 'anonymous')
    return { ...test, form: { ...test.form, who: { kind: 'as', viewAs: { kind: 'anonymous' } } } }
  if (who.kind !== 'user') return test
  let claims: Record<string, unknown> = {}
  try {
    const parsed: unknown = who.claims.trim() ? JSON.parse(who.claims) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      claims = parsed as Record<string, unknown>
  } catch {
    claims = {}
  }
  return {
    ...test,
    form: {
      ...test.form,
      who: {
        kind: 'as',
        viewAs: {
          kind: 'custom',
          uid: who.uid,
          claims,
          signInProvider: who.email ? 'password' : 'custom',
          ...(who.email ? { email: who.email, emailVerified: true } : {}),
        },
      },
    },
  }
}

/** The saved cases of the database on screen, run as the page's requests run. */
export const tests = createRulesTests<
  TestCase,
  EvaluateRequest,
  EvaluateResult,
  { project: string; database: string }
>({
  valid: isTestCase,
  revive,
  key: ({ project, database }) => `firenook.console.rules-tests.${project}.${database}`,
  runner: ({ project, database }) => ({
    build: (test) => toEvaluateRequest(test.form, project, database),
    evaluate: (requests, source) => evaluateRules(database, requests, source),
  }),
})
