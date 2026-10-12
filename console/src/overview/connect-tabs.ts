// The tabs of "Connect your app": one per `connect` value, each with its
// label, the snippet's title and the target `lib/connect.ts` writes it
// for (the address says `node`, the generator `admin-node`).

import type { ConnectTarget } from '@/lib/connect'
import type { ConnectParam } from './search'

/** The tab shown when the address names none. */
export const DEFAULT_CONNECT: ConnectParam = 'web'

/**
 * Each tab: its label, the snippet's title over the code, and the generator
 * target in `lib/connect.ts` (the address says `node`, the generator
 * `admin-node`).
 */
export interface ConnectTab {
  param: ConnectParam
  target: ConnectTarget
  label: string
  title: string
}

const WEB_TAB: ConnectTab = {
  param: 'web',
  target: 'web',
  label: 'Web',
  title: 'Web app (modular SDK)',
}

export const CONNECT_TABS: readonly ConnectTab[] = [
  WEB_TAB,
  { param: 'flutter', target: 'flutter', label: 'Flutter', title: 'Flutter app' },
  { param: 'apple', target: 'apple', label: 'Apple', title: 'Apple app (Swift)' },
  { param: 'android', target: 'android', label: 'Android', title: 'Android app (Kotlin)' },
  { param: 'node', target: 'admin-node', label: 'Admin (Node)', title: 'Admin SDK for Node.js' },
  { param: 'python', target: 'python', label: 'Python', title: 'Admin SDK for Python' },
  { param: 'go', target: 'go', label: 'Go', title: 'Admin SDK for Go' },
  { param: 'java', target: 'java', label: 'Java', title: 'Admin SDK for Java' },
  {
    param: 'env',
    target: 'env',
    label: 'Environment variables',
    title: 'Environment variables, for .env or export',
  },
  {
    param: 'firebase-json',
    target: 'firebase-json',
    label: 'firebase.json',
    title: 'The emulators block of firebase.json',
  },
]

/** The tab for a `connect` value; the web tab for none. */
export function connectTab(param: ConnectParam | undefined): ConnectTab {
  return CONNECT_TABS.find((tab) => tab.param === (param ?? DEFAULT_CONNECT)) ?? WEB_TAB
}
