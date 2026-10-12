// "Copy as firenook functions:invoke": the CLI command that makes the call
// the Run tab is about to make, from this request's own data — the
// function, its region, the callable's data or the test event's data in the
// shapes `packages/cli/src/invoke.mjs` reads — quoted for a POSIX shell.
// curl and fetch come from the request kit's `requestAsCode`, addressed to
// the Functions service as the suite advertises it.

import { shellQuote } from '@/components/console/request/as-code'

/** The CLI's default region: the flag is left out for it. */
const DEFAULT_REGION = 'us-central1'

function regionFlag(region: string): string[] {
  return region === DEFAULT_REGION ? [] : ['--region', region]
}

function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text.trim()
  }
}

/**
 * An HTTP function: the CLI calls the function's root and wraps a body as
 * callable data, so it can carry only a request with no path and no body.
 * Answers why not otherwise.
 */
export function httpInvokeCommand(input: {
  name: string
  region: string
  method: string
  path: string
  hasBody: boolean
}): { command: string } | { refused: string } {
  const path = input.path.trim()
  if ((path !== '' && path !== '/') || input.hasBody)
    return {
      refused:
        'functions:invoke calls the function at its root and sends a body as callable data; use curl or fetch for this request.',
    }
  const words = ['firenook', 'functions:invoke', input.name, ...regionFlag(input.region)]
  if (input.method.toUpperCase() !== 'POST') words.push('--method', input.method.toUpperCase())
  return { command: words.join(' ') }
}

/** A callable: `--data` is the data, which the CLI wraps as `{"data": …}`. */
export function callableInvokeCommand(input: {
  name: string
  region: string
  dataText: string
}): string {
  const words = ['firenook', 'functions:invoke', input.name, ...regionFlag(input.region)]
  if (input.dataText.trim() !== '') words.push('--data', shellQuote(compactJson(input.dataText)))
  return words.join(' ')
}

/** A background function: `--event-data` and the shell's own options, as the CLI builds the event from them. */
export function eventInvokeCommand(input: {
  name: string
  region: string
  eventData?: unknown
  params?: Record<string, string> | undefined
  resource?: string | undefined
  eventType?: string | undefined
}): string {
  const words = ['firenook', 'functions:invoke', input.name, ...regionFlag(input.region)]
  words.push('--event-data', shellQuote(JSON.stringify(input.eventData ?? {})))
  if (input.resource) words.push('--resource', shellQuote(input.resource))
  if (input.params && Object.keys(input.params).length > 0)
    words.push('--params', shellQuote(JSON.stringify(input.params)))
  if (input.eventType) words.push('--event-type', shellQuote(input.eventType))
  return words.join(' ')
}
