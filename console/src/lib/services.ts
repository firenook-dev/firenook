import type { Icon } from '@phosphor-icons/react'
import {
  BroadcastIcon,
  DatabaseIcon,
  HardDrivesIcon,
  LightningIcon,
  PuzzlePieceIcon,
  QueueIcon,
  ScrollIcon,
  ShareNetworkIcon,
  UsersIcon,
} from '@phosphor-icons/react'

export type ServiceArea = 'data' | 'compute' | 'messaging' | 'observe'

export interface ConsoleSection {
  /** Client route. */
  to: string
  /** Sidebar and page label, sentence case. */
  label: string
  /** Hub service names this section shows; empty for cross-cutting views. */
  services: readonly string[]
  area: ServiceArea
  icon: Icon
  /** What the finished section does, in one sentence. */
  summary: string
  /**
   * The section's own pages, when it has more than one: shown under it in
   * the sidebar. The first is where the section's own entry leads.
   */
  pages?: readonly SectionPage[]
  /**
   * The section's API and topics accept a `project`, so a link with
   * `?project=` can show the data of another project the app used
   * (`useConsoleProject`). Storage buckets are not per project.
   */
  projectScope?: boolean
}

export interface SectionPage {
  to: string
  label: string
  /** Matches this page and nothing else under the section. */
  exact?: boolean
}

export const SECTIONS: readonly ConsoleSection[] = [
  {
    to: '/firestore',
    label: 'Firestore',
    services: ['firestore'],
    area: 'data',
    icon: DatabaseIcon,
    summary:
      'Path bar, document grid with inferred columns, a query builder that runs the same engine query the app runs, and view-as-user over the rules engine. Security rules have their own page: an editor that knows the language, every decision with the line and values behind it, a playground and saved tests.',
    // Rules are their own page, not a mode of the data view: a different
    // job — writing who may do what, not reading what there is — with a
    // URL of its own, the way Firebase's own console files them.
    pages: [
      { to: '/firestore', label: 'Data', exact: true },
      { to: '/firestore/rules', label: 'Rules' },
    ],
    projectScope: true,
  },
  {
    to: '/auth',
    label: 'Authentication',
    services: ['auth'],
    area: 'data',
    icon: UsersIcon,
    projectScope: true,
    summary:
      'Users table with real columns and actions, an inbox for every code and link the emulator would have sent, and a sign-in timeline with the exact error.',
  },
  {
    to: '/storage',
    label: 'Storage',
    services: ['storage'],
    area: 'data',
    icon: HardDrivesIcon,
    summary:
      'Bucket switcher, folder browser with previews, metadata editor, and native rules reload.',
  },
  {
    to: '/functions',
    label: 'Functions',
    services: ['functions'],
    area: 'compute',
    icon: LightningIcon,
    summary:
      'Functions by codebase with trigger type, invoke HTTP and callable functions, inject background events, and follow each function’s log stream.',
  },
  {
    to: '/extensions',
    label: 'Extensions',
    services: ['functions'],
    area: 'compute',
    icon: PuzzlePieceIcon,
    summary:
      'Instances with their source and offline readiness, resolved parameters, and the functions each instance adds.',
  },
  {
    to: '/pubsub',
    label: 'Pub/Sub',
    services: ['pubsub'],
    area: 'messaging',
    icon: BroadcastIcon,
    projectScope: true,
    summary:
      'Topics and subscriptions, publish and pull messages, ack and seek, snapshots and schemas, delivery status to functions.',
  },
  {
    to: '/eventarc',
    label: 'Eventarc',
    services: ['eventarc'],
    area: 'messaging',
    icon: ShareNetworkIcon,
    summary: 'Channels and triggers, publish a custom event, and trace its delivery.',
  },
  {
    to: '/tasks',
    label: 'Cloud Tasks',
    services: ['tasks'],
    area: 'messaging',
    icon: QueueIcon,
    projectScope: true,
    summary:
      'Queues with stats, pending and running tasks with their retry attempt and next dispatch, and enqueue a task by hand.',
  },
  {
    to: '/logs',
    label: 'Logs',
    services: ['logging'],
    area: 'observe',
    icon: ScrollIcon,
    summary: 'One stream for every service with level and service filters and search.',
  },
]

export const AREA_LABELS: Record<ServiceArea, string> = {
  data: 'Data',
  compute: 'Compute',
  messaging: 'Messaging',
  observe: 'Observe',
}

export const SERVICE_LABELS: Record<string, string> = {
  firestore: 'Firestore',
  'firestore.websocket': 'Firestore requests',
  auth: 'Authentication',
  storage: 'Storage',
  functions: 'Functions',
  pubsub: 'Pub/Sub',
  eventarc: 'Eventarc',
  tasks: 'Cloud Tasks',
  hub: 'Emulator hub',
  ui: 'Emulator UI',
  logging: 'Logging',
}

export function serviceLabel(name: string): string {
  return SERVICE_LABELS[name] ?? name
}
