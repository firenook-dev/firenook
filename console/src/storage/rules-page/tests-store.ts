// Storage's saved rules tests: the rules kit's store and runner
// (`src/rules/tests-core.ts`) over the playground's form. Kept per project
// and rules scope in this browser, run against the text in the editor every
// time it changes, exported as a `@firebase/rules-unit-testing` file.

import { useStore } from 'zustand'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageEvaluateResult } from '@/api/generated/storage/StorageEvaluateResult'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import {
  type TestCaseBase,
  type TestOutcome as KitOutcome,
  type TestRunner,
  type TestsState,
  createTestsStore,
  passes,
  runTests as runKitTests,
  useTestRunner as useKitTestRunner,
  useTestSummary as useKitTestSummary,
} from '@/rules/tests-core'
import { evaluateRules } from '../api'
import { scopeBucket } from '../queries'
import { type PlaygroundForm, toEvaluateRequest } from './requests'

export { passes }

export interface TestCase extends TestCaseBase {
  form: PlaygroundForm
  /** The file as it was when the case was saved, for an exported test to upload first. */
  seed?: StorageRulesObjectView | null | undefined
}

export type TestOutcome = KitOutcome<StorageEvaluateResult>

/** Whether a stored or imported item is a case this page can run. */
export function isTestCase(item: unknown): item is TestCase {
  if (!item || typeof item !== 'object') return false
  const { form, expected, name } = item as { form?: unknown; expected?: unknown; name?: unknown }
  return (
    Boolean(form && typeof form === 'object' && 'method' in form && 'path' in form) &&
    (expected === 'allow' || expected === 'deny') &&
    typeof name === 'string'
  )
}

/** The saved cases of the rules scope on screen. */
export const testsStore = createTestsStore<TestCase, StorageEvaluateResult>(isTestCase)

/** The saved tests' state, for a component. */
export function useTests<T>(
  selector: (state: TestsState<TestCase, StorageEvaluateResult>) => T,
): T {
  return useStore(testsStore, selector)
}

export function testsKey(project: string, scope: string): string {
  return `firenook.console.storage-rules-tests.${project}.${scope}`
}

function runner(
  project: string,
  scope: string,
  bucket: string,
): TestRunner<TestCase, StorageEvaluateRequest, StorageEvaluateResult> {
  const named = scopeBucket(scope)
  return {
    build: (test) => toEvaluateRequest(test.form, project, bucket),
    evaluate: (requests, source) =>
      evaluateRules(
        named === undefined ? { source, requests } : { bucket: named, source, requests },
      ),
  }
}

/** Run every saved case against `source`, now. */
export function runTests(
  project: string,
  scope: string,
  bucket: string,
  source: string,
): Promise<void> {
  return runKitTests(testsStore, runner(project, scope, bucket), source)
}

/**
 * Keeps the saved cases loaded and run against the editor's text: on
 * arrival, and again shortly after each edit or each change to the cases.
 */
export function useTestRunner(
  project: string,
  scope: string,
  bucket: string,
  source: string,
  ready: boolean,
) {
  useKitTestRunner(testsStore, testsKey(project, scope), source, ready, (text) =>
    runTests(project, scope, bucket, text),
  )
}

/** How the saved cases fare against `source`; undefined until they have run on it. */
export function useTestSummary(source: string): { total: number; failing: number } | undefined {
  return useKitTestSummary(testsStore, source)
}
