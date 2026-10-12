// The functions seeder. The compute journeys write their own documents and
// call as `SEED_USERS` (`./identities.mjs`, created by the Firestore
// seeder), so there is nothing to write here; what it does is wait until
// every codebase and extension instance has finished its first load, so a
// journey starts from functions that are listed, not from "Discovering…".
// The stream owns this file.

/** How long the first loads may take (the SDK's discovery of each codebase). */
const SETTLE_MS = 90_000

/** @param {{ origin: string, project: string, ports: Record<string, number> }} engine */
export async function seed(engine) {
  const deadline = Date.now() + SETTLE_MS
  let last = 'no answer'
  while (Date.now() < deadline) {
    const response = await fetch(`${engine.origin}/console/api/v1/functions`, {
      headers: { authorization: 'Bearer owner' },
    })
    const body = await response.text()
    if (response.ok) {
      /** @type {{ codebases: { codebase: { id: string, state: string } }[] }} */
      const snapshot = JSON.parse(body)
      const loading = snapshot.codebases
        .filter((entry) => entry.codebase.state === 'loading')
        .map((entry) => entry.codebase.id)
      if (loading.length === 0) return
      last = `still loading: ${loading.join(', ')}`
    } else {
      last = `${response.status} ${body.slice(0, 200)}`
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(
    `The Functions codebases did not finish loading in ${SETTLE_MS / 1000} s (${last}).`,
  )
}
