// The Cloud Tasks seeder. By default it writes nothing: the queues come from
// the fixture's `onTaskDispatched` functions as the engine discovers them,
// and every journey enqueues its own tasks (into its own client queue when
// it changes one), so no journey depends on another's leftovers.
//
// FIRENOOK_SEED_SCALE=large fills `sendEmail` for the perf journeys: the
// queue is paused through the console API (the Tasks port has no pause),
// then 10,000 tasks — the emulator's capacity for one queue — are enqueued
// through the Tasks port as the Admin SDK sends them, 32 requests in
// flight, since the wire has no batch call. Everything is synthetic.

import { largeScale } from './identities.mjs'

/** Where the fixture's functions run. */
const LOCATION = 'us-central1'

/** Tasks one queue holds at most (`config.rs`), and so the large dataset. */
const CAPACITY = 10_000
const PARALLEL = 32

/** @param {{ origin: string, project: string, ports: Record<string, number> }} engine */
export async function seed(engine) {
  if (!largeScale()) return
  const queue = 'sendEmail'
  const key = `queue:${engine.project}-${LOCATION}-${queue}`
  const paused = await fetch(`${engine.origin}/console/api/v1/tasks/queue/pause`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner',
      'content-type': 'application/json',
      'x-firenook-console': '1',
    },
    body: JSON.stringify({ queue: key }),
  })
  if (!paused.ok)
    throw new Error(
      `Seeding Cloud Tasks: pausing ${queue} → ${paused.status} ${await paused.text()}`,
    )

  const tasks = `http://${new URL(engine.origin).hostname}:${engine.ports.tasks}/projects/${engine.project}/locations/${LOCATION}/queues/${queue}/tasks`
  let next = 0
  const lane = async () => {
    while (next < CAPACITY) {
      next += 1
      const n = next
      const body = Buffer.from(
        JSON.stringify({ data: { to: `reader-${n}@example.test`, template: 'digest' } }),
      ).toString('base64')
      const response = await fetch(tasks, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: {
            httpRequest: { url: '', headers: { 'Content-Type': 'application/json' }, body },
          },
        }),
      })
      if (!response.ok)
        throw new Error(
          `Seeding Cloud Tasks: task ${n} → ${response.status} ${await response.text()}`,
        )
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, lane))
}
