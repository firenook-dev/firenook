// Firestore's playground request and its last run: the rules kit's store
// (`src/rules/playground-store.ts`) over this page's form.

import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { EvaluateResult } from '@/api/generated/EvaluateResult'
import { type PlaygroundRun as KitRun, createPlaygroundStore } from '@/rules/playground-store'
import { EMPTY_FORM, type PlaygroundForm, patchForm } from './requests'

export type PlaygroundRun = KitRun<PlaygroundForm, EvaluateRequest, EvaluateResult>

export const usePlayground = createPlaygroundStore<PlaygroundForm, EvaluateRequest, EvaluateResult>(
  EMPTY_FORM,
  patchForm,
)
