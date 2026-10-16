// What can be done to an instance from anywhere on the page — the
// toolbar, a row's menu, ⌘K, the vendor dialog — said back once in a
// toast: reload it in place. The engine announces
// every change on `extensions.changes`, so the lists refresh themselves; the
// answer is written into the cache at once so the page does not wait for
// that round trip.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { toast } from '@/lib/toasts'
import { extensionKeys, reloadInstance } from './api'

/** Why an action failed, as a toast's title and description. */
export function failureText(error: unknown): { title: string; description?: string } {
  if (error instanceof ApiError)
    return { title: error.message, ...(error.fix ? { description: error.fix } : {}) }
  return { title: error instanceof Error ? error.message : String(error) }
}

/** Reloads an instance from its source and parameter files, with one toast for the outcome. */
export function useReloadInstance(project: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (instance: string) => reloadInstance(instance),
    onSuccess: (detail, instance) => {
      client.setQueryData(extensionKeys.instance(project, instance), detail)
      void client.invalidateQueries({ queryKey: extensionKeys.instances(project) })
      toast({
        key: `extensions.reload.${instance}`,
        title: `${instance} reloaded`,
        description: `${detail.summary.functionCount} ${
          detail.summary.functionCount === 1 ? 'function' : 'functions'
        } from ${detail.summary.sourceDir ?? detail.summary.written}.`,
        tone: 'success',
        echo: false,
      })
    },
    onError: (error, instance) => {
      toast({ key: `extensions.reload.${instance}`, tone: 'danger', ...failureText(error) })
    },
  })
}
