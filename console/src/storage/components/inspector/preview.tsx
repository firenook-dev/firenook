// What a file looks like, whatever it is: an image, video or audio, a PDF,
// text and its kin, or its bytes (a zip too: what its first bytes say, and
// Download) — each preview asking the engine for only what it draws. The inspector's Details tab shows it at the
// panel's width; Quick Look shows the same preview large.

import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { mediaUrl } from '../../api'
import { previewKind } from '../../content'
import { PreviewHex } from './preview-hex'
import { PreviewImage } from './preview-image'
import { PreviewMedia } from './preview-media'
import { PreviewPdf } from './preview-pdf'
import { PreviewText, type TextEdit } from './preview-text'

export function Preview({
  object,
  project,
  large = false,
  edit,
  onQuickLook,
}: {
  object: StorageObjectDetail
  project: string
  large?: boolean
  edit?: TextEdit | undefined
  onQuickLook?: (() => void) | undefined
}) {
  if (object.placeholder)
    return (
      <p className="text-[13px] text-kumo-subtle">
        A zero-byte marker that makes its folder exist; it has nothing to show.
      </p>
    )
  const kind = previewKind(object)
  const url = mediaUrl({ bucket: object.bucket, name: object.name, generation: object.generation })
  switch (kind) {
    case 'image':
      return <PreviewImage key={url} url={url} large={large} />
    case 'video':
    case 'audio':
      return <PreviewMedia key={url} url={url} kind={kind} large={large} />
    case 'pdf':
      return <PreviewPdf key={url} url={url} large={large} />
    case 'binary':
      return <PreviewHex object={object} project={project} large={large} />
    default:
      return (
        <PreviewText
          key={`${object.name}:${object.generation}`}
          object={object}
          project={project}
          kind={kind}
          large={large}
          edit={edit}
          onQuickLook={onQuickLook}
        />
      )
  }
}
