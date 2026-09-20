// The two mutations that need a pause: creating a document and deleting
// one or many. Both dialogs stay mounted and toggle with `open`.

import { Button, Checkbox, Dialog, Text, useKumoToastManager } from '@cloudflare/kumo'
import { TrashIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSelection } from '../selection'
import { commit, deleteRecursively, documentRoot } from '../rest'
import { encodeFields, fromJson } from '../value'
import { useWorkbench } from './workbench-context'

export function AddDocumentDialog({ session, onClose }: { session: number; onClose: () => void }) {
  const open = session > 0
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog size="lg" className="p-6">
        {/* A new session mounts a fresh form; the dialog itself stays mounted. */}
        <AddDocumentForm key={session} onClose={onClose} />
      </Dialog>
    </Dialog.Root>
  )
}

function AddDocumentForm({ onClose }: { onClose: () => void }) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const [id, setId] = useState('')
  const [json, setJson] = useState(() => `{\n  "createdAt": "${new Date().toISOString()}"\n}`)
  const [error, setError] = useState<string | undefined>()

  const create = useMutation({
    mutationFn: async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch {
        throw new Error('The fields must be a JSON object')
      }
      const value = fromJson(parsed)
      if (value.type !== 'map') throw new Error('The fields must be a JSON object')
      const documentId = id.trim() || generateId()
      const path = `${workbench.collectionPath}/${documentId}`
      await commit(workbench.scope, [
        { set: { path, fields: encodeFields(value.fields, documentRoot(workbench.scope)) } },
      ])
      return path
    },
    onSuccess: (path) => {
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      toasts.add({ title: 'Document added', description: path, variant: 'success' })
      onClose()
      workbench.selectDocument(path)
    },
    onError: (failure) => setError(failure.message),
  })

  return (
    <>
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">
          Add a document to{' '}
          <span className="font-mono text-[0.9em]">{workbench.collectionPath}</span>
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        Fields as JSON, typed the way the SDK would type them. Timestamps and references can be
        changed to their exact type in the inspector afterwards.
      </Dialog.Description>
      <div className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <Text variant="secondary" size="sm" as="span">
            Document id (blank for an auto id)
          </Text>
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            spellCheck={false}
            className="h-8 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
            data-testid="new-document-id"
          />
        </label>
        <label className="grid gap-1">
          <Text variant="secondary" size="sm" as="span">
            Fields
          </Text>
          <textarea
            value={json}
            onChange={(event) => setJson(event.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
            data-testid="new-document-json"
          />
        </label>
        {error && (
          <Text variant="error" size="sm">
            {error}
          </Text>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>
          Add document
        </Button>
      </div>
    </>
  )
}

function generateId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

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
