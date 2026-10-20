// What a coding agent needs to reach this emulator through `firenook mcp`:
// each agent's project file, its command, and the editors' install links,
// written once here so the Connect dialog's "Coding agent" tab and ⌘K copy
// the same text.
//
// A project file never names the project: it is committed and every
// teammate's agent reads it, and `firenook mcp` with no arguments finds the
// one suite running on the machine. Only what goes in someone's own
// settings (a user-level install, an editor's install link) may carry
// `--project <id>`, for a machine that runs more than one suite at once.
//
// The install links follow the vendors' documented formats:
// - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the
//   server's JSON entry>` (cursor.com/docs, "MCP install links").
// - VS Code: `vscode:mcp/install?<URL-encoded JSON with the name beside the entry>`, and
//   `vscode-insiders:` for Insiders (code.visualstudio.com, "MCP developer guide").

/** The name every agent's configuration gives the server. */
export const MCP_SERVER = 'firenook'

/** Writes each agent's project file for the agents a project uses; `--dry-run` shows the plan. */
export const MCP_ADD_COMMAND = 'npx firenook mcp add'

/** Where each agent reads a project's MCP servers, relative to the project's folder. */
export const AGENT_FILES = {
  claude: '.mcp.json',
  cursor: '.cursor/mcp.json',
  vscode: '.vscode/mcp.json',
} as const

/** How the server is started: `npx firenook mcp`, naming the project when asked to. */
export function mcpArgs(project?: string): string[] {
  return project ? ['firenook', 'mcp', '--project', project] : ['firenook', 'mcp']
}

/** The server as an `mcpServers` entry: `{ command, args }`. */
export function mcpEntry(project?: string): { command: string; args: string[] } {
  return { command: 'npx', args: mcpArgs(project) }
}

/**
 * JSON as a person writes a config file: objects indented two spaces, an
 * array of plain values on one line (`"args": ["firenook", "mcp"]`).
 */
export function configJson(value: unknown, indent = ''): string {
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null))
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const inner = `${indent}  `
    const entries = Array.isArray(value)
      ? value.map((item) => `${inner}${configJson(item, inner)}`)
      : Object.entries(value).map(
          ([key, item]) => `${inner}${JSON.stringify(key)}: ${configJson(item, inner)}`,
        )
    const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
    return entries.length === 0
      ? `${open}${close}`
      : `${open}\n${entries.join(',\n')}\n${indent}${close}`
  }
  return JSON.stringify(value)
}

/**
 * `{"mcpServers":{"firenook":{…}}}`, indented: the shape Claude Code's
 * `.mcp.json`, Cursor's `.cursor/mcp.json` and most other agents read.
 */
export function mcpServersJson(project?: string): string {
  return configJson({ mcpServers: { [MCP_SERVER]: mcpEntry(project) } })
}

/** `.vscode/mcp.json`: VS Code keeps its servers under `servers`, each with its `type`. */
export function vscodeJson(project?: string): string {
  return configJson({ servers: { [MCP_SERVER]: { type: 'stdio', ...mcpEntry(project) } } })
}

/** `claude mcp add` for a scope: `project` writes `.mcp.json`, `user` the person's own settings. */
export function claudeCommand(scope: 'project' | 'user', project?: string): string {
  return `claude mcp add --scope ${scope} ${MCP_SERVER} -- npx ${mcpArgs(project).join(' ')}`
}

/** Base64 of an ASCII string, in a browser or Node alike. */
function base64(text: string): string {
  return btoa(text)
}

/** Cursor's install link: the entry's JSON, base64, beside the name. */
export function cursorInstallLink(project?: string): string {
  const config = encodeURIComponent(base64(JSON.stringify(mcpEntry(project))))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER}&config=${config}`
}

/** VS Code's install link (or Insiders'): the entry with its name, as URL-encoded JSON. */
export function vscodeInstallLink(project?: string, insiders = false): string {
  const config = encodeURIComponent(JSON.stringify({ name: MCP_SERVER, ...mcpEntry(project) }))
  return `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${config}`
}
