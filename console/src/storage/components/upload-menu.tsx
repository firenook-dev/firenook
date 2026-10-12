// Row one's primary action: Upload ▾ — files (`u`), a folder (`⇧U`), with
// options, or a new folder (`n`). The pickers are hidden inputs the menu
// clicks; what they pick goes through the same flow as a drop.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderSimplePlusIcon,
  SlidersHorizontalIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import type { RefObject } from 'react'
import { useFiles } from '../files-state'

export function UploadMenu({
  filesInput,
  folderInput,
}: {
  filesInput: RefObject<HTMLInputElement | null>
  folderInput: RefObject<HTMLInputElement | null>
}) {
  const files = useFiles()
  return (
    <DropdownMenu>
      <Tooltip
        content="Upload files (u), a folder (⇧U), or make a folder (n)"
        render={
          <DropdownMenu.Trigger
            render={
              <Button
                variant="primary"
                size="sm"
                icon={<UploadSimpleIcon />}
                data-testid="upload-menu"
              >
                <span className="flex items-center gap-1">
                  Upload
                  <CaretDownIcon size={12} />
                </span>
              </Button>
            }
          />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item
          icon={FilePlusIcon}
          onClick={() => filesInput.current?.click()}
          data-testid="upload-files"
        >
          <span className="flex flex-1 items-center gap-3">
            Upload files
            <DropdownMenu.Shortcut>u</DropdownMenu.Shortcut>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={FolderSimplePlusIcon}
          onClick={() => folderInput.current?.click()}
          data-testid="upload-folder"
        >
          <span className="flex flex-1 items-center gap-3">
            Upload a folder
            <DropdownMenu.Shortcut>⇧U</DropdownMenu.Shortcut>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={SlidersHorizontalIcon}
          onClick={() => files.update({ new: 'upload' })}
          data-testid="upload-with-options"
        >
          Upload with options…
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={FolderPlusIcon}
          onClick={() => files.update({ new: 'folder' })}
          data-testid="new-folder"
        >
          <span className="flex flex-1 items-center gap-3">
            New folder
            <DropdownMenu.Shortcut>n</DropdownMenu.Shortcut>
          </span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
