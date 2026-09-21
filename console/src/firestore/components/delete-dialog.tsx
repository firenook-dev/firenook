// Deleting one or many documents, with the choice of taking their
// subcollections along. The dialog stays mounted and toggles with `paths`.

import { Button, Checkbox, Dialog, Text, useKumoToastManager } from '@cloudflare/kumo'
import { TrashIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSelection } from '../selection'
import { commit, deleteRecursively } from '../rest'
import { useWorkbench } from './workbench-context'

export function DeleteDialog({
  paths,
  onOpenChange,
}: {
  /** The documents to delete; empty keeps the dialog closed. */
  paths: string[]
  onOpenChange: (open: boolean) => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const clear = useSelection((state) => state.clear)
  const [recursive, setRecursive] = useState(true)

  const remove = useMutation({
    mutationFn: async () => {
      if (recursive) {
        // One recursive delete at a time keeps the load on the engine bounded.
        // oxlint-disable-next-line no-await-in-loop
        for (const path of paths) await deleteRecursively(workbench.scope, path)
      } else {
        await commit(
          workbench.scope,
          paths.map((path) => ({ delete: path })),
        )
      }
    },
    onSuccess: () => {
      // Close the inspector before its query refetches a document that is gone.
      if (workbench.selectedDocument && paths.includes(workbench.selectedDocument))
        workbench.selectDocument(undefined)
      clear()
      onOpenChange(false)
      toasts.add({
        title: paths.length === 1 ? 'Document deleted' : `${paths.length} documents deleted`,
        description: paths.length === 1 ? paths[0] : workbench.collectionPath,
        variant: 'success',
      })
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
    },
  })

  const count = paths.length
  const label = count === 1 ? 'Delete 1 document' : `Delete ${count} documents`
  return (
    <Dialog.Root open={count > 0} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">{label}</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <Dialog.Description className="text-kumo-subtle">
          <span className="font-mono text-[0.9em] text-kumo-default">
            {paths.slice(0, 3).join(', ')}
            {count > 3 ? ` and ${count - 3} more` : ''}
          </span>{' '}
          {count === 1 ? 'is' : 'are'} removed from the emulator. Listeners and triggers see the
          delete like any other write.
        </Dialog.Description>
        <div className="mt-4">
          <Checkbox
            checked={recursive}
            onCheckedChange={(checked) => setRecursive(Boolean(checked))}
            label="Also delete subcollections underneath"
          />
        </div>
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
