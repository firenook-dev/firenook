// What the listing holds: what is directly in this folder, or every file
// anywhere under it (flat, with relative names). A menu that names both,
// with how many files each would show, the way Firestore's scope picker
// names "This collection" and the group — a toggle could only show the
// state you are in. `g` flips it.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import { CaretDownIcon, FolderIcon, TreeStructureIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { MenuCheck } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { useFiles } from '../files-state'
import { folderQuery } from '../queries'

/** `340 files`, or nothing until the folder index has answered. */
function fileCount(count: number | undefined): string | undefined {
  return count === undefined
    ? undefined
    : `${formatNumber(count)} ${count === 1 ? 'file' : 'files'}`
}

export function ScopePicker() {
  const files = useFiles()
  const [open, setOpen] = useState(false)
  const folder = useQuery({
    ...folderQuery(files.project, files.bucket, files.prefix),
    enabled: open,
  })
  const where = files.prefix === '' ? `gs://${files.bucket}` : files.prefix
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        render={
          <Button
            variant={files.flat ? 'secondary' : 'ghost'}
            size="sm"
            icon={files.flat ? <TreeStructureIcon /> : <FolderIcon />}
            aria-label="Listing scope"
            data-testid="scope-picker"
          >
            <span className="flex min-w-0 items-center gap-1">
              {files.flat ? 'Everything under it' : 'This folder'}
              <CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content className="max-w-88">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-kumo-subtle">
            Listing scope
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className="items-start py-2"
            onClick={() => files.update({ flat: undefined, object: undefined })}
            data-testid="scope-folder"
          >
            <Option
              icon={FolderIcon}
              selected={!files.flat}
              name="This folder"
              count={fileCount(folder.data?.directFiles)}
              suffix="here"
            >
              Its files and the folders in it, folders first.
            </Option>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="items-start py-2"
            onClick={() => files.update({ flat: true, object: undefined })}
            data-testid="scope-flat"
          >
            <Option
              icon={TreeStructureIcon}
              selected={files.flat}
              name="Everything under it"
              count={fileCount(folder.data?.objects)}
              suffix={`under ${where}`}
            >
              Every file at any depth, named from this folder, without folders.
            </Option>
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function Option({
  icon: Icon,
  selected,
  name,
  count,
  suffix,
  children,
}: {
  icon: typeof FolderIcon
  selected: boolean
  name: string
  count: string | undefined
  suffix: string
  children: string
}) {
  return (
    <span className="flex w-full items-start gap-2">
      <Icon size={14} className="mt-0.5 shrink-0 text-kumo-subtle" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[13px] text-kumo-default">
          {name}
          {count !== undefined && (
            <span className="truncate text-[11px] text-kumo-subtle">
              <span className="font-mono tabular-nums">{count}</span> {suffix}
            </span>
          )}
        </span>
        <span className="text-[12px] leading-[1.45] text-kumo-subtle">{children}</span>
      </span>
      <MenuCheck on={selected} />
    </span>
  )
}
