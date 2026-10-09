import { describe, expect, it } from 'vitest'
import {
  type DraftNode,
  diffDocument,
  emptyNode,
  nodeFrom,
  nodesFrom,
  nodesFromJson,
  nodesToJson,
  numberForm,
  parseNode,
  problemsOf,
  retype,
  sameValue,
  toggleRaw,
} from './draft'
import type { FsValue } from './value'

const text = (value: string): FsValue => ({ type: 'string', value })
const whole = (value: number, integer: boolean): FsValue => ({ type: 'number', value, integer })
const stamp = (value: string): FsValue => ({ type: 'timestamp', value })

function find(nodes: DraftNode[], name: string): DraftNode {
  const node = nodes.find((item) => item.name === name)
  if (!node) throw new Error(`no ${name}`)
  return node
}

function edit(node: DraftNode, value: string): DraftNode {
  return { ...node, text: value }
}

/** The named field, changed; every other row as it was. */
function patch(nodes: DraftNode[], name: string, change: Partial<DraftNode>): DraftNode[] {
  const next: DraftNode[] = []
  for (const node of nodes) next.push(node.name === name ? { ...node, ...change } : node)
  return next
}

describe('the draft tree', () => {
  it('reads a nested document as rows, not as JSON text', () => {
    const [node] = nodesFrom({
      billing: {
        type: 'map',
        fields: { plan: text('pro'), seats: whole(4, true) },
      },
    })
    expect(node?.type).toBe('map')
    expect(node?.children.map((child) => [child.name, child.type])).toEqual([
      ['plan', 'string'],
      ['seats', 'number'],
    ])
    // And back, unchanged.
    expect(parseNode(node as DraftNode)).toEqual({
      ok: true,
      value: { type: 'map', fields: { plan: text('pro'), seats: whole(4, true) } },
    })
  })

  it('edits a value three levels down without touching its neighbours', () => {
    const [root] = nodesFrom({
      a: {
        type: 'map',
        fields: {
          b: {
            type: 'array',
            items: [{ type: 'map', fields: { c: text('before'), d: text('x') } }],
          },
        },
      },
    })
    const node = root as DraftNode
    const inner = node.children[0]?.children[0]?.children[0] as DraftNode
    expect(inner.name).toBe('c')
    const changed: DraftNode = {
      ...node,
      children: [
        {
          ...(node.children[0] as DraftNode),
          children: [
            {
              ...(node.children[0]?.children[0] as DraftNode),
              children: [
                edit(inner, 'after'),
                node.children[0]?.children[0]?.children[1] as DraftNode,
              ],
            },
          ],
        },
      ],
    }
    expect(parseNode(changed)).toEqual({
      ok: true,
      value: {
        type: 'map',
        fields: {
          b: {
            type: 'array',
            items: [{ type: 'map', fields: { c: text('after'), d: text('x') } }],
          },
        },
      },
    })
  })
})

describe('integers and doubles', () => {
  // The bug this model exists to kill: `3.0` and `3` are different
  // Firestore types written the same way, so the text cannot say which one
  // a value is and the node has to carry it. Before this, every double that
  // read whole came back an integer the moment the field was touched.
  it('keeps a double a double when it reads whole', () => {
    const node = nodeFrom('rate', whole(3, false))
    expect(node.text).toBe('3')
    expect(numberForm(node)).toEqual({ integer: false, forced: false })
    expect(parseNode(node)).toEqual({ ok: true, value: whole(3, false) })
  })

  it('keeps an integer an integer, and lets the form be changed', () => {
    const node = nodeFrom('seats', whole(4, true))
    expect(parseNode(node)).toEqual({ ok: true, value: whole(4, true) })
    expect(parseNode({ ...node, integer: false })).toEqual({ ok: true, value: whole(4, false) })
  })

  it('forces a double once the text has a fraction, whatever the node says', () => {
    const node = { ...nodeFrom('rate', whole(3, true)), text: '3.5' }
    expect(numberForm(node)).toEqual({ integer: false, forced: true })
    expect(parseNode(node)).toEqual({ ok: true, value: whole(3.5, false) })
  })
})

describe('changing a type', () => {
  it('keeps text the new type can read and remembers the text it cannot', () => {
    const node = nodeFrom('n', text('42'))
    const asNumber = retype(node, 'number')
    expect(asNumber.text).toBe('42')
    expect(asNumber.integer).toBe(true)
    const asBoolean = retype(asNumber, 'boolean')
    expect(asBoolean.text).toBe('false')
    // Changing your mind costs nothing: the number comes back as it was.
    expect(retype(asBoolean, 'number').text).toBe('42')
  })

  it('never carries the word a null is drawn with into the next type', () => {
    const node = nodeFrom('closedAt', { type: 'null' })
    expect(node.text).toBe('null')
    expect(retype(node, 'string').text).toBe('')
    expect(retype(node, 'number').text).toBe('0')
  })

  it('leaves the entries of a map alone while it is looked at as something else', () => {
    const node = nodeFrom('m', { type: 'map', fields: { a: text('1') } })
    const away = retype(node, 'string')
    expect(away.children).toHaveLength(1)
    expect(parseNode(retype(away, 'map'))).toEqual({
      ok: true,
      value: { type: 'map', fields: { a: text('1') } },
    })
  })
})

describe('what is wrong, as you type', () => {
  it('marks the row that owns the problem, not the field above it', () => {
    const node = nodeFrom('m', { type: 'map', fields: { a: whole(1, true) } })
    const child = node.children[0] as DraftNode
    const broken = { ...node, children: [edit(child, 'banana')] }
    const problems = problemsOf([broken])
    expect(problems.get(node.id)).toBeUndefined()
    expect(problems.get(child.id)?.value).toBe('Not a number')
  })

  it('wants every entry named, once', () => {
    const nodes = [emptyNode('a', 'string'), emptyNode('a', 'string'), emptyNode('', 'string')]
    const problems = problemsOf(nodes)
    expect(problems.get(nodes[1]?.id ?? '')?.name).toBe('a is already here')
    expect(problems.get(nodes[2]?.id ?? '')?.name).toBe('A field needs a name')
    expect(problems.get(nodes[0]?.id ?? '')).toBeUndefined()
  })

  it('says nothing about the name of an array element, because it has none', () => {
    const node = nodeFrom('a', { type: 'array', items: [text('x'), text('y')] })
    expect(problemsOf([node]).size).toBe(0)
  })
})

describe('the write that saves it', () => {
  const stored = { name: text('Ada'), seats: whole(4, true), at: stamp('2026-09-20T09:00:00.000Z') }

  it('writes nothing when nothing changed', () => {
    expect(diffDocument(stored, nodesFrom(stored, true))).toEqual({ write: {}, clear: [] })
  })

  it('writes only the field that changed', () => {
    const nodes = nodesFrom(stored, true)
    const next = patch(nodes, 'seats', { text: '9' })
    expect(diffDocument(stored, next)).toEqual({ write: { seats: whole(9, true) }, clear: [] })
  })

  it('renames in one write: the new name set, the old one cleared', () => {
    const nodes = nodesFrom(stored, true)
    const next = patch(nodes, 'name', { name: 'fullName' })
    const diff = diffDocument(stored, next)
    expect(diff.write).toEqual({ fullName: text('Ada') })
    expect(diff.clear).toEqual(['name'])
  })

  it('clears a field marked for removal and brings it back on undo', () => {
    const nodes = nodesFrom(stored, true)
    const gone = patch(nodes, 'at', { removed: true })
    expect(diffDocument(stored, gone)).toEqual({ write: {}, clear: ['at'] })
    const back = patch(gone, 'at', { removed: false })
    expect(diffDocument(stored, back)).toEqual({ write: {}, clear: [] })
  })

  it('swaps two names without losing either value', () => {
    const nodes = nodesFrom({ a: text('1'), b: text('2') }, true)
    const swapped = [...patch(nodes, 'a', { name: 'b' })]
    swapped[1] = { ...(swapped[1] as DraftNode), name: 'a' }
    const diff = diffDocument({ a: text('1'), b: text('2') }, swapped)
    expect(diff.write).toEqual({ b: text('1'), a: text('2') })
    expect(diff.clear).toEqual([])
  })

  it('ignores map key order when deciding whether a value moved', () => {
    const before: FsValue = { type: 'map', fields: { a: text('1'), b: text('2') } }
    const after: FsValue = { type: 'map', fields: { b: text('2'), a: text('1') } }
    expect(sameValue(before, after)).toBe(true)
    expect(sameValue(whole(3, true), whole(3, false))).toBe(false)
  })
})

describe('the JSON view', () => {
  it('round-trips and keeps the types JSON cannot write down', () => {
    const nodes = nodesFrom({
      at: stamp('2026-09-20T09:00:00.000Z'),
      ref: { type: 'reference', value: 'users/u1', path: 'users/u1' },
      rate: whole(3, false),
    })
    const json = nodesToJson(nodes)
    expect(json).toEqual({ at: '2026-09-20T09:00:00.000Z', ref: 'users/u1', rate: 3 })
    const back = nodesFromJson(JSON.stringify({ ...json, extra: true }), nodes)
    expect(back.map((node) => [node.name, node.type])).toEqual([
      ['at', 'timestamp'],
      ['ref', 'reference'],
      ['rate', 'number'],
      ['extra', 'boolean'],
    ])
    // Including the one the text alone could never carry.
    expect(parseNode(find(back, 'rate'))).toEqual({ ok: true, value: whole(3, false) })
  })

  it('takes a changed value as the JSON writes it', () => {
    const nodes = nodesFrom({ at: stamp('2026-09-20T09:00:00.000Z') })
    const back = nodesFromJson('{"at": 7}', nodes)
    expect(find(back, 'at').type).toBe('number')
  })

  it('drops a field the JSON no longer mentions, and the diff clears it', () => {
    const stored = { a: text('1'), b: text('2') }
    const nodes = nodesFrom(stored, true)
    const back = nodesFromJson('{"a": "1"}', nodes)
    expect(back).toHaveLength(1)
    expect(diffDocument(stored, back)).toEqual({ write: {}, clear: ['b'] })
  })

  it('refuses anything that is not an object', () => {
    expect(() => nodesFromJson('[1]', [])).toThrow(/object/)
  })
})

describe('one field as JSON', () => {
  const nested = (): DraftNode =>
    nodeFrom('redirectUri', {
      type: 'map',
      fields: { dasd: { type: 'map', fields: { dsad: text('dasdsad') } } },
    })

  it('shows the subtree it is standing in for', () => {
    // It showed `{}` for a map with fields in it: a container's `text` is
    // empty — the children are the value — and the button only flipped a
    // flag, so the JSON view was reading something the rows never wrote.
    const open = toggleRaw(nested())
    expect(open.raw).toBe(true)
    expect(JSON.parse(open.text)).toEqual({ dasd: { dsad: 'dasdsad' } })
  })

  it('is the same value either way, so looking at it changes nothing', () => {
    const stored = { redirectUri: { type: 'map' as const, fields: { a: text('1') } } }
    const nodes = nodesFrom(stored, true)
    const looked = patch(nodes, 'redirectUri', toggleRaw(find(nodes, 'redirectUri')))
    expect(diffDocument(stored, looked)).toEqual({ write: {}, clear: [] })
  })

  it('takes what was typed back into rows', () => {
    const open = toggleRaw(nested())
    const typed = { ...open, text: '{"dasd": {"dsad": "changed"}, "more": 2}' }
    const rows = toggleRaw(typed)
    expect(rows.raw).toBe(false)
    expect(rows.children.map((child) => child.name)).toEqual(['dasd', 'more'])
    expect(parseNode(rows)).toEqual({
      ok: true,
      value: {
        type: 'map',
        fields: {
          dasd: { type: 'map', fields: { dsad: text('changed') } },
          more: whole(2, true),
        },
      },
    })
  })

  it('keeps the types the JSON cannot write down', () => {
    const node = nodeFrom('meta', {
      type: 'map',
      fields: { at: stamp('2026-09-20T09:00:00.000Z'), rate: whole(3, false) },
    })
    const open = toggleRaw(node)
    // Saving straight from the JSON view, without going back to rows.
    expect(parseNode(open)).toEqual({ ok: true, value: parseNodeValue(node) })
    expect(toggleRaw(open).children.map((child) => child.type)).toEqual(['timestamp', 'number'])
  })

  it('stays in JSON while the JSON is broken, rather than losing it', () => {
    const typed = { ...toggleRaw(nested()), text: '{"dasd": ' }
    expect(toggleRaw(typed)).toBe(typed)
    expect(problemsOf([typed]).get(typed.id)?.value).toBeDefined()
  })
})

function parseNodeValue(node: DraftNode): FsValue {
  const parsed = parseNode(node)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}
