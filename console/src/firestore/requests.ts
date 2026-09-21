// Rules evaluations as the engine records them, over the console's
// same-origin Requests feed. Connected only while the drawer is open (the
// feed admits four clients), bounded to the last few hundred events.

import { useEffect } from 'react'
import { create } from 'zustand'
import { API_BASE } from '@/api/client'

export interface RequestEvent {
  requestId: string
  time: string
  outcome: 'allow' | 'deny' | 'error'
  method: string
  /** Relative document or collection path. */
  path: string
  database: string
  /** The uid the request carried, or none. */
  uid?: string | undefined
  /** Rule lines that fired, with whether they allowed. */
  lines: Array<{ line: number; outcome: boolean }>
  raw: unknown
}

const LIMIT = 500

interface RequestsState {
  status: 'idle' | 'connecting' | 'live' | 'unavailable'
  events: RequestEvent[]
  detail: string | undefined
  push: (event: RequestEvent) => void
  setStatus: (status: RequestsState['status'], detail?: string) => void
  clear: () => void
}

export const useRequests = create<RequestsState>((set) => ({
  status: 'idle',
  events: [],
  detail: undefined,
  push: (event) => set((state) => ({ events: [event, ...state.events].slice(0, LIMIT) })),
  setStatus: (status, detail) => set({ status, detail }),
  clear: () => set({ events: [] }),
}))

interface Frame {
  requestId?: string
  time?: string
  outcome?: 'allow' | 'deny' | 'error'
  granularAllowOutcomes?: Array<{ line: number; outcome: boolean }>
  rulesContext?: {
    method?: string
    path?: string
    request?: { mapValue?: { fields?: Record<string, unknown> } }
  }
}

export function decodeFrame(text: string): RequestEvent | undefined {
  let frame: Frame
  try {
    frame = JSON.parse(text) as Frame
  } catch {
    return undefined
  }
  if (!frame.rulesContext || !frame.outcome) return undefined
  const fullPath = frame.rulesContext.path ?? ''
  const match = /^\/databases\/([^/]+)\/documents\/?(.*)$/.exec(fullPath)
  const auth = frame.rulesContext.request?.mapValue?.fields?.auth as
    | { mapValue?: { fields?: { uid?: { stringValue?: string } } } }
    | undefined
  return {
    requestId: frame.requestId ?? crypto.randomUUID(),
    time: frame.time ?? new Date().toISOString(),
    outcome: frame.outcome,
    method: frame.rulesContext.method ?? '?',
    path: match?.[2] ?? fullPath,
    database: match?.[1] ?? '(default)',
    uid: auth?.mapValue?.fields?.uid?.stringValue,
    lines: frame.granularAllowOutcomes ?? [],
    raw: frame,
  }
}

export function useRequestsFeed(active: boolean) {
  useEffect(() => {
    if (!active) return
    const store = useRequests.getState()
    store.setStatus('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${protocol}://${window.location.host}${API_BASE}/firestore/requests`,
    )
    socket.addEventListener('open', () => useRequests.getState().setStatus('live'))
    socket.addEventListener('message', (message) => {
      const event = decodeFrame(String(message.data))
      if (event) useRequests.getState().push(event)
    })
    socket.addEventListener('error', () =>
      useRequests.getState().setStatus('unavailable', 'The Requests feed refused the connection'),
    )
    socket.addEventListener('close', (event) => {
      if (event.code !== 1000)
        useRequests.getState().setStatus('unavailable', event.reason || 'The Requests feed closed')
    })
    return () => {
      socket.close(1000)
      useRequests.getState().setStatus('idle')
    }
  }, [active])
}
