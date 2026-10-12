// What the shell journeys (`shell.spec.ts`, `shell-engines.spec.ts`) do to
// an engine and watch a page do: Firestore writes as the owner, the status,
// the reads a page makes, the subscriptions a browser adds and removes.

import { createServer } from 'node:net'
import type { BrowserContext, Page, Request } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Engine } from '../fixtures'
import { ownerFetch } from './api'

/** A free port on loopback, for an engine that must come back on the same address. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export type Fields = Record<string, unknown>

export const documentsOf = (engine: Engine, project = engine.project) =>
  `/firestore/v1/projects/${project}/databases/(default)/documents`

/** One Firestore commit as the owner, through the console's mount. */
export async function commit(engine: Engine, writes: { path: string; fields?: Fields }[]) {
  const root = `projects/${engine.project}/databases/(default)/documents`
  const response = await ownerFetch(engine, `${documentsOf(engine)}:commit`, {
    method: 'POST',
    body: JSON.stringify({
      writes: writes.map((write) =>
        write.fields
          ? { update: { name: `${root}/${write.path}`, fields: write.fields } }
          : { delete: `${root}/${write.path}` },
      ),
    }),
  })
  expect(response.ok, `commit → ${response.status} ${await response.clone().text()}`).toBe(true)
}

export const text = (value: string) => ({ stringValue: value })

export async function statusOf(engine: Engine) {
  const response = await fetch(`${engine.origin}/console/api/v1/status`)
  return (await response.json()) as {
    projectId: string
    backgroundTriggers: { enabled: boolean; since: string | null; dropped: unknown[] }
    services: { name: string; host: string; port: number }[]
  }
}

/** Firestore reads the page makes: the URL and body of each, for what they read. */
export function firestoreReads(page: Page) {
  const reads: string[] = []
  const onRequest = (request: Request) => {
    const url = request.url()
    if (/\/firestore\/v1\/|\/console\/api\/v1\/firestore\//.test(url) && !url.endsWith(':commit'))
      reads.push(`${request.method()} ${decodeURIComponent(url)} ${request.postData() ?? ''}`)
  }
  page.on('request', onRequest)
  return {
    reads,
    stop: () => page.off('request', onRequest),
  }
}

/** Every POST that adds or removes live subscriptions in a context, by topic. */
export function subscriptionLog(context: BrowserContext) {
  const topicOf = new Map<string, string>()
  const added: string[] = []
  const removed: string[] = []
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (
      request.method() !== 'POST' ||
      !/\/console\/api\/v1\/live\/[^/]+\/subscriptions$/.test(path)
    )
      return
    const body = request.postDataJSON() as {
      add: { id: string; topic: string }[]
      remove: string[]
    }
    for (const sub of body.add) {
      topicOf.set(sub.id, sub.topic)
      added.push(sub.topic)
    }
    for (const id of body.remove) removed.push(topicOf.get(id) ?? id)
  })
  return { added, removed }
}

export const badgeOf = (page: Page) => page.getByTestId('engine-badge')
