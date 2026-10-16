// The Problems strip under a rules editor: every error and warning in the
// text, once, each a way to its place (and F8 / Shift+F8 walk them). It is
// the one place a warning is listed; the map panels beside the editor list
// the data, not the warnings again.

import { WarningIcon } from '@phosphor-icons/react'
import { describeDiagnostic } from './text'

export interface Problem {
  severity: string
  message: string
  line: number
  column: number
  from?: number | undefined
  to?: number | undefined
  code?: string | null | undefined
}

/**
 * Everything wrong with the text, once: what the engine's check finds as
 * it is typed, and what the last Apply refused (the same errors, usually,
 * but an Apply can be refused for reasons a check does not see). Errors
 * first, then by line.
 */
export function problemsOf(checked: readonly Problem[], rejected: readonly Problem[]): Problem[] {
  const seen = new Set<string>()
  const out: Problem[] = []
  for (const problem of [...checked, ...rejected]) {
    const key = `${problem.line}:${problem.column}:${problem.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(problem)
  }
  return out.toSorted((left, right) =>
    left.severity === right.severity ? left.line - right.line : left.severity === 'error' ? -1 : 1,
  )
}

/**
 * The problem after (or, `backwards`, before) the caret's line, wrapping at
 * either end; undefined when there are none.
 */
export function nextProblem(
  problems: readonly Problem[],
  line: number | undefined,
  backwards = false,
): Problem | undefined {
  if (problems.length === 0) return undefined
  const ordered = problems.toSorted((left, right) => left.line - right.line)
  if (line === undefined) return backwards ? ordered.at(-1) : ordered[0]
  return backwards
    ? (ordered.findLast((problem) => problem.line < line) ?? ordered.at(-1))
    : (ordered.find((problem) => problem.line > line) ?? ordered[0])
}

/** Every problem in the text, each a way to its place. */
export function Problems({
  problems,
  onJump,
}: {
  problems: readonly Problem[]
  onJump: (line: number) => void
}) {
  if (problems.length === 0) return null
  const errors = problems.some((problem) => problem.severity === 'error')
  return (
    <ul
      className={`max-h-36 shrink-0 overflow-y-auto border-t ${
        errors ? 'border-kumo-danger bg-kumo-danger-tint' : 'border-kumo-line bg-kumo-warning-tint'
      }`}
      data-testid="rules-diagnostics"
    >
      {problems.map((problem) => (
        <li key={`${problem.line}:${problem.column}:${problem.message}`}>
          <button
            type="button"
            onClick={() => onJump(problem.line)}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:ink"
            data-testid="rules-problem"
            data-severity={problem.severity}
            data-code={problem.code ?? undefined}
          >
            <span
              className={`flex h-lh shrink-0 items-center ${
                problem.severity === 'error' ? 'text-kumo-danger' : 'text-kumo-warning'
              }`}
            >
              <WarningIcon size={14} />
            </span>
            <span className="font-mono text-[12px] text-kumo-default">
              {describeDiagnostic(problem)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
