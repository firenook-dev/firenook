// The address an app or a terminal uses to reach a service: its own port,
// never the console's mount. Code to copy and "Open in a new tab" use it;
// the console itself always sends same-origin.
//
// The host is the one the engine advertises for the service (its connect
// host: a wildcard bind reads 127.0.0.1), unless that is loopback and this
// page was opened from another machine — then this page's host, which is
// evidently how that machine is reached. `why` says which, so the Code
// popover can say it too.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { queryClient } from '@/lib/query'
import { hostLiteral, isLoopback } from '@/lib/connect'

export interface ServiceAddress {
  /** `http://127.0.0.1:5001`: scheme, host and the service's own port. */
  origin: string
  host: string
  /** `engine`: the host the engine advertises; `browser`: the host this page was opened at. */
  why: 'engine' | 'browser'
}

/** Where `service` (`functions`, `tasks`, `pubsub`…) is reached; undefined when the engine does not run it. */
export function serviceAddress(
  service: string,
  status: ConsoleStatus | undefined = queryClient.getQueryData<ConsoleStatus>(['status']),
  pageHost: string = typeof location === 'undefined' ? '' : location.hostname,
): ServiceAddress | undefined {
  const entry = status?.services.find((candidate) => candidate.name === service)
  if (!entry) return undefined
  const page = pageHost.replace(/^\[|\]$/g, '')
  const browser = isLoopback(entry.host) && page !== '' && !isLoopback(page)
  const host = browser ? page : entry.host
  return {
    origin: `http://${hostLiteral(host)}:${entry.port}`,
    host,
    why: browser ? 'browser' : 'engine',
  }
}

/** How the Code popover names the host it used. */
export function describeAddress(address: ServiceAddress): string {
  return address.why === 'browser'
    ? `${address.host}, the address you opened the console with`
    : `${address.host}, the engine's address`
}
