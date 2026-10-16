// Rules as text, and what an engine says about a text: a compile failure
// with the places that caused it, a diagnostic as one line a person can
// scan, and where in the text it sits. Every rules page reads these; each
// service's own endpoints stay with its section.

import { ApiError, parseErrorBody } from '@/api/client'
import type { RulesDiagnostic } from '@/api/generated/RulesDiagnostic'

export type { RulesDiagnostic }

/** A compile failure, with the places in the text that caused it. */
export class RulesCompileError extends ApiError {
  readonly diagnostics: RulesDiagnostic[]
  constructor(message: string, diagnostics: RulesDiagnostic[]) {
    super(400, message, 'invalid-argument')
    this.name = 'RulesCompileError'
    this.diagnostics = diagnostics
  }
}

/**
 * The error a failed rules call answers with: a compile failure (its
 * `diagnostics` beside the error) as a `RulesCompileError`, anything else as
 * the console's `ApiError`.
 */
export async function rulesFailure(response: Response): Promise<ApiError> {
  const fallback = `${response.status} ${response.statusText}`
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // Keep the status line.
    body = undefined
  }
  const parsed = parseErrorBody(response.status, body, fallback)
  const diagnostics =
    typeof body === 'object' && body !== null && 'diagnostics' in body
      ? (body as { diagnostics?: unknown }).diagnostics
      : undefined
  return Array.isArray(diagnostics) && diagnostics.length > 0
    ? new RulesCompileError(parsed.message, diagnostics as RulesDiagnostic[])
    : new ApiError(response.status, parsed.message, parsed.code, parsed.fix)
}

/** The lines of a ruleset, for a gutter that numbers them. */
export function lineCount(source: string): number {
  return source === '' ? 1 : source.split('\n').length
}

/** `3:17 expected '{'` — a diagnostic as one line a person can scan. */
export function describeDiagnostic(
  diagnostic: Pick<RulesDiagnostic, 'line' | 'column' | 'message'>,
): string {
  return `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`
}

/**
 * Where a diagnostic sits in the text, as a character offset, so the editor
 * can put the caret on it. Out-of-range positions clamp to the end rather
 * than throwing: a diagnostic is a hint, not a contract.
 */
export function offsetOf(
  source: string,
  diagnostic: Pick<RulesDiagnostic, 'line' | 'column'>,
): number {
  const lines = source.split('\n')
  let offset = 0
  for (let index = 0; index < diagnostic.line - 1 && index < lines.length; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1
  }
  return Math.min(offset + Math.max(0, diagnostic.column - 1), source.length)
}

/** A line of a ruleset, trimmed, for showing beside its number. */
export function ruleLine(rules: string, line: number): string {
  return (rules.split('\n')[line - 1] ?? '').trim()
}
