// The text on the rules page: what is in force, and what you have made of
// it. Applying puts a draft in force from the next request; saving also
// writes the file `firebase.json` names. The two are separate on purpose:
// trying something never rewrites the repository behind you.
//
// A draft outlives a trip to the data page and back — kept per database in
// this tab's session storage — because "go and look at what this would
// deny" is the most natural thing to do in the middle of an edit, and it
// used to cost the edit.

import { useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type RulesDiagnostic, RulesCompileError, putRules, rulesQuery } from '../rules'

interface StoredDraft {
  /** The rules in force when the edit began, so a change underneath is noticed. */
  base: string
  text: string
}

function storageKey(project: string, database: string): string {
  return `firenook.console.rules-draft.${project}.${database}`
}

function readDraft(key: string): StoredDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<StoredDraft>
    return typeof parsed.base === 'string' && typeof parsed.text === 'string'
      ? { base: parsed.base, text: parsed.text }
      : undefined
  } catch {
    return undefined
  }
}

function writeDraft(key: string, draft: StoredDraft | undefined) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft))
    else sessionStorage.removeItem(key)
  } catch {
    // Storage may be unavailable; the draft then lives as long as the page.
  }
}

export function useRulesDraft(project: string, database: string) {
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const rules = useQuery(rulesQuery(database))
  const key = storageKey(project, database)
  const [stored, setDraftState] = useState<StoredDraft | undefined>(() => readDraft(key))
  const [loadedKey, setLoadedKey] = useState(key)
  const [rejected, setRejected] = useState<RulesDiagnostic[]>([])

  // Another database's draft, when the picker changes.
  if (loadedKey !== key) {
    setLoadedKey(key)
    setDraftState(readDraft(key))
    setRejected([])
  }

  const inForce = rules.data?.source ?? ''
  // A draft that came back to what is in force is no draft at all.
  const draft = stored && rules.data && stored.text === inForce ? undefined : stored
  const source = draft?.text ?? inForce
  const edited = rules.data !== undefined && draft !== undefined && draft.text !== inForce
  // The rules in force moved while you were editing: a save from another
  // tab, a file changed on disk, a test suite's hot reload.
  const overtaken = edited && draft !== undefined && draft.base !== inForce

  const setSource = (text: string) => {
    const next = { base: draft?.base ?? inForce, text }
    setDraftState(next)
    writeDraft(key, next)
  }

  const revert = () => {
    setDraftState(undefined)
    writeDraft(key, undefined)
    setRejected([])
  }

  /** Keep the edit, and take what is in force now as what it began from. */
  const rebase = () => {
    if (!draft) return
    const next = { base: inForce, text: draft.text }
    setDraftState(next)
    writeDraft(key, next)
  }

  const apply = useMutation({
    mutationFn: ({ save, text }: { save: boolean; text: string }) => putRules(database, text, save),
    onSuccess: (result, variables) => {
      setRejected([])
      // What was applied is in force now; the draft has done its work.
      setDraftState(undefined)
      writeDraft(key, undefined)
      queryClient.setQueryData(rulesQuery(database).queryKey, (current) =>
        current ? { ...current, source: variables.text, enforced: true } : current,
      )
      void queryClient.invalidateQueries({ queryKey: rulesQuery(database).queryKey })
      toasts.add({
        title: variables.save ? 'Rules applied and saved' : 'Rules applied',
        description: result.saved
          ? (result.path ?? 'Written to the configured file')
          : 'In force from the next request. Not written to disk.',
        variant: 'success',
      })
    },
    onError: (error) => {
      setRejected(error instanceof RulesCompileError ? error.diagnostics : [])
      toasts.add({
        title: 'Nothing changed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
    },
  })

  return {
    rules,
    /** The text of the file `firebase.json` names, as it is on disk now; null without one. */
    fileSource: rules.data?.fileSource ?? null,
    /** Why the file on disk is not what is in force: its last reload did not compile. */
    fileProblems: rules.data?.fileProblems ?? [],
    source,
    inForce,
    edited,
    overtaken,
    /** What the last Apply or Save refused, until the text changes or one succeeds. */
    rejected,
    setSource,
    revert,
    rebase,
    apply: (save: boolean) => apply.mutate({ save, text: source }),
    applying: apply.isPending ? (apply.variables?.save ? 'save' : 'apply') : undefined,
  }
}

export type RulesDraft = ReturnType<typeof useRulesDraft>
