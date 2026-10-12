import { describe, expect, it } from 'vitest'
import { type TriggerService, useTriggersFor } from './triggers'

describe('which functions fire for a resource, before compute answers', () => {
  it('is unknown for every service, so no confirmation says nothing listens', () => {
    const services: TriggerService[] = [
      'firestore',
      'auth',
      'storage',
      'pubsub',
      'eventarc',
      'tasks',
    ]
    for (const service of services) {
      expect(useTriggersFor(service, 'users/u1')).toBe('unknown')
      expect(useTriggersFor(service, undefined, 'deleted')).toBe('unknown')
    }
  })
})
