// Move or copy files and folders: where to (a gs:// path with folder
// completion), and what a taken name does (skip it, replace it, or stop).
// GCS has no move — it is a copy and a delete — so the dialog says what the
// app will see: the same tokens on a new path for a move, a new token for a
// copy, and the events Functions receive. Replacing goes through the
// destructive confirmation with the taken names. The work is one engine job.

import { Button, Dialog, Input, Radio, Text } from '@cloudflare/kumo'
import { FolderIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { StorageConflictPolicy } from '@/api/generated/storage/StorageConflictPolicy'
import { OWNER_AUTHORIZATION } from '@/lib/identity'
import { formatNumber } from '@/lib/format'
import { quoteFilterText } from '@/lib/filter'
import { useDebounced } from '@/rules/use-debounced'
import { listObjects } from '../api'
import { useFiles } from '../files-state'
import { gsUrl, normalizeFolder, parentOf, parseLocation } from '../paths'
import { ST } from '../queries'

export interface MoveRequest {
  verb: 'move' | 'copy'
  target: BulkTarget
  /** What is moved, for the title: "3 files", "users/". */
  what: string
  /** How many objects, when known (a preview fills it in otherwise). */
  objects: number | undefined
}

export function MoveDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: MoveRequest | undefined
  onCancel: () => void
  onConfirm: (
    destination: { bucket: string; prefix: string },
    policy: StorageConflictPolicy,
  ) => Promise<void>
}) {
  const files = useFiles()
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const [policy, setPolicy] = useState<StorageConflictPolicy>('skip')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const text = typed ?? gsUrl(files.bucket, files.prefix)
  const knownBuckets = files.buckets.buckets.map((bucket) => bucket.name)
  const location = parseLocation(text, { buckets: knownBuckets, bucket: files.bucket })
  const destination = location
    ? {
        bucket: location.bucket,
        prefix: location.path === '' ? '' : normalizeFolder(location.path),
      }
    : undefined
  const settled = useDebounced(text, 150)
  const at = parseLocation(settled, { buckets: knownBuckets, bucket: files.bucket })
  const parent = at ? parentOf(at.path) : ''
  const word = at ? at.path.slice(parent.length) : ''
  const completions = useQuery({
    queryKey: [ST, files.project, at?.bucket ?? '', 'move-completions', at?.path ?? ''],
    queryFn: ({ signal }) =>
      listObjects(
        {
          bucket: at?.bucket ?? files.bucket,
          prefix: parent,
          kind: 'folders',
          q: word ? quoteFilterText(word) : undefined,
        },
        { limit: 50 },
        { authorization: OWNER_AUTHORIZATION, signal },
      ),
    enabled: request !== undefined && at !== undefined,
    staleTime: 5_000,
    retry: false,
  })
  const folders = (completions.data?.items ?? [])
    .flatMap((entry) => (entry.type === 'folder' ? [entry.prefix] : []))
    .filter((prefix) => prefix.slice(parent.length).toLowerCase().startsWith(word.toLowerCase()))
    .slice(0, 8)
  const close = () => {
    setTyped(undefined)
    setPolicy('skip')
    setError(undefined)
    onCancel()
  }
  const count = request?.objects
  const howMany =
    count === undefined ? 'each file' : `${formatNumber(count)} ${count === 1 ? 'file' : 'files'}`
  const move = request?.verb === 'move'
  return (
    <Dialog.Root open={request !== undefined} onOpenChange={(open) => !open && close()}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <div className="contents" data-testid="move-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              {move ? 'Move' : 'Copy'} {request?.what}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!destination) return
              setPending(true)
              setError(undefined)
              try {
                await onConfirm(destination, policy)
                setTyped(undefined)
                setPolicy('skip')
              } catch (thrown) {
                setError(thrown instanceof Error ? thrown.message : String(thrown))
              } finally {
                setPending(false)
              }
            }}
          >
            <div className="grid gap-1.5">
              <label className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
                <span className="text-[14px] text-kumo-subtle">To</span>
                <Input
                  size="sm"
                  value={text}
                  onChange={(event) => setTyped(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  className="w-full font-mono"
                  data-testid="move-destination"
                />
              </label>
              {folders.length > 0 && (
                <div className="ml-14 flex flex-wrap gap-1" data-testid="move-completions">
                  {folders.map((prefix) => (
                    <Button
                      key={prefix}
                      variant="ghost"
                      size="xs"
                      icon={<FolderIcon />}
                      onClick={() => setTyped(gsUrl(at?.bucket ?? files.bucket, prefix))}
                    >
                      <span className="font-mono text-[12px]">{prefix}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <Radio.Group
              legend="If a name is taken"
              value={policy}
              onValueChange={(value) => setPolicy(value as StorageConflictPolicy)}
              orientation="horizontal"
            >
              <Radio.Item label="Skip it" value="skip" />
              <Radio.Item label="Replace it" value="replace" />
              <Radio.Item label="Stop" value="fail" />
            </Radio.Group>
            <ul className="grid list-disc gap-1 pl-5 text-[14px] text-kumo-subtle">
              {move ? (
                <>
                  <li>Download URLs keep their tokens; their paths change.</li>
                  <li>Functions see a delete and an upload for {howMany}.</li>
                </>
              ) : (
                <>
                  <li>Each copy gets a new download token and keeps none of the original's.</li>
                  <li>Functions see an upload for {howMany}.</li>
                </>
              )}
            </ul>
            {error && (
              <Text variant="error" size="sm">
                {error}
              </Text>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!destination}
                loading={pending}
                data-testid="move-confirm"
              >
                {move ? 'Move' : 'Copy'} {count === undefined ? '' : formatNumber(count)}
              </Button>
            </div>
          </form>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
