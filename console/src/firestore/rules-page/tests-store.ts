// Firestore's saved rules tests: the rules kit's store and runner
// (`src/rules/tests-core.ts`) over the playground's form. Kept per project
// and database in this browser, run against the text in the editor every
// time it changes, exported as a `@firebase/rules-unit-testing` file.

import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { EvaluateResult } from '@/api/generated/EvaluateResult'
import type { FirestoreRestValue } from '@/api/generated/FirestoreRestValue'
import { useStore } from 'zustand'
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
import { evaluateRules } from './api'
import { type PlaygroundForm, toEvaluateRequest } from './requests'

export { passes }

export interface TestCase extends TestCaseBase {
  form: PlaygroundForm
  /** The document as it was when the case was saved, for an exported test to set up. */
  seed?: Record<string, FirestoreRestValue> | null | undefined
}

export type TestOutcome = KitOutcome<EvaluateResult>

/** Whether a stored or imported item is a case this page can run. */
export function isTestCase(item: unknown): item is TestCase {
  return Boolean(item && typeof item === 'object' && 'form' in item && 'expected' in item)
}

/** The saved cases of the database on screen. */
export const testsStore = createTestsStore<TestCase, EvaluateResult>((item) =>
  Boolean(item && typeof item === 'object' && (item as { form?: unknown }).form),
)

/** The saved tests' state, for a component. */
export function useTests<T>(selector: (state: TestsState<TestCase, EvaluateResult>) => T): T {
  return useStore(testsStore, selector)
}

export function testsKey(project: string, database: string): string {
  return `firenook.console.rules-tests.${project}.${database}`
}

function runner(
  project: string,
  database: string,
): TestRunner<TestCase, EvaluateRequest, EvaluateResult> {
  return {
    build: (test) => toEvaluateRequest(test.form, project, database),
    evaluate: (requests, source) => evaluateRules(database, requests, source),
  }
}

/** Run every saved case against `source`, now. */
export function runTests(project: string, database: string, source: string): Promise<void> {
  return runKitTests(testsStore, runner(project, database), source)
}

/**
 * Keeps the saved cases loaded and run against the editor's text: on
 * arrival, and again shortly after each edit or each change to the cases.
 */
export function useTestRunner(project: string, database: string, source: string, ready: boolean) {
  useKitTestRunner(testsStore, testsKey(project, database), source, ready, (text) =>
    runTests(project, database, text),
  )
}

/** How the saved cases fare against `source`; undefined until they have run on it. */
export function useTestSummary(source: string): { total: number; failing: number } | undefined {
  return useKitTestSummary(testsStore, source)
}
