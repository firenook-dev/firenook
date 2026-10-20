import { describe, expect, it } from 'vitest'
import {
  AGENT_FILES,
  MCP_ADD_COMMAND,
  claudeCommand,
  configJson,
  cursorInstallLink,
  mcpServersJson,
  vscodeInstallLink,
  vscodeJson,
} from './agent-config'

/** The JSON a Cursor link carries: `config` is the entry's JSON, base64. */
function cursorConfig(link: string): { name: string | null; config: unknown } {
  const url = new URL(link)
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
    'cursor://anysphere.cursor-deeplink/mcp/install',
  )
  const config = url.searchParams.get('config') ?? ''
  return { name: url.searchParams.get('name'), config: JSON.parse(atob(config)) }
}

/** The JSON a VS Code link carries: everything after `?`, URL-encoded. */
function vscodeConfig(link: string, scheme: string): unknown {
  const prefix = `${scheme}:mcp/install?`
  expect(link.startsWith(prefix)).toBe(true)
  return JSON.parse(decodeURIComponent(link.slice(prefix.length)))
}

describe('a coding agent’s setup', () => {
  it('writes project files that name no project', () => {
    expect(JSON.parse(mcpServersJson())).toEqual({
      mcpServers: { firenook: { command: 'npx', args: ['firenook', 'mcp'] } },
    })
    expect(JSON.parse(vscodeJson())).toEqual({
      servers: { firenook: { type: 'stdio', command: 'npx', args: ['firenook', 'mcp'] } },
    })
    expect(AGENT_FILES).toEqual({
      claude: '.mcp.json',
      cursor: '.cursor/mcp.json',
      vscode: '.vscode/mcp.json',
    })
    expect(MCP_ADD_COMMAND).toBe('npx firenook mcp add')
  })

  it('writes JSON as a config file is written', () => {
    expect(mcpServersJson()).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "firenook": {',
        '      "command": "npx",',
        '      "args": ["firenook", "mcp"]',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(configJson({ list: [{ a: 1 }], empty: {}, none: [] })).toBe(
      [
        '{',
        '  "list": [',
        '    {',
        '      "a": 1',
        '    }',
        '  ],',
        '  "empty": {},',
        '  "none": []',
        '}',
      ].join('\n'),
    )
  })

  it('names the project only where it is asked to', () => {
    expect(claudeCommand('project')).toBe(
      'claude mcp add --scope project firenook -- npx firenook mcp',
    )
    expect(claudeCommand('user')).toBe('claude mcp add --scope user firenook -- npx firenook mcp')
    expect(claudeCommand('user', 'demo-shop')).toBe(
      'claude mcp add --scope user firenook -- npx firenook mcp --project demo-shop',
    )
    expect(JSON.parse(mcpServersJson('demo-shop')).mcpServers.firenook.args).toEqual([
      'firenook',
      'mcp',
      '--project',
      'demo-shop',
    ])
  })

  it('builds Cursor’s install link from the entry, base64', () => {
    expect(cursorConfig(cursorInstallLink())).toEqual({
      name: 'firenook',
      config: { command: 'npx', args: ['firenook', 'mcp'] },
    })
    expect(cursorConfig(cursorInstallLink('demo-shop')).config).toEqual({
      command: 'npx',
      args: ['firenook', 'mcp', '--project', 'demo-shop'],
    })
    // Base64's padding and its `+` and `/` survive a query string.
    expect(cursorInstallLink()).toContain(
      'config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJmaXJlbm9vayIsIm1jcCJdfQ%3D%3D',
    )
  })

  it('builds VS Code’s install links from the entry and its name, URL-encoded', () => {
    expect(vscodeConfig(vscodeInstallLink(), 'vscode')).toEqual({
      name: 'firenook',
      command: 'npx',
      args: ['firenook', 'mcp'],
    })
    expect(vscodeConfig(vscodeInstallLink('demo-shop', true), 'vscode-insiders')).toEqual({
      name: 'firenook',
      command: 'npx',
      args: ['firenook', 'mcp', '--project', 'demo-shop'],
    })
  })
})
