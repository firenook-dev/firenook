// Deleting one or many documents, with the choice of taking their
// subcollections along. The dialog stays mounted and toggles with `target`.
//
// Two kinds of many. Ticked rows are paths the page already has. Everything
// the query matches — the selection bar's "Select all" — is mostly rows the
// page has never loaded, so it is worked out here: a plain collection goes
// in one request to the engine's own path delete, and a query or a group is
// read for its paths first and deleted in batches, with the count going up
// as it does.

import { Button, Checkbox, Dialog, Text, useKumoToastManager } from '@cloudflare/kumo'
import { TrashIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { exportPages } from '../export'
import { isEmptyQuery, printQuery } from '../query'
import { commit, deletePath } from '../rest'
import { useSelection } from '../selection'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

export type DeleteTarget =
  | { kind: 'paths'; paths: string[] }
  /** Every document the current query matches; `count` is what the count said. */
  | { kind: 'everything'; count: number }

/** Writes per commit, Firestore's own limit. */
const COMMIT_LIMIT = 500

export function DeleteDialog({
  target,
  onOpenChange,
}: {
  /** What to delete; `null` keeps the dialog closed. */
  target: DeleteTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const clear = useSelection((state) => state.clear)
  const [recursive, setRecursive] = useState(true)
  const [done, setDone] = useState<number | undefined>()

  const remove = useMutation({
    mutationFn: async (): Promise<number> => {
      if (!target) return 0
      if (target.kind === 'paths') return deletePaths(target.paths)
      // A whole collection, unfiltered: the engine's path delete takes it
      // in one request, its own documents or everything beneath them.
      if (isEmptyQuery(workbench.query) && !workbench.group)
        return deletePath(workbench.scope, workbench.collectionPath, recursive)
      const paths: string[] = []
      for await (const batch of exportPages({
        scope: workbench.scope,
        collectionPath: workbench.collectionPath,
        group: workbench.group,
        query: workbench.query,
      }))
        paths.push(...batch.map((document) => document.path))
      return deletePaths(paths)
    },
    onSuccess: (deleted) => {
      const paths = target?.kind === 'paths' ? target.paths : undefined
      // Close the inspector before its query refetches a document that is gone.
      if (
        workbench.selectedDocument &&
        (paths === undefined || paths.includes(workbench.selectedDocument))
      )
        workbench.selectDocument(undefined)
      clear()
      onOpenChange(false)
      setDone(undefined)
      toasts.add({
        title: deleted === 1 ? 'Document deleted' : `${formatNumber(deleted)} documents deleted`,
        description: paths?.length === 1 ? paths[0] : workbench.collectionPath,
        variant: 'success',
      })
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
    },
    onError: () => setDone(undefined),
  })

  /** Each path, with or without what is beneath it; how many documents went. */
  async function deletePaths(paths: readonly string[]): Promise<number> {
    let deleted = 0
    setDone(0)
    if (recursive) {
      // One recursive delete at a time keeps the load on the engine bounded.
      for (const path of paths) {
        // oxlint-disable-next-line no-await-in-loop
        deleted += await deletePath(workbench.scope, path, true)
        setDone((current) => (current ?? 0) + 1)
      }
      return deleted
    }
    for (let at = 0; at < paths.length; at += COMMIT_LIMIT) {
      const batch = paths.slice(at, at + COMMIT_LIMIT)
      // oxlint-disable-next-line no-await-in-loop
      await commit(
        workbench.scope,
        batch.map((path) => ({ delete: path })),
      )
      deleted += batch.length
      setDone(deleted)
    }
    return deleted
  }

  const count = target?.kind === 'paths' ? target.paths.length : (target?.count ?? 0)
  const everything = target?.kind === 'everything'
  const label = everything
    ? `Delete all ${formatNumber(count)} ${count === 1 ? 'document' : 'documents'}`
    : count === 1
      ? 'Delete 1 document'
      : `Delete ${formatNumber(count)} documents`
  const where = isEmptyQuery(workbench.query)
    ? workbench.collectionPath
    : `${workbench.collectionPath} matching ${printQuery(workbench.query)}`
  return (
    <Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">{label}</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <Dialog.Description className="text-kumo-subtle">
          {target?.kind === 'paths' ? (
            <>
              <span className="font-mono text-[0.9em] text-kumo-default">
                {target.paths.slice(0, 3).join(', ')}
                {count > 3 ? ` and ${count - 3} more` : ''}
              </span>{' '}
              {count === 1 ? 'is' : 'are'} removed from the emulator.
            </>
          ) : (
            <>
              Every document in{' '}
              <span className="font-mono text-[0.9em] text-kumo-default">{where}</span> is removed
              from the emulator, including the ones the grid has not loaded.
            </>
          )}{' '}
          Listeners and triggers see the delete like any other write.
        </Dialog.Description>
        <div className="mt-4">
          <Checkbox
            checked={recursive}
            onCheckedChange={(checked) => setRecursive(Boolean(checked))}
            label="Also delete subcollections underneath"
          />
        </div>
        {remove.isPending && done !== undefined && (
          <div className="mt-2" data-testid="delete-progress">
            <Text variant="secondary" size="sm">
              {formatNumber(done)} of {formatNumber(count)} deleted…
            </Text>
          </div>
        )}
        {remove.isError && (
          <div className="mt-2">
            <Text variant="error" size="sm">
              {remove.error.message}
            </Text>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            icon={<TrashIcon />}
            onClick={() => remove.mutate()}
            loading={remove.isPending}
            data-testid="confirm-delete"
          >
            {label}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
