// The playground's request and its last run, kept outside the panel so a
// decision's "Try in the playground" can fill it, and so switching panels
// and back does not throw the request away.

import { create } from 'zustand'
import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { EvaluateResult } from '@/api/generated/EvaluateResult'
import { EMPTY_FORM, type PlaygroundForm } from './requests'

export interface PlaygroundRun {
  form: PlaygroundForm
  request: EvaluateRequest
  /** The rules text it ran against: the editor's, as it was. */
  source: string
  result: EvaluateResult
}

interface PlaygroundState {
  form: PlaygroundForm
  run: PlaygroundRun | undefined
  /** The engine refused to run it: a draft that does not compile, a bad request. */
  failure: string | undefined
  setForm: (patch: Partial<PlaygroundForm>) => void
  load: (form: PlaygroundForm) => void
  setRun: (run: PlaygroundRun | undefined, failure?: string) => void
}

export const usePlayground = create<PlaygroundState>((set) => ({
  form: EMPTY_FORM,
  run: undefined,
  failure: undefined,
  // Changing the request leaves a replayed decision's recorded context
  // behind: it described that request, not this one.
  setForm: (patch) =>
    set((state) => {
      const next = { ...state.form, ...patch }
      if (state.form.replay && ('path' in patch || 'method' in patch)) delete next.replay
      return { form: next }
    }),
  load: (form) => set({ form, run: undefined, failure: undefined }),
  setRun: (run, failure) => set({ run, failure }),
}))
