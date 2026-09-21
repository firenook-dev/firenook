// The one place to make something: what it offers follows where you are.
// At the root, a collection; in a collection, a document, a sibling root
// collection and an import; with a document open, a subcollection under it
// and a duplicate of it.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CopyIcon,
  FileIcon,
  FolderPlusIcon,
  FolderSimplePlusIcon,
  PlusIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useCreateDialog } from '../create'
import { documentQuery } from '../queries'
import { useWorkbench } from './workbench-context'

export function NewMenu() {
  const workbench = useWorkbench()
  const open = useCreateDialog((state) => state.open)
  const selected = workbench.selectedDocument
  const document = useQuery({
    ...documentQuery(workbench.scope, selected ?? ''),
    enabled: Boolean(selected),
  })
  const selectedId = selected?.split('/').at(-1)
  return (
    <DropdownMenu>
      <Tooltip
        content={
          workbench.collectionPath ? 'New document (n), collection or import' : 'New collection'
        }
        render={
          <DropdownMenu.Trigger
            render={
              <Button variant="primary" size="sm" icon={<PlusIcon />} data-testid="new-menu">
                <span className="flex items-center gap-1">
                  New
                  <CaretDownIcon size={12} />
                </span>
              </Button>
            }
          />
        }
      />
      <DropdownMenu.Content align="end">
        {workbench.collectionPath && (
          <DropdownMenu.Item
            icon={FileIcon}
            onClick={() => open({ kind: 'document', collection: workbench.collectionPath })}
          >
            <span className="flex flex-1 items-center gap-3">
              Document in{' '}
              <span className="font-mono text-[12px]">{lastSegment(workbench.collectionPath)}</span>
              <DropdownMenu.Shortcut>n</DropdownMenu.Shortcut>
            </span>
          </DropdownMenu.Item>
        )}
        {selected && (
          <>
            <DropdownMenu.Item
              icon={FolderSimplePlusIcon}
              onClick={() => open({ kind: 'collection', parent: selected })}
              data-testid="new-subcollection"
            >
              <span className="flex flex-col">
                <span>Subcollection under {selectedId}</span>
                <span className="font-mono text-[11px] text-kumo-subtle">{selected}/…</span>
              </span>
            </DropdownMenu.Item>
            {document.data && (
              <DropdownMenu.Item
                icon={CopyIcon}
                onClick={() => {
                  const template = document.data
                  if (template)
                    open({ kind: 'document', collection: template.collection, template })
                }}
              >
                Duplicate {selectedId}
              </DropdownMenu.Item>
            )}
          </>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={FolderPlusIcon}
          onClick={() => open({ kind: 'collection', parent: '' })}
          data-testid="new-root-collection"
        >
          Root collection
        </DropdownMenu.Item>
        {workbench.collectionPath && (
          <DropdownMenu.Item
            icon={UploadSimpleIcon}
            onClick={() => open({ kind: 'import', collection: workbench.collectionPath })}
            data-testid="new-import"
          >
            Import JSON into {lastSegment(workbench.collectionPath)}
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function lastSegment(path: string): string {
  return path.split('/').at(-1) ?? path
}
