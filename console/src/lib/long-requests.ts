// The tab's budget of long requests (foundation spec §6.6). Over plain
// http the console speaks HTTP/1.1, and the browser gives one origin six
// connections, shared by every tab and every request: the live channel
// holds one, so a page that streams a function's answer, uploads files and
// reads thumbnails at once could leave the console's own reads queued
// behind it. A request that may stay open — a streamed response, an
// upload — takes a slot here first, at most three per tab; the fourth
// waits for one to free, in the order they asked.

/** Long requests one tab holds at once, besides the browser's one live channel. */
export const LONG_REQUESTS = 3

export interface LongRequestBudget {
  /** Waits for a slot; resolves with its release. Rejects when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void>
  /** Slots in use now. */
  inUse(): number
  /** Requests waiting for a slot. */
  waiting(): number
}

export function createLongRequestBudget(limit = LONG_REQUESTS): LongRequestBudget {
  let used = 0
  const queue: Array<() => void> = []
  const release = () => {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = queue.shift()
      // The slot passes straight to the next in line, so `used` never dips.
      if (next) next()
      else used -= 1
    }
  }
  return {
    acquire(signal) {
      if (signal?.aborted)
        return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      if (used < limit) {
        used += 1
        return Promise.resolve(release())
      }
      return new Promise((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', abort)
          resolve(release())
        }
        const abort = () => {
          const at = queue.indexOf(grant)
          if (at !== -1) queue.splice(at, 1)
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        queue.push(grant)
      })
    },
    inUse: () => used,
    waiting: () => queue.length,
  }
}

/** This tab's budget: every section's long requests share it. */
export const longRequests: LongRequestBudget = createLongRequestBudget()
