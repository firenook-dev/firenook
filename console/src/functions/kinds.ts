// What each kind of function does on the Functions page: the verb of its
// one action (the toolbar's primary while the Run tab is closed, the Run
// tab's label and the Send button's word), which form the Run tab holds,
// and the glyph the panel tree draws before its name.
//
// The kind words are the official functions shell's (`triggerKind` in
// `packages/cli/src/invoke.mjs`), computed by the engine; nothing here
// derives a kind from a trigger.

import {
  BellIcon,
  BroadcastIcon,
  ClockIcon,
  DatabaseIcon,
  GlobeSimpleIcon,
  HardDrivesIcon,
  type Icon,
  PhoneOutgoingIcon,
  QuestionIcon,
  QueueIcon,
  ShareNetworkIcon,
  ShieldCheckeredIcon,
  TreeStructureIcon,
  UsersIcon,
} from '@phosphor-icons/react'
import type { FunctionKind } from '@/api/generated/compute/FunctionKind'

/** The form the Run tab holds for a kind. */
export type RunForm = 'invoke' | 'callable' | 'event' | 'schedule' | 'task' | 'blocking'

/** Which Run form a kind gets. */
export function runForm(kind: FunctionKind): RunForm {
  switch (kind) {
    case 'http':
    case 'other':
      return 'invoke'
    case 'callable':
      return 'callable'
    case 'schedule':
      return 'schedule'
    case 'tasks':
      return 'task'
    case 'blocking':
      return 'blocking'
    default:
      return 'event'
  }
}

/** The action's verb: the toolbar's primary, the Run form's send button. */
export function kindVerb(kind: FunctionKind): string {
  switch (runForm(kind)) {
    case 'invoke':
      return 'Invoke'
    case 'callable':
      return 'Call'
    case 'event':
      return 'Send test event'
    case 'schedule':
      return 'Run now'
    case 'task':
      return 'Enqueue'
    case 'blocking':
      return 'Test'
  }
}

/** The Run tab's label: the action, as a noun where the verb is long. */
export function runTabLabel(kind: FunctionKind): string {
  switch (runForm(kind)) {
    case 'invoke':
      return 'Invoke'
    case 'callable':
      return 'Call'
    case 'event':
      return 'Test event'
    case 'schedule':
      return 'Run'
    case 'task':
      return 'Enqueue'
    case 'blocking':
      return 'Test'
  }
}

/** ⌘K's sentence for the action on one function: "Invoke api", "Run nightly now". */
export function actionTitle(kind: FunctionKind, name: string): string {
  switch (runForm(kind)) {
    case 'invoke':
      return `Invoke ${name}`
    case 'callable':
      return `Call ${name}`
    case 'event':
      return `Send a test event to ${name}`
    case 'schedule':
      return `Run ${name} now`
    case 'task':
      return `Enqueue a task for ${name}`
    case 'blocking':
      return `Test ${name}`
  }
}

/** Kinds that answer on a URL of their own (the engine sets `url` for exactly these). */
export function answersOnUrl(kind: FunctionKind): boolean {
  return kind === 'http' || kind === 'callable' || kind === 'blocking'
}

/**
 * The panel tree's glyph for a kind: the section its events come from where
 * there is one (the nav's own icon, so the tree reads with the sidebar),
 * otherwise what the kind is. The word itself is in the row's tooltip and
 * the overview's chip.
 */
export const KIND_ICON: Readonly<Record<FunctionKind, Icon>> = {
  http: GlobeSimpleIcon,
  callable: PhoneOutgoingIcon,
  firestore: DatabaseIcon,
  storage: HardDrivesIcon,
  auth: UsersIcon,
  pubsub: BroadcastIcon,
  schedule: ClockIcon,
  eventarc: ShareNetworkIcon,
  tasks: QueueIcon,
  blocking: ShieldCheckeredIcon,
  alerts: BellIcon,
  database: TreeStructureIcon,
  other: QuestionIcon,
}

/** "1st gen" or "2nd gen", for the toolbar and the overview's tooltip. */
export function generationText(platform: 'gcfv1' | 'gcfv2'): string {
  return platform === 'gcfv1' ? '1st gen' : '2nd gen'
}
