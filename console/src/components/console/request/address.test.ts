import { describe, expect, it } from 'vitest'
import { testStatus } from '@/test/status'
import { describeAddress, serviceAddress } from './address'

const status = testStatus({
  services: [
    { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
    { name: 'tasks', host: 'build-box.local', port: 9499, listening: true, pid: null },
    { name: 'pubsub', host: '::1', port: 8085, listening: true, pid: null },
  ],
})

describe("a service's own address", () => {
  it('is the host the engine advertises, with the service port', () => {
    expect(serviceAddress('functions', status, '127.0.0.1')).toEqual({
      origin: 'http://127.0.0.1:5001',
      host: '127.0.0.1',
      why: 'engine',
    })
    expect(serviceAddress('tasks', status, 'localhost')?.origin).toBe('http://build-box.local:9499')
  })

  it("is this page's host when the engine's is loopback and the page's is not", () => {
    const address = serviceAddress('functions', status, 'build-box.local')
    expect(address).toEqual({
      origin: 'http://build-box.local:5001',
      host: 'build-box.local',
      why: 'browser',
    })
    expect(describeAddress(address!)).toBe(
      'build-box.local, the address you opened the console with',
    )
    // A host the engine names is kept whatever the page was opened at.
    expect(serviceAddress('tasks', status, '10.1.2.3')?.why).toBe('engine')
  })

  it('brackets IPv6 and knows nothing of a service the engine does not run', () => {
    expect(serviceAddress('pubsub', status, 'localhost')?.origin).toBe('http://[::1]:8085')
    expect(describeAddress(serviceAddress('pubsub', status, '')!)).toBe("::1, the engine's address")
    expect(serviceAddress('storage', status, 'localhost')).toBeUndefined()
    expect(serviceAddress('functions', undefined, 'localhost')).toBeUndefined()
  })
})
