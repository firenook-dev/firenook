// A draft checked as it is typed: the compiler's errors and the engine's
// warnings, where they are, before anything is applied.
//
// Only a text the page has loaded is ever checked. The editor holds an
// empty text until the rules arrive, and a check of that text answered
// `1:1 expected "service"`, which the Problems strip showed for the second
// before the real rules replaced it — on every visit. So a scope's first
// loaded text is checked at once, and every later text once it settles
// (300 ms); a text from before the rules arrived, or from the scope the
// picker just left, is never sent.

import {
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
} from '@tanstack/react-query'
import type { CodeMark } from '@/components/code-editor'
import type { RulesDraft } from './draft'
import { type Problem, problemsOf } from './problems'
import { type RulesDiagnostic, offsetOf } from './text'
import { useDebounced } from './use-debounced'

/** How long typing must pause before the text is checked, ms. */
export const CHECK_DELAY_MS = 300

/** What every rules check answers with. */
export interface RulesCheckLike {
  diagnostics: RulesDiagnostic[]
}

export interface RulesCheckState<C extends RulesCheckLike> {
  /** The text the check is about; undefined until the scope's rules have loaded. */
  checked: string | undefined
  check: UseQueryResult<C, Error>
  /** Errors first, then warnings, each once (the last Apply's refusal included). */
  problems: Problem[]
  /** The problems as editor marks, while the editor holds the text they are about. */
  marks: CodeMark[]
  /** An edited draft, checked as it is now, that compiles: what impact is asked of. */
  compiles: boolean
}

/** The separator between the scope and the text in the settled key; neither holds it. */
const SEPARATOR = '\u0000'

/**
 * The text to check now: `undefined` before the scope's rules have loaded,
 * the loaded text at once when the settled one is from before (or from
 * another scope), and otherwise the settled one.
 */
export function textToCheck(
  scope: string,
  current: string | undefined,
  settled: string | undefined,
): string | undefined {
  const prefix = `${scope}${SEPARATOR}`
  const key = settled !== undefined && settled.startsWith(prefix) ? settled : current
  return key === undefined ? undefined : key.slice(prefix.length)
}

export function useRulesCheck<C extends RulesCheckLike, K extends QueryKey>(
  draft: RulesDraft,
  /** The scope the draft is of (a database, a bucket); a new scope is checked at once. */
  scope: string,
  checkQuery: (source: string) => UseQueryOptions<C, Error, C, K>,
): RulesCheckState<C> {
  const current = draft.rules.isSuccess ? `${scope}${SEPARATOR}${draft.source}` : undefined
  const settled = useDebounced(current, CHECK_DELAY_MS)
  const checked = textToCheck(scope, current, settled)
  const check = useQuery({ ...checkQuery(checked ?? ''), enabled: checked !== undefined })
  const diagnostics = check.data?.diagnostics ?? []
  const problems = problemsOf(diagnostics, draft.rejected)
  const marks: CodeMark[] =
    checked === draft.source
      ? problems.map((problem) => {
          const from = problem.from ?? offsetOf(draft.source, problem)
          return {
            from,
            to: problem.to ?? from,
            severity: problem.severity === 'warning' ? 'warning' : 'error',
            message: problem.message,
          }
        })
      : []
  const compiles =
    draft.edited &&
    checked === draft.source &&
    check.data !== undefined &&
    !check.data.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  return { checked, check, problems, marks, compiles }
}
