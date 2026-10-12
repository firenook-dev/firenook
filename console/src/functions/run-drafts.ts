// What the Run tab holds for each function while you work on it — an HTTP
// request, a callable's data, a test event, a task, a composed sign-up —
// kept per project and function in this tab's sessionStorage: a reload
// keeps the draft, a new tab starts clean. A draft keeps who it is sent as,
// never a token (tokens are minted again when it is sent).

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { KeyValueRow } from '@/components/console/key-value-editor'
import type { HttpMethod, RequestBody } from '@/components/console/request/types'
import type { ViewAs } from '@/lib/identity'
import type { AppCheckChoice } from './identity-headers'

export interface InvokeDraft {
  kind: 'request'
  method: HttpMethod
  /** After the function's address, without the query (the query rows hold it). */
  path: string
  query: KeyValueRow[]
  headers: KeyValueRow[]
  body: RequestBody
  identity: ViewAs
  appCheck: AppCheckChoice
}

export interface CallableDraft {
  kind: 'callable'
  /** The `data` as JSON text. */
  data: string
  identity: ViewAs
  appCheck: AppCheckChoice
  /** Ask for a streamed answer (`Accept: text/event-stream`). */
  stream: boolean
}

/** A test event's form: the per-kind fields and the envelope they build. */
export interface EventDraft {
  kind: 'event'
  /** The kind's own fields (document path, object name, message data …), as typed. */
  fields: Record<string, string>
  /** The envelope to post, as JSON text: the single source of truth once edited. */
  envelope: string
  /** The envelope was edited by hand since the fields last built it. */
  edited: boolean
}

export interface TaskDraft {
  kind: 'task'
  payload: string
  runAfter: string
}

export interface BlockingDraft {
  kind: 'blocking'
  uid: string
  email: string
  displayName: string
  provider: string
  claims: string
}

export type RunDraft = InvokeDraft | CallableDraft | EventDraft | TaskDraft | BlockingDraft

/** The key a draft is kept under. */
export function draftKey(project: string, functionId: string, kind: RunDraft['kind']): string {
  return `${project}|${functionId}|${kind}`
}

interface DraftState {
  drafts: Record<string, RunDraft>
  set: (key: string, draft: RunDraft) => void
  clear: (key: string) => void
}

/** sessionStorage when the browser gives it, else nothing kept beyond memory. */
function sessionStore() {
  try {
    const storage = window.sessionStorage
    const probe = 'firenook.console.probe'
    storage.setItem(probe, probe)
    storage.removeItem(probe)
    return storage
  } catch {
    const memory = new Map<string, string>()
    return {
      getItem: (name: string) => memory.get(name) ?? null,
      setItem: (name: string, value: string) => void memory.set(name, value),
      removeItem: (name: string) => void memory.delete(name),
    }
  }
}

export const useRunDrafts = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      set: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
      clear: (key) =>
        set((state) => {
          const { [key]: _gone, ...drafts } = state.drafts
          return { drafts }
        }),
    }),
    {
      name: 'firenook.console.run-drafts',
      storage: createJSONStorage(sessionStore),
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
)

/**
 * The draft of one function's Run form, starting from `initial` until
 * something is typed, and how to change it.
 */
export function useRunDraft<D extends RunDraft>(
  project: string,
  functionId: string,
  initial: () => D,
): [D, (next: D) => void, () => void] {
  const kindOf = initial().kind
  const key = draftKey(project, functionId, kindOf)
  const stored = useRunDrafts((state) => state.drafts[key])
  const setDraft = useRunDrafts((state) => state.set)
  const clear = useRunDrafts((state) => state.clear)
  const draft = stored?.kind === kindOf ? (stored as D) : initial()
  return [draft, (next) => setDraft(key, next), () => clear(key)]
}
