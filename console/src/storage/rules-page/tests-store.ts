// Storage's saved rules tests: the rules kit's store and runner
// (`src/rules/tests-core.ts`) over the playground's form. Kept per project
// and rules scope in this browser, run against the text in the editor every
// time it changes, exported as a `@firebase/rules-unit-testing` file.

import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageEvaluateResult } from '@/api/generated/storage/StorageEvaluateResult'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { type TestCaseBase, createRulesTests } from '@/rules/tests-core'
import { evaluateRules } from '../api'
import { scopeBucket } from '../queries'
import { type PlaygroundForm, toEvaluateRequest } from './requests'

export interface TestCase extends TestCaseBase {
  form: PlaygroundForm
  /** The file as it was when the case was saved, for an exported test to upload first. */
  seed?: StorageRulesObjectView | null | undefined
}

/** Whether a stored item is a case this page can run. */
function isTestCase(item: unknown): item is TestCase {
  if (!item || typeof item !== 'object') return false
  const { form, expected, name } = item as { form?: unknown; expected?: unknown; name?: unknown }
  return (
    Boolean(form && typeof form === 'object' && 'method' in form && 'path' in form) &&
    (expected === 'allow' || expected === 'deny') &&
    typeof name === 'string'
  )
}

/** The saved cases of the rules scope on screen, run as the page's requests run. */
export const tests = createRulesTests<
  TestCase,
  StorageEvaluateRequest,
  StorageEvaluateResult,
  { project: string; scope: string; bucket: string }
>({
  valid: isTestCase,
  key: ({ project, scope }) => `firenook.console.storage-rules-tests.${project}.${scope}`,
  runner: ({ project, scope, bucket }) => {
    const named = scopeBucket(scope)
    return {
      build: (test) => toEvaluateRequest(test.form, project, bucket),
      evaluate: (requests, source) =>
        evaluateRules(
          named === undefined ? { source, requests } : { bucket: named, source, requests },
        ),
    }
  },
})
