// The console's sections, one registry file each (`lib/sections/<id>.ts`),
// assembled here in the one sidebar order (`section-order.json`, which the
// engine sorts its status by too). A section stream edits only its own file;
// nothing here changes when a section lands.
//
// A registry file is in the first route, so it holds icons, types and pure
// string helpers only; anything heavier goes behind `shellMount` or into
// the section's route chunk.

import type { Icon } from '@phosphor-icons/react'
import type { ComponentType } from 'react'
import order from './section-order.json'
import { auth } from './sections/auth'
import { eventarc } from './sections/eventarc'
import { extensions } from './sections/extensions'
import { firestore } from './sections/firestore'
import { functions } from './sections/functions'
import { logs } from './sections/logs'
import { pubsub } from './sections/pubsub'
import { storage } from './sections/storage'
import { tasks } from './sections/tasks'

export type ServiceArea = 'data' | 'compute' | 'messaging' | 'observe'

/** A section's id: its route's first segment, its status entry, its topics' and badges' prefix. */
export type SectionId =
  | 'firestore'
  | 'auth'
  | 'storage'
  | 'functions'
  | 'extensions'
  | 'eventarc'
  | 'pubsub'
  | 'tasks'
  | 'logs'

/** Where something opens: a route and its search params. */
export interface SectionLink {
  to: string
  /** The page's search params, as its schema reads them (a rules page's `line` is a number). */
  search?: Record<string, string | number | boolean | undefined>
}

export interface SectionPage {
  to: string
  label: string
  /** Matches this page and nothing else under the section. */
  exact?: boolean
  /** Badge ids (engine `Badge.id`) shown on this page's nav item. */
  badges?: readonly string[]
  /** Extra words ⌘K matches the page by. */
  keywords?: string
}

/** Something ⌘K offers from anywhere; a link, so a dialog opens from `?new=` or `?dialog=`. */
export interface SectionAction {
  id: string
  title: string
  description?: string
  keywords?: string
  icon: Icon
  link: SectionLink
}

export interface ConsoleSection {
  id: SectionId
  /** Client route, `/<id>`. */
  to: string
  /** Sidebar and page label, sentence case. */
  label: string
  /** Hub service names this section shows. */
  services: readonly string[]
  area: ServiceArea
  icon: Icon
  /** What the finished section does, in one sentence: the placeholder's and the overview's. */
  summary: string
  /** False keeps the honest placeholder until the section's journeys pass. */
  built: boolean
  /**
   * The section's own pages, when it has more than one: shown under it in
   * the sidebar. The first is where the section's own entry leads.
   */
  pages?: readonly SectionPage[]
  /** Badge ids shown on the section's own nav item. */
  badges?: readonly string[]
  /** What ⌘K offers from anywhere. */
  actions?: readonly SectionAction[]
  /**
   * Where a thing of this section opens, by entity kind: serves engine
   * search hits (`SearchHit.kind`) and every `EntityRef` another section's
   * payload carries.
   */
  routes?: Readonly<Record<string, (key: string) => SectionLink>>
  /** ⌘K's group label for each kind of hit ("Users", "Collections"). */
  searchLabels?: Readonly<Record<string, string>>
  /**
   * Where ⌘K's "Search <section> for “text”" row leads. Absent: the
   * section with `?q=<text>`, its filter; `null`: no such row, for a
   * section whose `q` is not a text filter (Firestore's is an SDK query).
   */
  searchLink?: ((text: string) => SectionLink) | null
  /** Where the nav item leads while one of its counter badges is above zero. Absent: `to`. */
  badgeLink?: (seen: { count: number; cursor?: string }) => SectionLink
  /** A lazy component the shell mounts while the section is ready. */
  shellMount?: () => Promise<{ default: ComponentType }>
  /**
   * The section's API and topics accept a `project`, so a link with
   * `?project=` can show the data of another project the app used
   * (`useConsoleProject`). Storage buckets are not per project.
   */
  projectScope?: boolean
}

const REGISTRY: Record<SectionId, ConsoleSection> = {
  firestore,
  auth,
  storage,
  functions,
  extensions,
  eventarc,
  pubsub,
  tasks,
  logs,
}

/** Every section, in the sidebar's order. */
export const SECTIONS: readonly ConsoleSection[] = (order as SectionId[]).map((id) => REGISTRY[id])

/** The section with this id, or `undefined` for a string that names none. */
export function sectionById(id: string): ConsoleSection | undefined {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id as SectionId] : undefined
}

/**
 * The badges a section's own nav item shows: its registry's, and the gauge
 * the engine keeps while the section's bulk jobs run (`<id>.jobs`), which
 * no registry needs to list.
 */
export function itemBadges(section: ConsoleSection): readonly string[] {
  return [...(section.badges ?? []), `${section.id}.jobs`]
}

/**
 * The pages the navigation and ⌘K show under a section: none until it is
 * built, so a section whose registry already lists its pages is still one
 * entry leading to its placeholder, and no page is offered before it works.
 */
export function shownPages(section: ConsoleSection): readonly SectionPage[] | undefined {
  return section.built ? section.pages : undefined
}

/** The section a console path belongs to (`/firestore/rules` → Firestore). */
export function sectionAt(pathname: string): ConsoleSection | undefined {
  return SECTIONS.find(
    (section) => pathname === section.to || pathname.startsWith(`${section.to}/`),
  )
}

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
