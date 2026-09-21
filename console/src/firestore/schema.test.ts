import { describe, expect, it } from 'vitest'
import {
  type SchemaSnapshot,
  childrenOf,
  describeChildren,
  findNode,
  flattenSchema,
  isPattern,
  patternOf,
  siblingsById,
} from './schema'

const items = {
  id: 'items',
  pattern: 'users/*/orders/*/items',
  documents: 789,
  parents: 300,
  children: [],
}
const orders = {
  id: 'orders',
  pattern: 'users/*/orders',
  documents: 311,
  parents: 80,
  children: [items],
}
const shopOrders = {
  id: 'orders',
  pattern: 'shops/*/orders',
  documents: 4,
  parents: 2,
  children: [],
}
const schema: SchemaSnapshot = {
  database: '(default)',
  revision: 9,
  documents: 1_500,
  collections: [
    { id: 'shops', pattern: 'shops', documents: 3, parents: null, children: [shopOrders] },
    {
      id: 'users',
      pattern: 'users',
      documents: 240,
      parents: null,
      children: [
        orders,
        { id: 'sessions', pattern: 'users/*/sessions', documents: 101, parents: 60, children: [] },
      ],
    },
  ],
}

describe('patterns', () => {
  it('replaces document ids and resolves a document to its collection', () => {
    expect(patternOf('users')).toBe('users')
    expect(patternOf('users/u1')).toBe('users')
    expect(patternOf('users/u1/orders')).toBe('users/*/orders')
    expect(patternOf('users/u1/orders/o1/items')).toBe('users/*/orders/*/items')
    expect(patternOf('users/*/orders')).toBe('users/*/orders')
    expect(patternOf('')).toBe('')
  })

  it('knows a pattern from a concrete path', () => {
    expect(isPattern('users/*/orders')).toBe(true)
    expect(isPattern('users/u1/orders')).toBe(false)
    expect(isPattern('')).toBe(false)
  })
})

describe('the tree', () => {
  it('finds nodes by pattern and the children under a path', () => {
    expect(findNode(schema, 'users/*/orders/*/items')).toBe(items)
    expect(findNode(schema, 'users/*/nope')).toBeUndefined()
    expect(findNode(undefined, 'users')).toBeUndefined()
    expect(childrenOf(schema, 'users/u1/orders').map((node) => node.id)).toEqual(['items'])
    expect(childrenOf(schema, 'users').map((node) => node.id)).toEqual(['orders', 'sessions'])
    expect(childrenOf(schema, 'events')).toEqual([])
  })

  it('flattens depth-first with depth and parent, and finds same-named patterns', () => {
    expect(flattenSchema(schema).map((entry) => `${entry.depth}:${entry.node.pattern}`)).toEqual([
      '0:shops',
      '1:shops/*/orders',
      '0:users',
      '1:users/*/orders',
      '2:users/*/orders/*/items',
      '1:users/*/sessions',
    ])
    expect(flattenSchema(schema)[4]?.parent).toBe(orders)
    expect(siblingsById(schema, orders)).toEqual([shopOrders])
    expect(siblingsById(schema, items)).toEqual([])
  })

  it('describes a shape in one line', () => {
    const users = schema.collections[1]
    if (!users) throw new Error('users')
    expect(describeChildren(users)).toBe('orders › items · sessions')
    expect(
      describeChildren({
        ...users,
        children: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
          id,
          pattern: `users/*/${id}`,
          documents: 1,
          parents: 1,
          children: [],
        })),
      }),
    ).toBe('a · b · c · d · +1')
  })
})
