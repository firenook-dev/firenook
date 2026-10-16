import { describe, expect, it } from 'vitest'
import { tasks } from '@/lib/sections/tasks'
import {
  needsLocation,
  queueAddress,
  queueLabel,
  queueResourceName,
  resolveQueue,
  tidyAddress,
} from './queue-address'
import { PROJECT, testQueue } from './fixtures.test-support'

const processOrder = testQueue('processOrder')
const sendEmail = testQueue('sendEmail')
const eastOrders = testQueue('processOrder', {}, 'us-east1')
const QUEUES = [processOrder, sendEmail]
const BOTH = [processOrder, eastOrders, sendEmail]

describe('a queue in the URL (U-17)', () => {
  it('resolves an id to its queue, and its engine key, from the list', () => {
    expect(resolveQueue(QUEUES, { queue: 'sendEmail' })).toEqual({
      queue: sendEmail,
      ambiguous: false,
      missing: false,
    })
    expect(resolveQueue(QUEUES, { queue: 'sendEmail' }).queue?.key).toBe(
      `queue:${PROJECT}-us-central1-sendEmail`,
    )
    expect(resolveQueue(QUEUES, {})).toEqual({ queue: undefined, ambiguous: false, missing: false })
    expect(resolveQueue(QUEUES, { queue: 'nothing' }).missing).toBe(true)
  })

  it('needs the location only when two locations register the id', () => {
    expect(needsLocation(QUEUES, 'processOrder')).toBe(false)
    expect(needsLocation(BOTH, 'processOrder')).toBe(true)
    expect(queueAddress(QUEUES, processOrder)).toEqual({
      queue: 'processOrder',
      location: undefined,
    })
    expect(queueAddress(BOTH, eastOrders)).toEqual({ queue: 'processOrder', location: 'us-east1' })
    expect(resolveQueue(BOTH, { queue: 'processOrder', location: 'us-east1' }).queue).toBe(
      eastOrders,
    )
    expect(resolveQueue(BOTH, { queue: 'processOrder', location: 'europe-west1' }).missing).toBe(
      true,
    )
  })

  it('takes the first location of an ambiguous id, and says so', () => {
    expect(resolveQueue(BOTH, { queue: 'processOrder' })).toEqual({
      queue: processOrder,
      ambiguous: true,
      missing: false,
    })
  })

  it('tidies a link: a location that disambiguates nothing and the configured project go', () => {
    // A `tasks.queue` link always names both.
    const linked = { project: PROJECT, queue: 'processOrder', location: 'us-central1' }
    expect(tidyAddress({ queues: QUEUES, search: linked, configured: PROJECT })).toEqual({
      project: undefined,
      location: undefined,
    })
    expect(tidyAddress({ queues: BOTH, search: linked, configured: PROJECT })).toEqual({
      project: undefined,
    })
    expect(
      tidyAddress({ queues: BOTH, search: { queue: 'processOrder' }, configured: PROJECT }),
    ).toEqual({ location: 'us-central1' })
    expect(
      tidyAddress({ queues: QUEUES, search: { queue: 'processOrder' }, configured: PROJECT }),
    ).toBeUndefined()
    // Another project is the shell scope: it stays.
    expect(
      tidyAddress({
        queues: QUEUES,
        search: { project: 'demo-elsewhere', queue: 'processOrder' },
        configured: PROJECT,
      }),
    ).toBeUndefined()
  })

  it('names a queue with its location where the id alone is ambiguous', () => {
    expect(queueLabel(QUEUES, processOrder)).toBe('processOrder')
    expect(queueLabel(BOTH, eastOrders)).toBe('processOrder · us-east1')
    expect(queueResourceName(processOrder)).toBe(
      `projects/${PROJECT}/locations/us-central1/queues/processOrder`,
    )
  })

  it('reads the links the registry writes', () => {
    const link = tasks.routes?.['tasks.task']?.(`${PROJECT}|us-central1|processOrder|42`)
    expect(link?.search).toEqual({
      project: PROJECT,
      queue: 'processOrder',
      location: 'us-central1',
      task: '42',
    })
    const search = link?.search as { queue: string; location: string }
    expect(resolveQueue(QUEUES, search).queue).toBe(processOrder)
  })
})
