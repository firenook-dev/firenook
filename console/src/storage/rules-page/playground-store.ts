// Storage's playground request and its last run: the rules kit's store
// (`src/rules/playground-store.ts`) over this page's form, which a
// decision's "Try in the playground", a saved test and a refusal on the
// Files page fill. A change to what the request is about leaves a replay's
// recorded files behind (`patchForm`).

import { type PlaygroundRun as KitRun, createPlaygroundStore } from '@/rules/playground-store'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageEvaluateResult } from '@/api/generated/storage/StorageEvaluateResult'
import { EMPTY_FORM, type PlaygroundForm } from './requests'

export type PlaygroundRun = KitRun<PlaygroundForm, StorageEvaluateRequest, StorageEvaluateResult>

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

export const usePlayground = createPlaygroundStore<
  PlaygroundForm,
  StorageEvaluateRequest,
  StorageEvaluateResult
>(EMPTY_FORM, patchForm)
