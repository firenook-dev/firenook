// "Copy as code" for the open file (the inspector footer's Code): the Web
// SDK, the Admin SDK for Node and REST, to read it or to upload a file with
// its metadata — real bucket, name, token and metadata, typed.

import { Button, Popover, Tabs, Tooltip } from '@cloudflare/kumo'
import { CodeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { PanelTitle } from '@/components/kit'
import { useInspectorRoom } from '@/components/console/inspector'
import { type CodeDialect, type CodeVariant, objectAsCode, storageAddress } from '../../code'

const DIALECTS: readonly { id: CodeDialect; label: string }[] = [
  { id: 'web', label: 'Web' },
  { id: 'admin', label: 'Admin (Node.js)' },
  { id: 'rest', label: 'REST' },
]

export function CodePopover({
  object,
  defaultBucket,
}: {
  object: StorageObjectDetail
  defaultBucket: string
}) {
  const status = useQuery(statusQuery)
  const room = useInspectorRoom()
  const [variant, setVariant] = useState<CodeVariant>('read')
  const [dialect, setDialect] = useState<string>('web')
  const address = storageAddress(status.data)
  const forCode = {
    bucket: object.bucket,
    defaultBucket,
    name: object.name,
    token: object.downloadTokens[0],
    contentType: object.contentType,
    cacheControl: object.cacheControl,
    contentDisposition: object.contentDisposition,
    contentEncoding: object.contentEncoding,
    contentLanguage: object.contentLanguage,
    customMetadata: object.customMetadata,
  }
  const trigger = room.labels ? (
    <Button variant="ghost" size="sm" icon={<CodeIcon />} data-testid="inspector-code">
      Code
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={<CodeIcon />}
      aria-label="This file as code"
      data-testid="inspector-code"
    />
  )
  return (
    <Popover>
      <Tooltip content="This file as code" render={<Popover.Trigger render={trigger} />} />
      <Popover.Content
        className="grid w-[560px] max-w-[calc(100vw-2rem)] gap-2"
        data-testid="code-popover"
      >
        <div className="flex items-center justify-between gap-3">
          <PanelTitle>Copy as code</PanelTitle>
          <Tabs
            size="sm"
            variant="segmented"
            value={variant}
            onValueChange={(next) => setVariant(next as CodeVariant)}
            tabs={[
              { value: 'read', label: 'Read' },
              { value: 'upload', label: 'Upload' },
            ]}
          />
        </div>
        <CodeBlock
          value={dialect}
          onValueChange={setDialect}
          dialects={DIALECTS.map((entry) => ({
            id: entry.id,
            label: entry.label,
            code: objectAsCode(entry.id, variant, forCode, address),
          }))}
          testId="code-block"
        />
        {dialect === 'rest' && address && (
          <span className="text-[11px] text-kumo-subtle">For an app connected to {address}</span>
        )}
      </Popover.Content>
    </Popover>
  )
}
