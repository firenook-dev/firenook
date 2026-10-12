import { Button } from '@cloudflare/kumo'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
  useInspectorRoom,
} from './inspector'
import { resetInspectorWidths } from './inspector-width'

beforeEach(() => {
  localStorage.clear()
  resetInspectorWidths()
  vi.stubGlobal('innerWidth', 1440)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const USERS = ['u_1', 'u_2', 'u_3']
const NOTHING = () => undefined

/** What a footer would read to decide whether it has room for its words. */
function Room() {
  const room = useInspectorRoom()
  return <span>{room.labels ? 'words' : 'glyphs'}</span>
}

/** An inspector over a list of three, the way a section holds one. */
function Users({ onClose = NOTHING }: { onClose?: () => void }) {
  const [at, setAt] = useState(1)
  const [tab, setTab] = useState('details')
  const uid = USERS[at] ?? ''
  return (
    <Inspector
      widthKey="auth.user"
      title={<InspectorTitle value={uid} />}
      meta="3 d ago"
      onClose={onClose}
      closeLabel="Close the user"
      noun="user"
      onPrev={at > 0 ? () => setAt(at - 1) : undefined}
      onNext={at < USERS.length - 1 ? () => setAt(at + 1) : undefined}
      tabs={{
        items: [
          { value: 'details', label: 'Details', count: 9 },
          { value: 'json', label: 'JSON' },
        ],
        value: tab,
        onChange: setTab,
      }}
      footer={<InspectorFooter tools={<Button>Code</Button>} danger={<Button>Delete</Button>} />}
      testId="user-inspector"
    >
      <p>
        showing {uid} on {tab}
      </p>
      <input aria-label="A field" />
    </Inspector>
  )
}

describe('the inspector', () => {
  it('steps to the previous and next row, and each chevron stops at its end', async () => {
    const user = userEvent.setup()
    render(<Users />)
    expect(screen.getByText('showing u_2 on details')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next user' }))
    expect(screen.getByText('showing u_3 on details')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next user' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Previous user' }))
    await user.click(screen.getByRole('button', { name: 'Previous user' }))
    expect(screen.getByText('showing u_1 on details')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous user' })).toBeDisabled()
  })

  it('puts the entity’s key in the title and the counts on the tabs', async () => {
    const user = userEvent.setup()
    render(<Users />)
    expect(screen.getByTestId('user-inspector')).toHaveTextContent('u_2')
    expect(screen.getByRole('tab', { name: 'Details · 9' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(screen.getByText('showing u_2 on json')).toBeInTheDocument()
  })

  it('closes on Escape, but not while a field inside it has the key', async () => {
    const onClose = vi.fn()
    render(<Users onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('A field'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next user' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close the user' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('remembers its own width and floats a grip on its edge', () => {
    localStorage.setItem('firenook.console.inspector-width.auth.user', '600')
    resetInspectorWidths()
    render(<Users />)
    expect(screen.getByTestId('user-inspector')).toHaveStyle({ width: '600px' })
    const grip = screen.getByTestId('user-inspector-resize')
    expect(grip).toHaveAttribute('role', 'separator')
    expect(grip).toHaveAttribute('aria-valuenow', '600')
  })

  it('draws no chevrons for a panel that is not a row of a list', () => {
    render(
      <Inspector
        widthKey="tool"
        title="Try a request"
        onClose={() => undefined}
        closeLabel="Close"
        testId="tool"
      >
        <p>tool</p>
      </Inspector>,
    )
    expect(screen.queryByRole('button', { name: /Previous/ })).not.toBeInTheDocument()
  })

  it('tells the footer when there is no room for its words', () => {
    localStorage.setItem('firenook.console.inspector-width.narrow', '320')
    resetInspectorWidths()
    render(
      <Inspector
        widthKey="narrow"
        title="t"
        onClose={() => undefined}
        closeLabel="Close"
        testId="narrow"
      >
        <Room />
      </Inspector>,
    )
    expect(screen.getByText('glyphs')).toBeInTheDocument()
  })
})

describe('an inspector section', () => {
  it('is one line when it is empty', () => {
    render(
      <InspectorSection title="Sessions" count={0} testId="sessions">
        <p>a session</p>
      </InspectorSection>,
    )
    expect(screen.getByTestId('sessions')).toHaveTextContent('Sessions · none')
    expect(screen.queryByText('a session')).not.toBeInTheDocument()
  })

  it('counts what it holds and shows it', () => {
    render(
      <InspectorSection title="Claims" count={2} action={<button type="button">Add</button>}>
        <p>admin</p>
      </InspectorSection>,
    )
    expect(screen.getByRole('heading', { name: 'Claims · 2' })).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('the inspector footer', () => {
  it('puts tools left, a rule before the destructive group, and the primary action right', () => {
    render(
      <InspectorFooter
        tools={<button type="button">Code</button>}
        danger={<button type="button">Delete</button>}
        primary={<button type="button">Save</button>}
        testId="foot"
      />,
    )
    const foot = screen.getByTestId('foot')
    const [left, right] = foot.children
    expect(left).toHaveTextContent('CodeDelete')
    expect(left?.querySelector('[aria-hidden]')).not.toBeNull()
    expect(right).toHaveTextContent('Save')
    expect(right).toHaveClass('ml-auto')
  })
})
