// Which "connect your app" snippets there are, and what each is called: the
// one tab list every Connect surface draws from (the top bar's Connect
// dialog and its ⌘K items, an empty section's "From your app" block). The
// last, `agent`, is a coding agent's setup rather than an app's snippet: its
// tab draws the agents' files and install links (`connect/agent-setup.tsx`),
// and its one snippet is the `mcpServers` entry any agent reads. Each
// tab has the value a link names it by (`?connect=node`), the target
// `lib/connect.ts` writes its code for (`admin-node`), its tab label and
// the title over its code.
//
// Data only: the Overview's route schema reads the values in the first
// route, so the snippet writers stay in `lib/connect.ts`.

/** What `connectSnippet` writes a snippet for. */
export type ConnectTarget =
  | 'web'
  | 'flutter'
  | 'apple'
  | 'android'
  | 'admin-node'
  | 'python'
  | 'go'
  | 'java'
  | 'env'
  | 'firebase-json'
  | 'agent'

export interface ConnectTab {
  /** The value a link names the tab by (`?connect=`). */
  param: string
  target: ConnectTarget
  label: string
  /** The title over the code. */
  title: string
}

/** Every snippet, in the order the tabs show them. */
export const CONNECT_TABS = [
  { param: 'web', target: 'web', label: 'Web', title: 'Web app (modular SDK)' },
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
  {
    param: 'agent',
    target: 'agent',
    label: 'Coding agent',
    title: 'The MCP server for a coding agent',
  },
] as const satisfies readonly ConnectTab[]

/** A tab's value, as a link names it. */
export type ConnectParam = (typeof CONNECT_TABS)[number]['param']

/** Every tab's value, in order: what a `connect` search param may be. */
export const CONNECT_PARAMS = CONNECT_TABS.map((tab) => tab.param) as [
  ConnectParam,
  ...ConnectParam[],
]

/** The tab shown when a link names none. */
export const DEFAULT_CONNECT: ConnectParam = 'web'

/** The tab for a `connect` value; the web tab for none. */
export function connectTab(param: ConnectParam | undefined): ConnectTab {
  return CONNECT_TABS.find((tab) => tab.param === (param ?? DEFAULT_CONNECT)) ?? CONNECT_TABS[0]
}
