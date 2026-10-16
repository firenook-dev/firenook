// New folder (`?new=folder`, `n`). GCS has no folders: a folder is a name
// prefix, and an empty one exists only as the zero-byte marker object
// (`drafts/`) consoles make — which an app's list() sees until the folder is
// deleted. The dialog says so, checks the name as it is typed, and creates
// the marker as the identity the page acts as.

import { Button, Dialog, Input, Text } from '@cloudflare/kumo'
import { FolderPlusIcon, XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from '@/lib/toasts'
import { StorageApiError, createFolder } from '../api'
import { useFiles } from '../files-state'
import { asIdentity } from '../queries'

/** GCS's limit on a whole object name, in bytes. */
const NAME_BYTES = 1_024

/** What is wrong with a new folder's name (blocks Create), and what is only unwise. */
export function folderNameProblems(
  name: string,
  parent: string,
): { error: string | undefined; warning: string | undefined } {
  if (name === '') return { error: undefined, warning: undefined }
  if (name.includes('/')) return { error: 'A folder name cannot contain /.', warning: undefined }
  if (name === '.' || name === '..')
    return { error: 'A folder cannot be called . or ..', warning: undefined }
  if (new TextEncoder().encode(`${parent}${name}/`).length > NAME_BYTES)
    return { error: 'At most 1,024 bytes with its path.', warning: undefined }
  if (/[#[\]*?]/.test(name))
    return {
      error: undefined,
      warning: '#, [, ], * and ? work here but are hard to use from gsutil and some SDK helpers.',
    }
  return { error: undefined, warning: undefined }
}

export function CreateFolderDialog() {
  const files = useFiles()
  const open = files.search.new === 'folder'
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const { error, warning } = folderNameProblems(name.trim(), files.prefix)
  const close = () => {
    setName('')
    setFailure(undefined)
    files.update({ new: undefined }, { replace: true })
  }
  const create = async () => {
    const trimmed = name.trim()
    if (trimmed === '' || error) return
    setPending(true)
    setFailure(undefined)
    try {
      const prefix = `${files.prefix}${trimmed}/`
      await asIdentity(files.viewAs, files.project, (authorization) =>
        createFolder({ bucket: files.bucket, prefix }, { authorization }),
      )
      toast({ key: 'storage-folder', title: `Created ${prefix}`, tone: 'success' })
      close()
    } catch (thrown) {
      setFailure(
        thrown instanceof StorageApiError && thrown.code === 'already-exists'
          ? 'A folder or file of that name is already here.'
          : thrown instanceof Error
            ? thrown.message
            : String(thrown),
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog size="base" className="p-6 sm:w-[448px]">
        <div className="contents" data-testid="create-folder-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">New folder</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            In{' '}
            <span className="font-mono text-[0.9em]">{files.prefix || `gs://${files.bucket}`}</span>
            . Creates an empty marker object named{' '}
            <span className="font-mono text-[0.9em]">{`${files.prefix}${name.trim() || 'name'}/`}</span>
            ; your app's list() sees it until the folder is deleted.
          </Dialog.Description>
          <form
            className="mt-4 grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <Input
              size="sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="drafts"
              aria-label="Folder name"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              className="w-full font-mono"
              data-testid="create-folder-name"
            />
            {error ? (
              <Text variant="error" size="sm">
                {error}
              </Text>
            ) : warning ? (
              <Text variant="secondary" size="sm">
                {warning}
              </Text>
            ) : null}
            {failure && (
              <Text variant="error" size="sm">
                {failure}
              </Text>
            )}
          </form>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<FolderPlusIcon />}
              disabled={name.trim() === '' || error !== undefined}
              loading={pending}
              onClick={() => void create()}
              data-testid="create-folder-confirm"
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
