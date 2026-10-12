import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Completion, Completions } from './completions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Field({ top, onPick }: { top: number; onPick: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  // As in use: the list is drawn once its field is there and has focus.
  const [open, setOpen] = useState(false)
  return (
    <>
      <input
        ref={(element) => {
          ref.current = element
          if (element)
            element.getBoundingClientRect = () =>
              ({ left: 10, width: 200, top, bottom: top + 20 }) as DOMRect
        }}
        aria-label="Field"
        onFocus={() => setOpen(true)}
      />
      {open && (
        <Completions anchor={ref} testId="list">
          <Completion label="displayName" detail="string · 3" onPick={onPick} />
        </Completions>
      )}
    </>
  )
}

describe('completions', () => {
  it('hang below their field in a portal, as wide as it, and pick without stealing focus', async () => {
    vi.stubGlobal('innerHeight', 800)
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<Field top={100} onPick={onPick} />)
    await user.click(screen.getByLabelText('Field'))
    const list = screen.getByTestId('list')
    expect(list.parentElement).toBe(document.body)
    expect(list).toHaveStyle({ left: '10px', width: '200px', top: '124px' })
    await user.click(screen.getByRole('button', { name: /displayName/ }))
    expect(onPick).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Field')).toHaveFocus()
  })

  it('open upward when there is no room below', async () => {
    vi.stubGlobal('innerHeight', 800)
    render(<Field top={700} onPick={vi.fn()} />)
    await userEvent.setup().click(screen.getByLabelText('Field'))
    expect(screen.getByTestId('list')).toHaveStyle({ bottom: '104px' })
  })
})
