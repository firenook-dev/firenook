// The text on a rules page: what is in force, and what you have made of
// it. Applying puts a draft in force from the next request; saving also
// writes the file `firebase.json` names. The two are separate on purpose:
// trying something never rewrites the repository behind you.
//
// A draft outlives a trip to another page and back — kept per scope in
// this tab's session storage — because "go and look at what this would
// deny" is the most natural thing to do in the middle of an edit, and it
// used to cost the edit.
//
// The hook knows nothing about which service's rules it holds: a page hands
// it a backend (the document in force, how to install a text, where the
// draft is kept), so Firestore's database rules and Storage's bucket rules
// behave alike.

import {
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from '@/lib/toasts'
import { type RulesDiagnostic, RulesCompileError } from './text'

/** What every rules document carries, whichever service it is from. */
export interface RulesDocumentLike {
  /** The source in force; empty when none is. */
  source: string
  /** Whether any ruleset is installed at all. */
  enforced: boolean
  /** The file `firebase.json` names for this scope; saving writes here. */
  path: string | null
  /** That file's text as it is on disk now, when it is set and readable. */
  fileSource: string | null
  /** Why the file on disk is not what is in force. Positions refer to `fileSource`. */
  fileProblems: RulesDiagnostic[]
}

/** How a rules page reaches its service's rules. */
export interface RulesBackend<D extends RulesDocumentLike, K extends QueryKey = QueryKey> {
  /** The session-storage key this scope's draft is kept under. */
  draftKey: string
  /** The document in force. */
  document: UseQueryOptions<D, Error, D, K> & { queryKey: K }
  /** Install `source`; with `save`, write the scope's file too. */
  put: (source: string, save: boolean) => Promise<{ saved: boolean; path: string | null }>
}

export interface RulesDraft<D extends RulesDocumentLike = RulesDocumentLike> {
  rules: UseQueryResult<D, Error>
  /** The text of the file `firebase.json` names, as it is on disk now; null without one. */
  fileSource: string | null
  /** Why the file on disk is not what is in force: its last reload did not compile. */
  fileProblems: RulesDiagnostic[]
  /** The text in the editor: the draft, or what is in force. */
  source: string
  inForce: string
  edited: boolean
  /** The rules in force moved while you were editing. */
  overtaken: boolean
  /** What the last Apply or Save refused, until the text changes or one succeeds. */
  rejected: RulesDiagnostic[]
  setSource: (text: string) => void
  revert: () => void
  /** Keep the edit, and take what is in force now as what it began from. */
  rebase: () => void
  apply: (save: boolean) => void
  applying: 'apply' | 'save' | undefined
}

interface StoredDraft {
  /** The rules in force when the edit began, so a change underneath is noticed. */
  base: string
  text: string
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

export function useRulesDraft<D extends RulesDocumentLike, K extends QueryKey>(
  backend: RulesBackend<D, K>,
): RulesDraft<D> {
  const queryClient = useQueryClient()
  const rules = useQuery(backend.document)
  const key = backend.draftKey
  const [stored, setDraftState] = useState<StoredDraft | undefined>(() => readDraft(key))
  const [loadedKey, setLoadedKey] = useState(key)
  const [rejected, setRejected] = useState<RulesDiagnostic[]>([])

  // Another scope's draft, when the picker changes.
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

  const rebase = () => {
    if (!draft) return
    const next = { base: inForce, text: draft.text }
    setDraftState(next)
    writeDraft(key, next)
  }

  const documentKey = backend.document.queryKey
  const apply = useMutation({
    mutationFn: ({ save, text }: { save: boolean; text: string }) => backend.put(text, save),
    onSuccess: (result, variables) => {
      setRejected([])
      // What was applied is in force now; the draft has done its work.
      setDraftState(undefined)
      writeDraft(key, undefined)
      queryClient.setQueryData<D>(documentKey, (current) =>
        current ? { ...current, source: variables.text, enforced: true } : current,
      )
      void queryClient.invalidateQueries({ queryKey: documentKey })
      // One toast per page for what an Apply did: the next one replaces it.
      toast({
        key: 'rules-apply',
        title: variables.save ? 'Rules applied and saved' : 'Rules applied',
        description: result.saved
          ? (result.path ?? 'Written to the configured file')
          : 'In force from the next request. Not written to disk.',
        tone: 'success',
      })
    },
    onError: (error) => {
      setRejected(error instanceof RulesCompileError ? error.diagnostics : [])
      toast({
        key: 'rules-apply',
        title: 'Nothing changed',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    },
  })

  return {
    rules,
    fileSource: rules.data?.fileSource ?? null,
    fileProblems: rules.data?.fileProblems ?? [],
    source,
    inForce,
    edited,
    overtaken,
    rejected,
    setSource,
    revert,
    rebase,
    apply: (save: boolean) => apply.mutate({ save, text: source }),
    applying: apply.isPending ? (apply.variables?.save ? 'save' : 'apply') : undefined,
  }
}
