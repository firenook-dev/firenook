import { FolderIcon } from '@phosphor-icons/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubLayout } from '@/test/layout'
import { PanelTree, type PanelTreeNode, visibleRows } from './panel-tree'

const TREE: PanelTreeNode[] = [
  {
    id: 'avatars/',
    label: 'avatars',
    icon: FolderIcon,
    count: 12,
    children: [
      {
        id: 'avatars/2026/',
        label: '2026',
        count: 4,
        children: [{ id: 'avatars/2026/10/', label: '10', count: 2 }],
      },
      { id: 'avatars/2025/', label: '2025', count: 8 },
    ],
  },
  { id: 'uploads/', label: 'uploads', icon: FolderIcon, count: '9+', tone: 'warning' },
]

let restore: () => void
beforeEach(() => {
  restore = stubLayout({ height: 400 })
})
afterEach(() => {
  cleanup()
  restore()
})

describe('the rows on screen', () => {
  it('lists roots and the children of open nodes, each with its depth and place', () => {
    const rows = visibleRows(TREE, new Set(['avatars/']), undefined, 'avatars/2026/10/')
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
      ['avatars/', 0],
      ['avatars/2026/', 1],
      ['avatars/2025/', 1],
      ['uploads/', 0],
    ])
    expect(rows[0]).toMatchObject({
      open: true,
      onPath: true,
      childCount: 2,
      position: 1,
      siblings: 2,
    })
    expect(rows[1]).toMatchObject({ open: false, onPath: true, childCount: 1, parent: 'avatars/' })
    expect(rows[3]?.onPath).toBe(false)
  })

  it('keeps matches and their ancestors while filtering, all of them open', () => {
    const rows = visibleRows(TREE, new Set(), '10', undefined)
    expect(rows.map((row) => row.node.id)).toEqual([
      'avatars/',
      'avatars/2026/',
      'avatars/2026/10/',
    ])
    expect(rows.every((row) => row.childCount === 0 || row.open)).toBe(true)
  })
})

const noop = () => {}
const item = (name: string) => screen.getByRole('treeitem', { name })

function Harness({
  onOpen = noop,
  filter,
}: {
  onOpen?: (node: PanelTreeNode) => void
  filter?: string
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['avatars/']))
  return (
    <PanelTree
      nodes={TREE}
      current="avatars/2025/"
      expanded={expanded}
      onToggle={(id, open) =>
        setExpanded((now) => {
          const next = new Set(now)
          if (open) next.add(id)
          else next.delete(id)
          return next
        })
      }
      onOpen={onOpen}
      filter={filter}
      ariaLabel="Folders"
      empty="No folder is named like that."
    />
  )
}

describe('PanelTree', () => {
  it('is one tree: levels, open state and the current node announced', () => {
    render(<Harness />)
    expect(screen.getByRole('tree', { name: 'Folders' })).toBeInTheDocument()
    expect(item('avatars')).toHaveAttribute('aria-level', '1')
    expect(item('avatars')).toHaveAttribute('aria-expanded', 'true')
    expect(item('2026')).toHaveAttribute('aria-expanded', 'false')
    expect(item('2025')).toHaveAttribute('aria-current', 'location')
    expect(item('2025')).not.toHaveAttribute('aria-expanded')
    // The current row takes the roving focus.
    expect(item('2025')).toHaveAttribute('tabindex', '0')
    expect(item('avatars')).toHaveAttribute('tabindex', '-1')
  })

  it('shows +N under a shut node and tones a count', () => {
    render(<Harness />)
    expect(item('2026')).toHaveTextContent('+1')
    expect(item('uploads').querySelector('[data-tone="warning"]')).toHaveTextContent('9+')
  })

  it('keeps a zero count in the quiet ink, and draws the accent as a bar of its own', () => {
    render(
      <PanelTree
        nodes={[{ id: 'dead/', label: 'dead', count: 0, tone: 'danger' }]}
        current="dead/"
        expanded={new Set()}
        onToggle={() => {}}
        onOpen={() => {}}
        ariaLabel="Folders"
      />,
    )
    expect(item('dead').querySelector('[data-tone]')).toBeNull()
    expect(item('dead').className).toContain('before:bg-kumo-brand')
    expect(item('dead').className).not.toContain('shadow-[inset')
  })

  it('walks with the arrows: → opens then steps in, ← shuts then steps out, Enter opens', () => {
    const onOpen = vi.fn()
    render(<Harness onOpen={onOpen} />)
    const tree = screen.getByRole('tree')
    act(() => item('2025').focus())
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(item('2026')).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(item('2026')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(item('10')).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(item('2026')).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(item('2026')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'avatars/2026/' }))
  })

  it('opens on a click and toggles on the caret', () => {
    const onOpen = vi.fn()
    render(<Harness onOpen={onOpen} />)
    fireEvent.click(item('uploads'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'uploads/' }))
    fireEvent.click(item('avatars').querySelector('[data-testid="panel-tree-toggle"]') as Element)
    expect(item('avatars')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: '2025' })).toBeNull()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('says so when the filter leaves nothing', () => {
    render(<Harness filter="nope" />)
    expect(screen.getByTestId('panel-tree-empty')).toHaveTextContent(
      'No folder is named like that.',
    )
  })

  it('draws only the rows in view of a large tree', () => {
    const many: PanelTreeNode[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `queue-${index}`,
      label: `queue-${index}`,
      count: index,
    }))
    render(
      <PanelTree
        nodes={many}
        expanded={new Set()}
        onToggle={() => {}}
        onOpen={() => {}}
        ariaLabel="Queues"
      />,
    )
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40)
    expect(screen.getAllByRole('treeitem')[1]).toHaveAttribute('aria-setsize', '5000')
  })
})
