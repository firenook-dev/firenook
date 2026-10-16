// The Files page's long requests: uploads, thumbnails and the inspector's
// preview, from one pool of the tab's three (`lib/long-requests.ts`).
//
// Over plain http a browser gives the console's origin six connections,
// shared by every tab: the live channel holds one, and a page that uploads
// three large files while drawing a grid of thumbnails would otherwise leave
// the console's own reads — a list page, an object, a save — queued behind
// them. So every long request takes a slot from the tab's budget first, and
// this pool decides who gets the next one:
//
// - the inspector's preview first (it is what the reader is looking at),
//   then tiles in view order, then uploads, in the order they asked;
// - uploads hold at most two slots while pictures are on screen or waiting,
//   so a picture never waits behind a long upload; with no picture anywhere
//   they may take all three;
// - a tile that leaves the view before its turn leaves the queue (its
//   signal aborts), and one that leaves mid-load clears its `src` and gives
//   its slot back.
//
// One slot is asked of the tab's budget at a time and handed to whoever is
// first when it arrives, so the order here holds even while another section
// of the tab (an invoke stream) has slots of its own.

import { useEffect } from 'react'
import { LONG_REQUESTS, type LongRequestBudget, longRequests } from '@/lib/long-requests'

/** Who a long request is for, in the order slots are handed out. */
export type LongRequestKind = 'preview' | 'tile' | 'upload'

/** Hands a slot back. Calling it twice is harmless. */
export type Release = () => void

interface Ticket {
  kind: LongRequestKind
  /** Tiles: the tile's place in the list; the lowest goes first. */
  order: number
  /** When it asked: ties and uploads go first come, first served. */
  seq: number
  grant: (release: Release) => void
}

export interface StoragePool {
  /** Waits for a slot; rejects with an `AbortError` when `signal` aborts first. */
  acquire(
    kind: LongRequestKind,
    options?: { order?: number; signal?: AbortSignal },
  ): Promise<Release>
  /** A picture consumer is on screen (a grid, a preview): uploads leave a slot free while any is. */
  demandPictures(): () => void
  /** For tests and the tray: slots held by kind, and how many wait. */
  snapshot(): { uploads: number; pictures: number; waiting: number }
}

/** The order slots are handed out in: the preview, tiles by place, uploads first come first served. */
function rank(ticket: Ticket): number {
  const tier = ticket.kind === 'preview' ? 0 : ticket.kind === 'tile' ? 1 : 2
  // Tiles by their place in the list; the rest first come, first served.
  const within = ticket.kind === 'tile' ? ticket.order : ticket.seq
  return tier * 1e12 + within
}

/** A pool over `budget`, at most `limit` slots at once. */
export function createStoragePool(
  budget: LongRequestBudget = longRequests,
  limit = LONG_REQUESTS,
): StoragePool {
  const waiting: Ticket[] = []
  const held = { upload: 0, picture: 0 }
  let demand = 0
  let seq = 0
  let asking = false

  const picturesWaiting = () => waiting.some((ticket) => ticket.kind !== 'upload')
  const uploadCap = () => (demand > 0 || picturesWaiting() ? limit - 1 : limit)

  /** The ticket that should get the next slot, or `undefined` when none may. */
  const best = (): Ticket | undefined => {
    let pick: Ticket | undefined
    for (const ticket of waiting) {
      if (ticket.kind === 'upload' && held.upload >= uploadCap()) continue
      if (!pick || rank(ticket) < rank(pick)) pick = ticket
    }
    return pick
  }

  const pump = async () => {
    if (asking) return
    asking = true
    try {
      while (held.upload + held.picture < limit && best() !== undefined) {
        // One slot at a time, handed to whoever is first once it arrives.
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
        const release = await budget.acquire()
        const ticket = best()
        if (!ticket) {
          release()
          continue
        }
        waiting.splice(waiting.indexOf(ticket), 1)
        const slot = ticket.kind === 'upload' ? 'upload' : 'picture'
        held[slot] += 1
        let done = false
        ticket.grant(() => {
          if (done) return
          done = true
          held[slot] -= 1
          release()
          void pump()
        })
      }
    } finally {
      asking = false
    }
  }

  return {
    acquire(kind, options = {}) {
      const { signal, order = 0 } = options
      if (signal?.aborted)
        return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'))
      return new Promise<Release>((resolve, reject) => {
        const ticket: Ticket = {
          kind,
          order,
          seq: (seq += 1),
          grant: (release) => {
            signal?.removeEventListener('abort', abort)
            resolve(release)
          },
        }
        const abort = () => {
          const at = waiting.indexOf(ticket)
          if (at !== -1) waiting.splice(at, 1)
          reject(new DOMException('The request was cancelled.', 'AbortError'))
          void pump()
        }
        signal?.addEventListener('abort', abort, { once: true })
        waiting.push(ticket)
        void pump()
      })
    },
    demandPictures() {
      demand += 1
      let done = false
      return () => {
        if (done) return
        done = true
        demand -= 1
        void pump()
      }
    },
    snapshot: () => ({ uploads: held.upload, pictures: held.picture, waiting: waiting.length }),
  }
}

/** The tab's pool: every Storage long request goes through it. */
export const storagePool: StoragePool = createStoragePool()

/** While mounted, uploads leave one slot free for pictures (a grid, a preview). */
export function usePictureDemand(active: boolean): void {
  useEffect(() => (active ? storagePool.demandPictures() : undefined), [active])
}
