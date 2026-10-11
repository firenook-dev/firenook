// The security rules, as text you can change.
//
// The emulator exists so rules can be got right before they reach
// production, and the loop that takes — edit the file, restart, try again —
// is the slowest part of writing them. Here a change compiles and takes
// effect on the next request, and the Requests feed then shows the line
// that decided it.
//
// Applying and saving are separate on purpose: a change is in force the
// moment it compiles, and reaches the repository only when asked, so trying
// something out never rewrites the file behind you.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { RulesDiagnostic } from '@/api/generated/RulesDiagnostic'
import type { RulesDocument } from '@/api/generated/RulesDocument'
import type { RulesInstalled } from '@/api/generated/RulesInstalled'
import { FS } from './queries'

export type { RulesDiagnostic, RulesDocument, RulesInstalled }

/** A compile failure, with the places in the text that caused it. */
export class RulesCompileError extends ApiError {
  readonly diagnostics: RulesDiagnostic[]
  constructor(message: string, diagnostics: RulesDiagnostic[]) {
    super(400, message)
    this.name = 'RulesCompileError'
    this.diagnostics = diagnostics
  }
}

export async function fetchRules(database: string): Promise<RulesDocument> {
  const response = await fetch(
    `${API_BASE}/firestore/rules?database=${encodeURIComponent(database)}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw await failure(response)
  return (await response.json()) as RulesDocument
}

export async function putRules(
  database: string,
  source: string,
  save: boolean,
): Promise<RulesInstalled> {
  const response = await fetch(`${API_BASE}/firestore/rules`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ database, source, save }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as RulesInstalled
}

async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`
  let diagnostics: RulesDiagnostic[] = []
  try {
    const body = (await response.json()) as {
      error?: { message?: string }
      diagnostics?: RulesDiagnostic[]
    }
    if (body.error?.message) message = body.error.message
    if (body.diagnostics) diagnostics = body.diagnostics
  } catch {
    // Keep the status line.
  }
  return diagnostics.length > 0
    ? new RulesCompileError(message, diagnostics)
    : new ApiError(response.status, message)
}

export const rulesQuery = (database: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules'],
    queryFn: () => fetchRules(database),
    // The rules only change when something changes them, and this console
    // is one of the things that does; it invalidates on its own write.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** The lines of a ruleset, for a gutter that numbers them. */
export function lineCount(source: string): number {
  return source === '' ? 1 : source.split('\n').length
}

/** `3:17 expected '{'` — a diagnostic as one line a person can scan. */
export function describeDiagnostic(diagnostic: RulesDiagnostic): string {
  return `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`
}

/**
 * Where a diagnostic sits in the text, as a character offset, so the editor
 * can put the caret on it. Out-of-range positions clamp to the end rather
 * than throwing: a diagnostic is a hint, not a contract.
 */
export function offsetOf(source: string, diagnostic: RulesDiagnostic): number {
  const lines = source.split('\n')
  let offset = 0
  for (let index = 0; index < diagnostic.line - 1 && index < lines.length; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1
  }
  return Math.min(offset + Math.max(0, diagnostic.column - 1), source.length)
}
