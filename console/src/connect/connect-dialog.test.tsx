import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { ConnectButton } from './connect-button'
import { ConnectBody } from './connect-dialog'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const services = [
  { name: 'firestore', host: '127.0.0.1', port: 8080, listening: true, pid: null },
  { name: 'auth', host: '127.0.0.1', port: 9099, listening: true, pid: null },
  { name: 'hub', host: '127.0.0.1', port: 4400, listening: true, pid: null },
]

const withDocuments = (documents: number): ConsoleStatus =>
  testStatus({
    projectId: 'demo-overview',
    services,
    sections: [
      sectionEntry('firestore', {
        summary: {
          headline: `${documents} documents · 1 database`,
          figures: [
            { label: 'Documents', value: documents, unit: 'count' },
            { label: 'Databases', value: 1, unit: 'count' },
          ],
        },
      }),
    ],
  })

describe('connect your app', () => {
  it('prints the web snippet for this engine, and hands a picked platform to the address', async () => {
    const user = userEvent.setup()
    const onParam = vi.fn()
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <ConnectBody
          status={status}
          engine={undefined}
          host="127.0.0.1"
          param={undefined}
          onParam={onParam}
        />
      ),
      { status },
    )
    const snippet = screen.getByTestId('connect-snippet')
    expect(snippet).toHaveTextContent(
      "connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080)",
    )
    expect(snippet).toHaveTextContent(
      "initializeApp({ projectId: 'demo-overview', apiKey: 'demo-api-key' })",
    )
    expect(screen.getByRole('tab', { name: 'Web' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'Flutter' }))
    expect(onParam).toHaveBeenCalledWith('flutter')
    // The list is a vertical tab list: ↓ moves to the next platform.
    screen.getByRole('tab', { name: 'Web' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onParam).toHaveBeenLastCalledWith('flutter')
  })

  it('prints the platform the address names, with the engine’s bucket', async () => {
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <ConnectBody
          status={status}
          engine={undefined}
          host="127.0.0.1"
          param="env"
          onParam={() => {}}
        />
      ),
      { status },
    )
    const snippet = screen.getByTestId('connect-snippet')
    expect(snippet).toHaveTextContent('FIRESTORE_EMULATOR_HOST=127.0.0.1:8080')
    expect(snippet).toHaveTextContent('FIREBASE_EMULATOR_HUB=127.0.0.1:4400')
    expect(screen.getByTestId('connect-note')).toHaveTextContent('emulators:exec')
  })
})

/** The engine's answer to a read, as JSON. */
const answer = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )

describe('the coding agent tab', () => {
  it('says when an agent last called, and gives each agent its setup', async () => {
    const user = userEvent.setup()
    const at = new Date(Date.now() - 2 * 60_000).toISOString()
    const fetch = vi.fn((url: string) =>
      url.endsWith('/console/api/v1/agents')
        ? answer({
            lastCall: { at, client: 'firenook-mcp/0.2.0-next.7', tool: 'firestore_query' },
            calls: 4,
          })
        : new Promise<Response>(() => {}),
    )
    vi.stubGlobal('fetch', fetch)
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <ConnectBody
          status={status}
          engine={undefined}
          host="127.0.0.1"
          param="agent"
          onParam={() => {}}
        />
      ),
      { status },
    )
    expect(screen.getByRole('tab', { name: 'Coding agent' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await waitFor(() =>
      expect(screen.getByTestId('agent-last-call')).toHaveTextContent(
        'Last call 2 min ago: firestore_query (firenook-mcp/0.2.0-next.7)',
      ),
    )
    expect(screen.getByTestId('agent-mcp-add')).toHaveTextContent('npx firenook mcp add')
    // Claude Code: the project's command and file, which name no project.
    expect(screen.getByTestId('agent-claude-project')).toHaveTextContent(
      'claude mcp add --scope project firenook -- npx firenook mcp',
    )
    expect(screen.getByTestId('agent-claude-file')).toHaveTextContent('"mcpServers"')
    expect(screen.getByTestId('agent-claude-user')).not.toHaveTextContent('--project')
    // With more than one emulator, what goes in one's own settings names it.
    await user.click(screen.getByRole('checkbox', { name: /More than one emulator/ }))
    expect(screen.getByTestId('agent-claude-user')).toHaveTextContent(
      'npx firenook mcp --project demo-overview',
    )
    expect(screen.getByTestId('agent-claude-file')).not.toHaveTextContent('--project')
    await user.click(screen.getByRole('tab', { name: 'Cursor' }))
    const cursor = screen.getByTestId('agent-cursor-install')
    expect(cursor.getAttribute('href')).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=firenook&config=/,
    )
    const config = new URL(cursor.getAttribute('href') ?? '').searchParams.get('config') ?? ''
    expect(JSON.parse(atob(config))).toEqual({
      command: 'npx',
      args: ['firenook', 'mcp', '--project', 'demo-overview'],
    })
    expect(screen.getByTestId('agent-cursor-file')).not.toHaveTextContent('--project')
    await user.click(screen.getByRole('tab', { name: 'VS Code' }))
    expect(screen.getByTestId('agent-vscode-install').getAttribute('href')).toMatch(
      /^vscode:mcp\/install\?/,
    )
    expect(screen.getByTestId('agent-vscode-insiders-install').getAttribute('href')).toMatch(
      /^vscode-insiders:mcp\/install\?/,
    )
    expect(screen.getByTestId('agent-vscode-file')).toHaveTextContent('"servers"')
    // The agents are read once as the tab opens; nothing polls.
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/agents'))).toHaveLength(1)
  })

  it('says so when no agent has called', async () => {
    vi.stubGlobal('fetch', () => answer({ lastCall: null, calls: 0 }))
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <ConnectBody
          status={status}
          engine={undefined}
          host="127.0.0.1"
          param="agent"
          onParam={() => {}}
        />
      ),
      { status },
    )
    await waitFor(() =>
      expect(screen.getByTestId('agent-last-call')).toHaveTextContent('No agent has called yet.'),
    )
  })
})

describe('the top bar’s Connect', () => {
  it('opens the dialog over the page on screen, keeps the platform in the address, and closes', async () => {
    const user = userEvent.setup()
    const status = withDocuments(1)
    // The engine's configuration is asked for when the dialog first opens.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    // The page's own parameters stay; a journey opens it over a real section page.
    const { router } = await renderInConsole(() => <ConnectButton />, {
      status,
      path: '/?path=users',
    })
    expect(screen.queryByTestId('connect')).toBeNull()
    await user.click(screen.getByTestId('top-bar-connect'))
    expect(await screen.findByTestId('connect-snippet')).toHaveTextContent(
      'connectFirestoreEmulator',
    )
    expect(router.state.location.search).toMatchObject({ path: 'users', connect: 'web' })
    await user.click(screen.getByRole('tab', { name: 'Python' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ connect: 'python' }))
    expect(screen.getByTestId('connect-snippet')).toHaveTextContent('firebase_admin')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(router.state.location.search).toEqual({ path: 'users' }))
  })
})
