import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { stubLayout } from '@/test/layout'
import { DecisionsShell, listRows } from './decisions-shell'

interface Row {
  id: string
  outcome: RulesOutcome
  path: string
}

const rows: Row[] = [
  { id: 's3', outcome: 'allow', path: 'public/logo.png' },
  { id: 's2', outcome: 'deny', path: 'users/u2/a.png' },
  { id: 's1', outcome: 'error', path: 'reports/q3.pdf' },
]

/** A page holding the URL's state the way a rules page does. */
const ignore = () => {}

function Panel({
  items = rows,
  pick = false,
  onPick = ignore,
  gaps,
}: {
  items?: Row[]
  pick?: boolean
  onPick?: (row: Row) => void
  gaps?: ReadonlyMap<string, number | null>
}) {
  const [selected, setSelected] = useState<string | undefined>()
  const [picking, setPicking] = useState(pick)
  return (
    <DecisionsShell
      items={items}
      itemKey={(row) => row.id}
      isDenied={(row) => row.outcome !== 'allow'}
      selected={items.find((row) => row.id === selected)}
      onOpen={(row) => setSelected(row?.id)}
      onStep={(row) => setSelected(row.id)}
      pick={picking}
      onPick={(row) => {
        onPick(row)
        setPicking(false)
        setSelected(row.id)
      }}
      filters={<input aria-label="Folder or file" />}
      narrowed={[{ label: 'Path', value: 'users/', onRemove: () => {} }]}
      notice={<span data-testid="notice">feed is fine</span>}
      empty="No rules decisions yet."
      renderRow={(row) => <span>{row.path}</span>}
      renderDetail={(row) => <div data-testid="detail">{row.path}</div>}
      footer={<span data-testid="window">Holding the last 3 decisions</span>}
      gaps={gaps}
      renderGap={(missed) => `${missed ?? 'Some'} missed here`}
    />
  )
}

let restore: () => void
beforeEach(() => {
  restore = stubLayout({ height: 400 })
})
afterEach(() => {
  cleanup()
  restore()
})

describe('the decisions panel shell', () => {
  it('lists the rows newest first, counts the denials and carries the adapter’s parts', () => {
    render(<Panel />)
    expect(screen.getByTestId('decisions-count')).toHaveTextContent('3 decisions · 2 denied')
    expect(screen.getAllByTestId('decision-row').map((row) => row.textContent)).toEqual([
      'public/logo.png',
      'users/u2/a.png',
      'reports/q3.pdf',
    ])
    expect(screen.getAllByTestId('decision-row')[1]).toHaveAttribute('data-decision-id', 's2')
    expect(screen.getByTestId('decisions-narrowed')).toHaveTextContent('Pathusers/')
    expect(screen.getByLabelText('Folder or file')).toBeInTheDocument()
    expect(screen.getByTestId('notice')).toBeInTheDocument()
    expect(screen.getByTestId('window')).toBeInTheDocument()
  })

  it('opens a row, steps to the older and newer ones, and goes back to the list', () => {
    render(<Panel />)
    fireEvent.click(screen.getAllByTestId('decision-row')[1] as HTMLElement)
    expect(screen.getByTestId('detail')).toHaveTextContent('users/u2/a.png')
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Older decision' }))
    expect(screen.getByTestId('detail')).toHaveTextContent('reports/q3.pdf')
    expect(screen.getByRole('button', { name: 'Older decision' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Newer decision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Newer decision' }))
    expect(screen.getByRole('button', { name: 'Newer decision' })).toBeDisabled()
    fireEvent.click(screen.getByTestId('decision-back'))
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
    expect(screen.getByTestId('decisions')).toBeInTheDocument()
  })

  it('picks the newest denial once, and the list stays the list after going back', () => {
    const onPick = vi.fn()
    render(<Panel pick onPick={onPick} />)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(rows[1])
    expect(screen.getByTestId('detail')).toHaveTextContent('users/u2/a.png')
    fireEvent.click(screen.getByTestId('decision-back'))
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('says what an empty list means', () => {
    render(<Panel items={[]} />)
    expect(screen.getByTestId('decisions-empty')).toHaveTextContent('No rules decisions yet.')
    expect(screen.getByTestId('decisions-count')).toHaveTextContent('0 decisions')
  })

  it('draws a gap where decisions were missed, above the decision just older than it', () => {
    render(<Panel gaps={new Map([['s2', 1204]])} />)
    const list = screen.getByTestId('decision-list')
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'public/logo.png',
      '1204 missed here',
      'users/u2/a.png',
      'reports/q3.pdf',
    ])
    // Gaps are rows of the list, not decisions: the count is the decisions'.
    expect(screen.getByTestId('decisions-count')).toHaveTextContent('3 decisions')
  })
})

const key = (row: Row) => row.id

describe('the list’s rows', () => {
  it('are the items alone without gaps, and a gap row before the item a gap is keyed by', () => {
    expect(listRows(rows, key, undefined).map((row) => row.kind)).toEqual(['item', 'item', 'item'])
    expect(listRows(rows, key, new Map([['s1', null]]))).toEqual([
      { kind: 'item', item: rows[0] },
      { kind: 'item', item: rows[1] },
      { kind: 'gap', key: 'gap:s1', missed: null },
      { kind: 'item', item: rows[2] },
    ])
  })
})
