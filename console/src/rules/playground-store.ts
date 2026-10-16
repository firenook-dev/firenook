// A rules page's playground request and its last run, kept outside the
// panel so a decision's "Try in the playground", a saved test's "Open in
// the playground" and a refusal met elsewhere can fill it, and so switching
// panels (or pages) and back keeps it. A request handed over to be tried
// waits as `pending` until the playground has the rules to run it against.
// Each page makes one with its own form, and says what a change to the form
// leaves behind of a replayed request (`patch`).

import { type StoreApi, type UseBoundStore, create } from 'zustand'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'

export interface PlaygroundRun<F, Q, R> {
  form: F
  request: Q
  /** The rules text it ran against: the editor's, as it was. */
  source: string
  result: R
}

export interface PlaygroundState<F, Q, R> {
  form: F
  run: PlaygroundRun<F, Q, R> | undefined
  /** The engine refused to run it: a draft that does not compile, a request it cannot read. */
  failure: string | undefined
  /** Run the form as soon as the playground can: it was handed over to be tried. */
  pending: boolean
  setForm: (patch: Partial<F>) => void
  /** A new request; `run` tries it at once, against the rules in the editor once they are there. */
  load: (form: F, options?: { run?: boolean }) => void
  /** The pending run has started. */
  takePending: () => void
  setRun: (run: PlaygroundRun<F, Q, R> | undefined, failure?: string) => void
}

export type PlaygroundStore<F, Q, R> = UseBoundStore<StoreApi<PlaygroundState<F, Q, R>>>

/** A page's playground: its empty form, and the form after a patch. */
export function createPlaygroundStore<F, Q, R extends { outcome: RulesOutcome }>(
  empty: F,
  patch: (form: F, patch: Partial<F>) => F,
): PlaygroundStore<F, Q, R> {
  return create<PlaygroundState<F, Q, R>>((set) => ({
    form: empty,
    run: undefined,
    failure: undefined,
    pending: false,
    setForm: (changes) => set((state) => ({ form: patch(state.form, changes) })),
    load: (form, options) =>
      set({ form, run: undefined, failure: undefined, pending: options?.run ?? false }),
    takePending: () => set({ pending: false }),
    setRun: (run, failure) => set({ run, failure }),
  }))
}
