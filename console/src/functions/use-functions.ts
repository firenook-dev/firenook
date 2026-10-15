// What every Functions page reads the same way: the project the runtime
// serves, the Functions service as apps reach it, a function's own URL
// built from that address, whether a link into Logs leads anywhere yet,
// and copying with a toast that says what was copied.

import { useQuery } from '@tanstack/react-query'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import { statusQuery } from '@/api/queries'
import { serviceAddress } from '@/components/console/request/address'
import { linkToLogs } from '@/lib/sections/logs'
import type { SectionLink } from '@/lib/services'
import { toast } from '@/lib/toasts'
import { answersOnUrl } from './kinds'
import { urlPath } from './trigger-text'

/** The project the Functions runtime serves (the emulator's own). */
export function useFunctionsProject(): string {
  return useQuery(statusQuery).data?.projectId ?? ''
}

/** The Functions service's origin as apps reach it (`http://127.0.0.1:5001`), from the suite's directory. */
export function useFunctionsAddress(): string | undefined {
  const status = useQuery(statusQuery)
  return serviceAddress('functions', status.data)?.origin
}

/**
 * A function's URL as apps reach it — the advertised Functions address and
 * the path the engine answers on — for the kinds that answer on one; the
 * engine's own URL when the suite advertises no address.
 */
export function functionUrl(
  summary: Pick<FunctionSummary, 'kind' | 'url'>,
  address: string | undefined,
): string | undefined {
  if (!answersOnUrl(summary.kind) || !summary.url) return undefined
  const path = urlPath(summary.url)
  return address && path ? `${address}${path}` : summary.url
}

/** A link into Logs filtered as asked, or null while Logs is not running. */
export function useLogsLink(
  filter: Parameters<typeof linkToLogs>[0] | undefined,
): SectionLink | null {
  const status = useQuery(statusQuery)
  if (!filter) return null
  if (status.data?.sections.find((entry) => entry.id === 'logs')?.state === 'absent') return null
  return linkToLogs(filter)
}

/** Copies `text`, saying what was copied (or that the browser refused). */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast({ key: 'functions.copy', title: `Copied ${what}`, tone: 'success' })
  } catch {
    toast({
      key: 'functions.copy',
      title: `Could not copy ${what}`,
      description: 'The browser refused the clipboard.',
      tone: 'danger',
    })
  }
}
