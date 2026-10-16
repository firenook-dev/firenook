import { describe, expect, it } from 'vitest'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden.test-support'
import { TASK_FIELDS } from './components/filter-line'
import cases from './task-filter-cases.json'

// The task filter's cases (Tasks and History), which the engine runs
// through the same harness (`filter::golden::run`).
describe('the task filter', () => {
  const count = runGoldenCases(cases as GoldenFile)
  it('covers every field of the page', () => {
    expect(count).toBeGreaterThan(0)
    expect((cases as GoldenFile).fields.map((field) => field.key)).toEqual(['name', 'is'])
  })
})

describe('the filter field before the list metadata arrives', () => {
  it('uses the very fields the engine serves', () => {
    const golden = (cases as GoldenFile).fields.map((field) => ({
      key: field.key,
      aliases: field.aliases ?? [],
      kind: field.kind,
      values: field.values ?? [],
    }))
    expect(
      TASK_FIELDS.map((field) => ({
        key: field.key,
        aliases: field.aliases ?? [],
        kind: field.kind,
        values: field.values ?? [],
      })),
    ).toEqual(golden)
  })
})
