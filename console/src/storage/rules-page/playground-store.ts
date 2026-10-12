// The playground's request and its last run, kept outside the panel so a
// decision's "Try in the playground", a saved test's "Open in the
// playground" and a refusal on the Files page can fill it, and so switching
// panels (or pages) and back keeps it. A request handed over to be tried
// waits as `pending` until the playground has the rules to run it against.

import { create } from 'zustand'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageEvaluateResult } from '@/api/generated/storage/StorageEvaluateResult'
import { EMPTY_FORM, type PlaygroundForm } from './requests'

export interface PlaygroundRun {
  form: PlaygroundForm
  request: StorageEvaluateRequest
  /** The rules text it ran against: the editor's, as it was. */
  source: string
  result: StorageEvaluateResult
}

interface PlaygroundState {
  form: PlaygroundForm
  run: PlaygroundRun | undefined
  /** The engine refused to run it: a draft that does not compile, a request it cannot read. */
  failure: string | undefined
  /** Run the form as soon as the playground can: it was handed over to be tried. */
  pending: boolean
  setForm: (patch: Partial<PlaygroundForm>) => void
  /** A new request; `run` tries it at once, against the rules in the editor once they are there. */
  load: (form: PlaygroundForm, options?: { run?: boolean }) => void
  /** The pending run has started. */
  takePending: () => void
  setRun: (run: PlaygroundRun | undefined, failure?: string) => void
}

/** What changes the request itself; a replay described another one. */
const REQUEST_FIELDS: ReadonlySet<keyof PlaygroundForm> = new Set(['method', 'bucket', 'path'])
/** What changes the file an upload proposes; the recorded one no longer is it. */
const PROPOSED_FIELDS: ReadonlySet<keyof PlaygroundForm> = new Set([
  'size',
  'unit',
  'contentType',
  'metadata',
])

/** The form after `patch`, with whatever of a replay no longer describes it dropped. */
export function patchForm(form: PlaygroundForm, patch: Partial<PlaygroundForm>): PlaygroundForm {
  const next = { ...form, ...patch }
  const keys = Object.keys(patch) as Array<keyof PlaygroundForm>
  if (!next.replay) return next
  if (keys.some((key) => REQUEST_FIELDS.has(key))) {
    delete next.replay
    return next
  }
  if (keys.includes('existing')) {
    const { resource: _resource, ...rest } = next.replay
    next.replay = rest
  }
  if (keys.some((key) => PROPOSED_FIELDS.has(key)) && next.replay.requestResource !== undefined) {
    const { requestResource: _proposed, ...rest } = next.replay
    next.replay = rest
  }
  return next
}

export const usePlayground = create<PlaygroundState>((set) => ({
  form: EMPTY_FORM,
  run: undefined,
  failure: undefined,
  pending: false,
  setForm: (patch) => set((state) => ({ form: patchForm(state.form, patch) })),
  load: (form, options) =>
    set({ form, run: undefined, failure: undefined, pending: options?.run ?? false }),
  takePending: () => set({ pending: false }),
  setRun: (run, failure) => set({ run, failure }),
}))
