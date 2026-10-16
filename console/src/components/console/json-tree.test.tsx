import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { giveListsALayout } from '@/test/virtual'
import { JsonTree } from './json-tree'
import {
  CUT_AT,
  PAGE,
  type FlattenOptions,
  copyText,
  flatten,
  formatPath,
  pathKey,
  preview,
  search,
} from './json-tree-model'

giveListsALayout()
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const EVENT = {
  id: 'evt_19',
  user: { uid: 'u_9f3k2', claims: { admin: true, plan: 'pro', a: 1, b: 2, c: 3 } },
  items: [1, 2, 3],
  'a-b': null,
  passwordHash: 'aGFzaGVkLXBhc3N3b3JkLWZvci11XzlmM2sy',
}

/** Masks the event's password hash, as an Auth inspector would. */
const mask = (path: readonly (string | number)[]) => path.at(-1) === 'passwordHash'

const options = (over: Partial<FlattenOptions> = {}): FlattenOptions => ({
  defaultDepth: 1,
  toggled: new Map(),
  ...over,
})
const labels = (rows: ReturnType<typeof flatten>) =>
  rows.map((row) =>
    row.kind === 'node' ? String(row.label) : row.kind === 'close' ? row.bracket : 'more',
  )

describe('the tree’s rows', () => {
  it('flatten under the open containers only', () => {
    expect(labels(flatten(EVENT, options()))).toEqual([
      'id',
      'user',
      'items',
      'a-b',
      'passwordHash',
    ])
    const open = flatten(EVENT, options({ toggled: new Map([[pathKey(['user']), true]]) }))
    expect(labels(open)).toEqual([
      'id',
      'user',
      'uid',
      'claims',
      '}',
      'items',
      'a-b',
      'passwordHash',
    ])
    // A root label is a row of its own, open, closed by its bracket.
    expect(labels(flatten({ a: 1 }, options({ rootLabel: 'data' })))).toEqual(['data', 'a', '}'])
    // A scalar with no label is still a row.
    expect(labels(flatten('just text', options()))).toEqual(['undefined'])
  })

  it('page a large container, and show more on request', () => {
    const big = Array.from({ length: PAGE * 2 + 5 }, (_, index) => index)
    const rows = flatten({ big }, options({ defaultDepth: 2 }))
    expect(rows.filter((row) => row.kind === 'node').length).toBe(1 + PAGE)
    const more = rows.find((row) => row.kind === 'more')
    expect(more).toMatchObject({ shown: PAGE, total: PAGE * 2 + 5 })
    const all = flatten(
      { big },
      options({ defaultDepth: 2, shown: new Map([[pathKey(['big']), PAGE * 2 + 5]]) }),
    )
    expect(all.some((row) => row.kind === 'more')).toBe(false)
  })

  it('write a path the way JavaScript reads it', () => {
    expect(formatPath(['data', 'items', 0, 'a-b'])).toBe('data.items[0]["a-b"]')
    expect(formatPath(['items', 0], 'data')).toBe('data.items[0]')
    expect(formatPath([0, 'x'])).toBe('[0].x')
    expect(formatPath(['has space'], 'payload')).toBe('payload["has space"]')
    expect(formatPath([])).toBe('')
  })

  it('say what a shut container holds', () => {
    expect(preview(EVENT.user.claims)).toBe('{ admin, plan, a, b, c }')
    expect(preview({ aVeryLongKeyName: 1, anotherQuiteLongOne: 2, third: 3 })).toBe(
      '{ aVeryLongKeyName, +2 }',
    )
    expect(preview([1, 2, 3])).toBe('[3 items]')
    expect(preview([1])).toBe('[1 item]')
    expect(preview([])).toBe('[]')
    expect(preview({})).toBe('{}')
  })

  it('copy a string as itself and anything else as JSON', () => {
    expect(copyText('u_1')).toBe('u_1')
    expect(copyText(null)).toBe('null')
    expect(copyText({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
  })
})

describe('the tree’s search', () => {
  it('finds keys and values in drawing order and opens every container around them', () => {
    const found = search(EVENT, 'PRO')
    expect(found.hits.map((hit) => formatPath(hit.path))).toEqual(['user.claims.plan'])
    expect(found.open).toEqual(
      new Set([pathKey([]), pathKey(['user']), pathKey(['user', 'claims'])]),
    )
    expect(search(EVENT, 'u_9f3k2').hits.map((hit) => hit.in)).toEqual(['value'])
    expect(search(EVENT, 'claims').hits.map((hit) => hit.in)).toEqual(['key'])
  })

  it('reaches past a page and asks the container to show far enough', () => {
    const big = Array.from({ length: 300 }, (_, index) => `row ${index}`)
    const found = search({ big }, 'row 250')
    expect(found.hits).toHaveLength(1)
    expect(found.shown.get(pathKey(['big']))).toBe(251)
  })

  it('never searches a masked value', () => {
    expect(search(EVENT, 'aGFz', mask).hits).toEqual([])
    expect(search(EVENT, 'aGFz').hits).toHaveLength(1)
    // Its key is not a secret.
    expect(search(EVENT, 'password', mask).hits.map((hit) => hit.in)).toEqual(['key'])
  })
})

const rowNamed = (path: string) =>
  screen.getAllByTestId('tree-row').find((row) => row.dataset.path === path) as HTMLElement

describe('the JSON tree', () => {
  it('opens a container from its caret or its preview, and folds it again', async () => {
    const user = userEvent.setup()
    render(<JsonTree value={EVENT} ariaLabel="Event" testId="tree" />)
    expect(rowNamed('user')).toHaveTextContent('user: { uid, claims }')
    expect(screen.queryByText('uid')).not.toBeInTheDocument()
    await user.click(within(rowNamed('user')).getByText('{ uid, claims }'))
    expect(rowNamed('user.uid')).toHaveTextContent('uid: "u_9f3k2"')
    await user.click(within(rowNamed('user')).getByTestId('tree-caret'))
    expect(screen.queryByText('uid')).not.toBeInTheDocument()
  })

  it('walks with the keyboard: ↓ ↑ move, → opens and steps in, ← folds and steps out', () => {
    render(<JsonTree value={EVENT} ariaLabel="Event" testId="tree" />)
    const tree = screen.getByRole('tree', { name: 'Event' })
    fireEvent.keyDown(tree, { key: 'Home' })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(rowNamed('user')).toHaveAttribute('aria-selected', 'true')
    expect(rowNamed('user')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(rowNamed('user')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(rowNamed('user.uid')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(rowNamed('user')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(rowNamed('user')).toHaveAttribute('aria-expanded', 'false')
    expect(tree).toHaveAttribute('aria-activedescendant', rowNamed('user').id)
  })

  it('copies a row’s path and value from its strip, and the value with ⌘C', async () => {
    const user = userEvent.setup()
    render(
      <JsonTree value={EVENT} rootLabel="data" defaultDepth={2} ariaLabel="Event" testId="tree" />,
    )
    await user.click(within(rowNamed('data.id')).getByTestId('tree-copy-path'))
    expect(await navigator.clipboard.readText()).toBe('data.id')
    await user.click(within(rowNamed('data.id')).getByTestId('tree-copy-value'))
    expect(await navigator.clipboard.readText()).toBe('evt_19')
    await user.click(within(rowNamed('data["a-b"]')).getByTestId('tree-copy-path'))
    expect(await navigator.clipboard.readText()).toBe('data["a-b"]')
    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'Home' })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(rowNamed('data.user')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tree, { key: 'c', ctrlKey: true, metaKey: true })
    expect(await navigator.clipboard.readText()).toBe(
      '{\n  "uid": "u_9f3k2",\n  "claims": {\n    "admin": true,\n    "plan": "pro",\n    "a": 1,\n    "b": 2,\n    "c": 3\n  }\n}',
    )
  })

  it('offers filter on a leaf’s strip when the page can filter, never on a masked value', async () => {
    const user = userEvent.setup()
    const onFilter = vi.fn()
    render(
      <JsonTree
        value={EVENT}
        rootLabel="payload"
        defaultDepth={2}
        mask={mask}
        onFilter={onFilter}
        ariaLabel="Event"
        testId="tree"
      />,
    )
    await user.click(within(rowNamed('payload.user.uid')).getByTestId('tree-filter'))
    expect(onFilter).toHaveBeenCalledWith(['user', 'uid'], 'u_9f3k2')
    expect(within(rowNamed('payload.user')).queryByTestId('tree-filter')).not.toBeInTheDocument()
    expect(
      within(rowNamed('payload.passwordHash')).queryByTestId('tree-filter'),
    ).not.toBeInTheDocument()
    cleanup()
    render(<JsonTree value={EVENT} defaultDepth={2} ariaLabel="Event" testId="tree" />)
    expect(within(rowNamed('id')).queryByTestId('tree-filter')).not.toBeInTheDocument()
  })

  it('cuts a long string with how much more there is, and shows all of it on request', async () => {
    const user = userEvent.setup()
    const note = 'x'.repeat(CUT_AT + 1234)
    render(<JsonTree value={{ note }} ariaLabel="Note" testId="tree" />)
    expect(rowNamed('note')).toHaveTextContent('1,234 more characters · Show all')
    expect(rowNamed('note').textContent).not.toContain(note)
    await user.click(within(rowNamed('note')).getByRole('button', { name: 'Show all' }))
    expect(rowNamed('note').textContent).toContain(note)
    expect(within(rowNamed('note')).getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('shows a page of a long array and the rest on request', async () => {
    const user = userEvent.setup()
    render(
      <JsonTree
        value={Array.from({ length: PAGE + 30 }, (_, index) => index)}
        ariaLabel="Numbers"
        testId="tree"
      />,
    )
    // The "more" row is the hundred-and-first: scrolled to, as a person would.
    const tree = screen.getByRole('tree')
    tree.scrollTop = 1600
    fireEvent.scroll(tree)
    expect(await screen.findByTestId('tree-more')).toHaveTextContent('30 more not shown')
    await user.click(screen.getByRole('button', { name: 'Show 30 more' }))
    expect(screen.queryByTestId('tree-more')).not.toBeInTheDocument()
  })

  it('masks a value until asked, and copies it only once shown', async () => {
    const user = userEvent.setup()
    render(
      <JsonTree
        value={EVENT}
        mask={(path) => path.at(-1) === 'passwordHash'}
        ariaLabel="Event"
        testId="tree"
      />,
    )
    const row = rowNamed('passwordHash')
    expect(row).toHaveTextContent('passwordHash: •••• (36 characters)')
    expect(within(row).queryByTestId('tree-copy-value')).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Show the value' }))
    expect(rowNamed('passwordHash')).toHaveTextContent(EVENT.passwordHash)
    await user.click(within(rowNamed('passwordHash')).getByTestId('tree-copy-value'))
    expect(await navigator.clipboard.readText()).toBe(EVENT.passwordHash)
  })

  it('opens what a search finds, marks it on a neutral ground and counts it', () => {
    const onHits = vi.fn()
    render(
      <JsonTree
        value={EVENT}
        search="pro"
        onHits={onHits}
        activeHit={0}
        ariaLabel="Event"
        testId="tree"
      />,
    )
    expect(onHits).toHaveBeenLastCalledWith(1, false)
    const mark = within(rowNamed('user.claims.plan')).getByText('pro', { selector: 'mark' })
    expect(mark).toHaveClass('bg-kumo-fill')
    expect(rowNamed('user.claims.plan')).toHaveClass('bg-kumo-tint')
  })

  it('draws a reference as a link into the section that shows it', async () => {
    await renderInConsole(
      () => (
        <JsonTree
          value={{ doc: 'users/u_1' }}
          refs={(path, value) =>
            path.at(-1) === 'doc'
              ? { kind: 'firestore.document', key: `(default)|${String(value)}` }
              : undefined
          }
          ariaLabel="Event"
          testId="tree"
        />
      ),
      { status: testStatus({ sections: [sectionEntry('firestore')] }) },
    )
    const link = screen.getByRole('link', { name: 'users/u_1' })
    expect(link.getAttribute('href')).toContain('/firestore')
    expect(link.getAttribute('href')).toContain('doc=users%2Fu_1')
  })
})
