import { describe, expect, it } from 'vitest'
import { pubsub } from '@/lib/sections/pubsub'
import { tasks } from '@/lib/sections/tasks'
import {
  messageSearch,
  queueSearch,
  resourceFromSearch,
  splitResourceName,
  taskSearch,
  topicSearch,
} from './links'

const route = (section: typeof pubsub, kind: string, key: string) => section.routes?.[kind]?.(key)

describe('where Pub/Sub things open (U-19)', () => {
  it('a topic, by its full name, on the Topics page under its project', () => {
    expect(route(pubsub, 'pubsub.topic', 'projects/demo-console/topics/orders')).toEqual({
      to: '/pubsub',
      search: { project: 'demo-console', topic: 'orders' },
    })
  })

  it('a subscription by its id under its project; the page completes its topic', () => {
    expect(
      route(pubsub, 'pubsub.subscription', 'projects/demo-console/subscriptions/orders-worker'),
    ).toEqual({ to: '/pubsub', search: { project: 'demo-console', subscription: 'orders-worker' } })
  })

  it('a schema on the Schemas page', () => {
    expect(route(pubsub, 'pubsub.schema', 'projects/demo-console/schemas/order-event')).toEqual({
      to: '/pubsub/schemas',
      search: { project: 'demo-console', schema: 'order-event' },
    })
  })

  it('a message: its topic, its project and the message open', () => {
    expect(route(pubsub, 'pubsub.message', 'projects/demo-other/topics/orders|1187')).toEqual({
      to: '/pubsub',
      search: { project: 'demo-other', topic: 'orders', message: '1187' },
    })
  })

  it('a schedule by its function id on the Schedules page', () => {
    expect(route(pubsub, 'pubsub.schedule', 'us-central1-nightlyCleanup')).toEqual({
      to: '/pubsub/schedules',
      search: { schedule: 'us-central1-nightlyCleanup' },
    })
  })

  it('ids keep the characters a resource id may hold', () => {
    expect(topicSearch('projects/p/topics/a%2Bb~c+d.e_f')).toEqual({
      project: 'p',
      topic: 'a%2Bb~c+d.e_f',
    })
  })

  it('a name under an empty project travels whole', () => {
    expect(topicSearch('projects//topics/orders')).toEqual({ topic: 'projects//topics/orders' })
    expect(resourceFromSearch('projects//topics/orders', 'topics', 'demo-console')).toBe(
      'projects//topics/orders',
    )
  })

  it('a malformed key opens the section root', () => {
    expect(route(pubsub, 'pubsub.topic', 'orders')).toEqual({ to: '/pubsub' })
    expect(route(pubsub, 'pubsub.topic', 'projects/p/subscriptions/s')).toEqual({ to: '/pubsub' })
    expect(route(pubsub, 'pubsub.message', 'projects/p/topics/orders')).toEqual({ to: '/pubsub' })
    expect(route(pubsub, 'pubsub.message', 'projects/p/topics/orders|abc')).toEqual({
      to: '/pubsub',
    })
    expect(messageSearch('|12')).toEqual({})
    expect(route(pubsub, 'pubsub.schedule', '')).toEqual({ to: '/pubsub/schedules' })
  })

  it('reads back what it wrote: an id under the page project, or a whole name', () => {
    const search = topicSearch('projects/demo-other/topics/orders')
    expect(resourceFromSearch(search.topic, 'topics', search.project ?? '')).toBe(
      'projects/demo-other/topics/orders',
    )
    expect(resourceFromSearch('orders-worker', 'subscriptions', 'demo-console')).toBe(
      'projects/demo-console/subscriptions/orders-worker',
    )
    expect(resourceFromSearch(undefined, 'topics', 'demo-console')).toBeUndefined()
    expect(resourceFromSearch('', 'topics', 'demo-console')).toBeUndefined()
  })

  it('splits names only of the asked collection', () => {
    expect(splitResourceName('projects/p/topics/t', 'topics')).toEqual({ project: 'p', id: 't' })
    expect(splitResourceName('projects/p/topics/t', 'schemas')).toBeNull()
    expect(splitResourceName('projects/p/topics/', 'topics')).toBeNull()
    expect(splitResourceName('projects/p/topics/a/b', 'topics')).toBeNull()
    expect(splitResourceName('topics/t', 'topics')).toBeNull()
  })
})

describe('where Cloud Tasks things open (U-19)', () => {
  it('a queue by its stored parts, its location named', () => {
    expect(route(tasks, 'tasks.queue', 'demo-console|us-central1|processOrder')).toEqual({
      to: '/tasks',
      search: { project: 'demo-console', queue: 'processOrder', location: 'us-central1' },
    })
  })

  it('a task: its queue and the task open, by the console id', () => {
    expect(route(tasks, 'tasks.task', 'demo-console|us-central1|processOrder|42')).toEqual({
      to: '/tasks',
      search: {
        project: 'demo-console',
        queue: 'processOrder',
        location: 'us-central1',
        task: '42',
      },
    })
  })

  it('a malformed key opens the section root', () => {
    expect(route(tasks, 'tasks.queue', 'processOrder')).toEqual({ to: '/tasks' })
    expect(route(tasks, 'tasks.queue', 'demo|us-central1|')).toEqual({ to: '/tasks' })
    expect(route(tasks, 'tasks.task', 'demo|us-central1|processOrder')).toEqual({ to: '/tasks' })
    expect(route(tasks, 'tasks.task', 'demo|us-central1|processOrder|order-1')).toEqual({
      to: '/tasks',
    })
    expect(queueSearch('a|b')).toEqual({})
    expect(taskSearch('a|b|c|')).toEqual({})
  })
})

describe('the registries', () => {
  it('stay behind their placeholders until their journeys pass', () => {
    expect(pubsub.built).toBe(false)
    // Cloud Tasks' journeys (e2e/tasks.spec.ts) pass.
    expect(tasks.built).toBe(true)
  })

  it('label every kind they route, and route every kind they label', () => {
    for (const section of [pubsub, tasks])
      expect(Object.keys(section.searchLabels ?? {}).toSorted()).toEqual(
        Object.keys(section.routes ?? {}).toSorted(),
      )
  })

  it('open dialogs from their actions with the shared parameters', () => {
    expect(pubsub.actions?.map((action) => action.link)).toEqual([
      { to: '/pubsub', search: { new: 'topic' } },
      { to: '/pubsub', search: { new: 'message' } },
      { to: '/pubsub/schemas', search: { new: 'schema' } },
      { to: '/pubsub', search: { dialog: 'setup' } },
    ])
    expect(tasks.actions?.map((action) => action.link)).toEqual([
      { to: '/tasks', search: { new: 'task' } },
    ])
  })

  it('count refusals and dead letters on Topics, and tasks out of retries on Cloud Tasks', () => {
    expect(pubsub.pages?.[0]?.badges).toEqual(['pubsub.rejected', 'pubsub.dead-lettered'])
    expect(pubsub.badges).toBeUndefined()
    expect(tasks.badges).toEqual(['tasks.failed'])
  })
})
