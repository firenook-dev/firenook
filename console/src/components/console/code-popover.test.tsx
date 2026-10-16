import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { CodePopover } from './code-popover'
import { CODE_DIALECTS, codeTab } from './request/as-code'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const tabs = [
  codeTab('node', "await getAuth().getUser('u_1')"),
  codeTab('python', "auth.get_user('u_1')"),
  { id: 'accounts', label: 'accounts.json entry', language: 'json' as const, code: '{}' },
]

describe('copy as code', () => {
  it('opens on the first tab, with the one list’s labels and languages', async () => {
    render(
      <CodePopover
        title="This user as code"
        tabs={tabs}
        kind="test.user"
        note="Sent to the Auth port at 127.0.0.1:9099, not the console."
        testId="user-code"
      />,
    )
    await userEvent.click(screen.getByTestId('user-code'))
    const block = await screen.findByTestId('user-code-block')
    expect(block).toHaveTextContent("await getAuth().getUser('u_1')")
    expect(block).toHaveAttribute('data-language', 'js')
    expect(screen.getByRole('tab', { name: CODE_DIALECTS.node.label })).toBeInTheDocument()
    expect(screen.getByTestId('user-code-popover')).toHaveTextContent('not the console')
  })

  it('remembers the last tab chosen for a kind, and falls back to the first one', async () => {
    const { unmount } = render(
      <CodePopover title="This user as code" tabs={tabs} kind="test.user" testId="user-code" />,
    )
    await userEvent.click(screen.getByTestId('user-code'))
    await userEvent.click(await screen.findByRole('tab', { name: 'Python' }))
    expect(screen.getByTestId('user-code-block')).toHaveAttribute('data-language', 'python')
    unmount()
    render(
      <CodePopover title="This user as code" tabs={tabs} kind="test.user" testId="user-code" />,
    )
    await userEvent.click(screen.getByTestId('user-code'))
    expect(await screen.findByTestId('user-code-block')).toHaveTextContent("auth.get_user('u_1')")
    cleanup()
    render(
      <CodePopover
        title="This message as code"
        tabs={[codeTab('curl', 'curl -X POST …')]}
        kind="test.user"
        testId="message-code"
      />,
    )
    await userEvent.click(screen.getByTestId('message-code'))
    expect(await screen.findByTestId('message-code-block')).toHaveTextContent('curl -X POST')
  })

  it('gives the note the tab shown, and keeps only the icon when the footer has no room', async () => {
    render(
      <CodePopover
        title="This file as code"
        tabs={[codeTab('web', 'getBytes(…)'), codeTab('rest', 'curl …')]}
        kind="test.file"
        note={(tab) => (tab === 'rest' ? 'For an app connected to 127.0.0.1:9199' : null)}
        label={false}
        testId="file-code"
      />,
    )
    const trigger = screen.getByTestId('file-code')
    expect(trigger).toHaveAccessibleName('This file as code')
    expect(trigger).not.toHaveTextContent('Code')
    await userEvent.click(trigger)
    expect(await screen.findByTestId('file-code-popover')).not.toHaveTextContent('connected to')
    await userEvent.click(screen.getByRole('tab', { name: 'REST (curl)' }))
    expect(screen.getByTestId('file-code-popover')).toHaveTextContent(
      'For an app connected to 127.0.0.1:9199',
    )
  })
})
