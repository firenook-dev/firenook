// A row's type at a glance: one quiet glyph per family, the folder's own
// for folders. The list never draws a thumbnail (they belong to the grid and
// the inspector), so a folder of a thousand photos is a thousand icons, not
// a thousand image requests.

import { cn } from '@cloudflare/kumo'
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileIcon as BlankFileIcon,
  FileImageIcon,
  FilePdfIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  FolderSimpleDashedIcon,
  type Icon,
  BracketsCurlyIcon,
} from '@phosphor-icons/react'
import { createElement } from 'react'
import { type FileFamily, fileFamily } from '../mime'

const ICONS: Record<FileFamily, Icon> = {
  image: FileImageIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  pdf: FilePdfIcon,
  archive: FileArchiveIcon,
  json: BracketsCurlyIcon,
  csv: FileCsvIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  binary: BlankFileIcon,
}

/** The glyph for a file of this type and name. */
export function iconFor(contentType: string | null | undefined, name: string): Icon {
  return ICONS[fileFamily(contentType, name)]
}

export function FileIcon({
  contentType,
  name,
  size = 16,
  className,
}: {
  contentType: string | null | undefined
  name: string
  size?: number
  className?: string
}) {
  return createElement(iconFor(contentType, name), {
    size,
    className: cn('shrink-0 text-kumo-subtle', className),
    'aria-hidden': true,
  })
}

/** A folder; a marker that holds nothing is drawn dashed. */
export function FolderGlyph({
  empty = false,
  size = 16,
  className,
}: {
  empty?: boolean
  size?: number
  className?: string
}) {
  const Glyph = empty ? FolderSimpleDashedIcon : FolderIcon
  return <Glyph size={size} className={cn('shrink-0 text-kumo-subtle', className)} aria-hidden />
}
