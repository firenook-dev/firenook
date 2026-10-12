// The Files page's section panel: the bucket picker at its head with the
// bucket's menu, the folder filter, and the folder tree. The Rules page has
// no panel of its own; its side panel is part of the page.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  CopySimpleIcon,
  DotsThreeIcon,
  HardDrivesIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react'
import { type ReactNode, useState } from 'react'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { SectionPanel } from '@/components/shell/section-panel'
import { copyText } from '../copy'
import { useFiles } from '../files-state'
import { gsUrl } from '../paths'
import { useRulesPageLink } from '../rules-link'
import { BucketPicker } from './bucket-picker'
import { FolderTree } from './folder-tree'
import { OpenBucketDialog } from './open-bucket-dialog'

export function FoldersPanel({ menuItems }: { menuItems?: ReactNode }) {
  const files = useFiles()
  const [filter, setFilter] = useState('')
  const [opening, setOpening] = useState(false)
  const rules = useRulesPageLink()
  return (
    <SectionPanel label="Folders">
      <PanelHeader
        filter={
          <PanelFilter
            value={filter}
            onChange={setFilter}
            placeholder="Filter folders"
            testId="folder-filter"
          />
        }
      >
        <BucketPicker />
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<DotsThreeIcon weight="bold" />}
                aria-label="Bucket actions"
                className="!text-kumo-subtle hover:!text-kumo-default"
                data-testid="bucket-menu"
              />
            }
          />
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item
              icon={HardDrivesIcon}
              onClick={() => setOpening(true)}
              data-testid="bucket-open-by-name"
            >
              Open a bucket by name…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              icon={CopySimpleIcon}
              onClick={() => void copyText(gsUrl(files.bucket), 'the bucket’s gs:// URL')}
            >
              Copy the bucket’s gs:// URL
            </DropdownMenu.Item>
            {menuItems}
            {rules && (
              <DropdownMenu.Item
                icon={ShieldCheckIcon}
                onClick={() =>
                  rules(files.buckets.rulesMode === 'perBucket' ? { bucket: files.bucket } : {})
                }
              >
                Storage rules for this bucket
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </PanelHeader>
      <FolderTree filter={filter} />
      <OpenBucketDialog
        open={opening}
        onOpenChange={setOpening}
        known={files.buckets.buckets.map((bucket) => bucket.name)}
        rulesMode={files.buckets.rulesMode}
        onOpenBucket={files.setBucket}
      />
    </SectionPanel>
  )
}
