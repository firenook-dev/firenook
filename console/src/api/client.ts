import type { ConsoleStatus } from './generated/ConsoleStatus'

// The engine serves the Console API next to the app, so every call is
// same-origin and relative to the console's mount path.
export const API_BASE = '/console/api/v1'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // A non-JSON error body keeps the status line as the message.
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

export const api = {
  status: (): Promise<ConsoleStatus> => getJson<ConsoleStatus>('/status'),
}
