// "Copy as code" for the open file (the inspector footer's Code), on the
// console's one CodePopover: the Web SDK, the Admin SDK for Node and REST,
// to read it or to upload a file with its metadata — real bucket, name,
// token and metadata, typed. The last dialect chosen opens first next time.

import { Tabs } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import { codeTab } from '@/components/console/request/as-code'
import { OBJECT_DIALECTS, type CodeVariant, objectAsCode, storageAddress } from '../../code'
import { useToolLabels } from './room'

export function FileCodePopover({
  object,
  defaultBucket,
}: {
  object: StorageObjectDetail
  defaultBucket: string
}) {
  const status = useQuery(statusQuery)
  const labels = useToolLabels()
  const [variant, setVariant] = useState<CodeVariant>('read')
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
  return (
    <CodePopover
      title="This file as code"
      kind="storage.object"
      label={labels}
      tabs={OBJECT_DIALECTS.map((id) => codeTab(id, objectAsCode(id, variant, forCode, address)))}
      header={
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
      }
      note={(tab) => (tab === 'rest' && address ? `For an app connected to ${address}` : undefined)}
      testId="inspector-code"
    />
  )
}
