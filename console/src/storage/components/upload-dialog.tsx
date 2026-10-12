// "Upload with options…" (`?new=upload`): choose files or a folder, set
// what every file carries — the bucket's last choice is already filled in —
// and upload. Taken names are asked about once, as for a drop.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { FilePlusIcon, FolderPlusIcon, UploadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { formatBytes, formatNumber } from '@/lib/format'
import { type DroppedFile, filesFromInput } from '../drop'
import { useFiles } from '../files-state'
import { type UploadOptions, readOptions } from '../upload-options'
import { UploadOptionsFields } from './upload-options-fields'

export function UploadDialog({
  onUpload,
}: {
  onUpload: (files: DroppedFile[], options: UploadOptions) => void
}) {
  const files = useFiles()
  const open = files.search.new === 'upload'
  const [picked, setPicked] = useState<DroppedFile[]>([])
  const [options, setOptions] = useState<UploadOptions | undefined>(undefined)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const shown = options ?? readOptions(files.project, files.bucket)
  const close = () => {
    setPicked([])
    setOptions(undefined)
    files.update({ new: undefined }, { replace: true })
  }
  const bytes = picked.reduce((sum, entry) => sum + entry.file.size, 0)
  const where = files.prefix === '' ? `gs://${files.bucket}` : files.prefix
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <div className="contents" data-testid="upload-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Upload with options</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Into <span className="font-mono text-[0.9em]">{where}</span>, as{' '}
            {files.admin ? 'Admin' : 'the identity the page acts as'}. Real uploads: they meet the
            rules, get a download token and fire your Storage triggers.
          </Dialog.Description>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={<FilePlusIcon />}
              onClick={() => filesInput.current?.click()}
              data-testid="upload-dialog-files"
            >
              Choose files
            </Button>
            <Button
              variant="secondary"
              icon={<FolderPlusIcon />}
              onClick={() => folderInput.current?.click()}
              data-testid="upload-dialog-folder"
            >
              Choose a folder
            </Button>
            <Text size="sm" variant="secondary">
              {picked.length === 0
                ? 'Nothing chosen yet.'
                : `${formatNumber(picked.length)} ${picked.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`}
            </Text>
            <input
              ref={filesInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) setPicked(filesFromInput(event.target.files))
                event.target.value = ''
              }}
              data-testid="upload-dialog-input"
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => {
                if (event.target.files) setPicked(filesFromInput(event.target.files))
                event.target.value = ''
              }}
            />
          </div>
          <div className="mt-4">
            <UploadOptionsFields options={shown} onChange={setOptions} defaultOpen />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<UploadSimpleIcon />}
              disabled={picked.length === 0}
              onClick={() => {
                onUpload(picked, shown)
                close()
              }}
              data-testid="upload-dialog-confirm"
            >
              {picked.length === 0 ? 'Upload' : `Upload ${formatNumber(picked.length)}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
