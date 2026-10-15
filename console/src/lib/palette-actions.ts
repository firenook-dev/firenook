// What each section's registry offers from anywhere in ⌘K: open a dialog
// (`?new=`, `?dialog=`) or a filtered view. Only the palette reads this, and
// it is a lazy chunk, so the actions and their icons stay off the first
// route, where the registries themselves (`lib/sections/<id>.ts`) load.
// A section's actions live beside its registry in `<id>-actions.ts`.

import { authActions } from './sections/auth-actions'
import { eventarcActions } from './sections/eventarc-actions'
import { functionsActions } from './sections/functions-actions'
import { logsActions } from './sections/logs-actions'
import { pubsubActions } from './sections/pubsub-actions'
import { storageActions } from './sections/storage-actions'
import { tasksActions } from './sections/tasks-actions'
import type { SectionAction, SectionId } from './services'

/** Each section's ⌘K actions; a section with none is absent. */
export const SECTION_ACTIONS: Readonly<Partial<Record<SectionId, readonly SectionAction[]>>> = {
  auth: authActions,
  storage: storageActions,
  functions: functionsActions,
  eventarc: eventarcActions,
  pubsub: pubsubActions,
  tasks: tasksActions,
  logs: logsActions,
}
