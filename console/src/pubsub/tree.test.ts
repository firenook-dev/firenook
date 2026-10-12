import { describe, expect, it } from 'vitest'
import { PROJECT, subscriptionSummary, topicIndex, topicSummary } from './test/index-fixture'
import { mostBehind, orphanedNote, pathToCurrent, topicTree } from './tree'
import { GROUP } from './tree-store'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

const orders = topicSummary('orders', {
  counters: { published: 1204 },
  subscriptions: [
    subscriptionSummary('emulator-sub-orders', 'orders', { managed: 'functions' }),
    subscriptionSummary('orders-worker', 'orders', {
      counters: { backlog: 1201, oldestUnackedAt: ago(240) },
    }),
    subscriptionSummary('orders-push', 'orders', {
      delivery: 'push',
      counters: { backlog: 3, oldestUnackedAt: ago(2) },
    }),
  ],
  functions: [
    {
      functionId: 'us-central1-onOrderPlaced',
      name: 'onOrderPlaced',
      region: 'us-central1',
      kind: 'cloudevent',
      entity: { kind: 'functions.function', key: 'us-central1-onOrderPlaced' },
    },
  ],
})
const schedule = topicSummary('firebase-schedule-nightly', {
  kind: 'schedule',
  scheduleFunction: 'us-central1-nightly',
  subscriptions: [
    subscriptionSummary('emulator-sub-firebase-schedule-nightly', 'firebase-schedule-nightly', {
      managed: 'functions',
    }),
  ],
})
const index = topicIndex([topicSummary('audit-log'), orders, schedule], {
  otherProjects: [{ project: 'demo-other', topics: 14, subscriptions: 2 }],
  detached: [subscriptionSummary('left-behind', null, { counters: { backlog: 7 } })],
})

describe('the topics tree (PS-01)', () => {
  it('nests subscriptions and functions under each topic, the functions’ own subscription folded into its function', () => {
    const tree = topicTree(index, { now: NOW })
    const node = tree.nodes.find((entry) => entry.label === 'orders')
    expect(node?.children?.map((child) => child.label)).toEqual([
      'orders-worker',
      'orders-push',
      'onOrderPlaced',
    ])
    expect(tree.targets.get('us-central1-onOrderPlaced')).toEqual({
      kind: 'subscription',
      subscription: `projects/${PROJECT}/subscriptions/emulator-sub-orders`,
      topic: `projects/${PROJECT}/topics/orders`,
    })
  })

  it('figures a topic by its most-behind subscription, never a sum, and flags a stalled one', () => {
    const tree = topicTree(index, { now: NOW })
    const node = tree.nodes.find((entry) => entry.label === 'orders')
    expect(node?.count).toBe(1201)
    expect(node?.tone).toBe('warning')
    expect(node?.title).toBe(
      'Most behind: orders-worker, 1,201 waiting · 1,204 published since start',
    )
    const worker = node?.children?.find((child) => child.label === 'orders-worker')
    expect(worker?.tone).toBe('warning')
    expect(worker?.title).toBe(
      'No subscriber is connected and the oldest message has waited 4 minutes.',
    )
    expect(node?.children?.find((child) => child.label === 'orders-push')?.tone).toBeUndefined()
    expect(mostBehind(orders)?.id).toBe('orders-worker')
  })

  it('shows no figure on the row that is the page’s scope', () => {
    const current = `projects/${PROJECT}/subscriptions/orders-worker`
    const tree = topicTree(index, { now: NOW, current })
    const worker = tree.nodes
      .find((entry) => entry.label === 'orders')
      ?.children?.find((child) => child.id === current)
    expect(worker?.count).toBeUndefined()
    const topic = topicTree(index, { now: NOW, current: orders.name }).nodes.find(
      (entry) => entry.id === orders.name,
    )
    expect(topic?.count).toBeUndefined()
  })

  it('groups the schedules’ topics, the other projects and the topics deleted, after the topics', () => {
    const tree = topicTree(index, { now: NOW, configured: PROJECT })
    expect(tree.nodes.map((entry) => entry.id)).toEqual([
      `projects/${PROJECT}/topics/audit-log`,
      orders.name,
      GROUP.schedules,
      GROUP.other,
      GROUP.detached,
    ])
    const other = tree.nodes.find((entry) => entry.id === GROUP.other)
    expect(other?.children?.[0]).toMatchObject({ label: 'demo-other', count: 14 })
    expect(tree.targets.get('project:demo-other')).toEqual({
      kind: 'project',
      project: 'demo-other',
    })
    const deleted = tree.nodes.find((entry) => entry.id === GROUP.detached)
    expect(deleted?.children?.[0]).toMatchObject({ label: 'left-behind', count: 7 })
  })

  it('shows an orphaned functions subscription as the ordinary subscription it now is', () => {
    const orphan = topicSummary('legacy', {
      subscriptions: [
        subscriptionSummary('emulator-sub-legacy', 'legacy', { managed: 'orphaned' }),
      ],
    })
    const tree = topicTree(topicIndex([orphan]), { now: NOW })
    const child = tree.nodes[0]?.children?.[0]
    expect(child?.label).toBe('emulator-sub-legacy')
    expect(child?.title).toBe(orphanedNote('legacy'))
  })

  it('opens the way to where the page is', () => {
    expect(pathToCurrent(index, `projects/${PROJECT}/subscriptions/orders-worker`)).toEqual([
      orders.name,
    ])
    expect(pathToCurrent(index, schedule.name)).toEqual([GROUP.schedules])
    expect(pathToCurrent(index, `projects/${PROJECT}/subscriptions/left-behind`)).toEqual([
      GROUP.detached,
    ])
    expect(pathToCurrent(index, undefined)).toEqual([])
  })
})
