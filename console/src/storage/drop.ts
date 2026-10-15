// What a drop, a file picker or a paste brings: files with the path each
// takes under the folder they land in (a dropped folder keeps its
// structure), operating-system litter left out (and counted, so the tray
// can say so), and what a paste means — an image uploads, a Storage
// location of this project offers a copy here, other text does nothing.

import { pad } from '@/lib/format'
import { type StorageLocation, parseLocation } from './paths'

/** A file and where it goes under the drop's folder (`photos/2026/a.png`). */
export interface DroppedFile {
  file: File
  path: string
}

/** Files an operating system leaves in folders that nobody means to upload. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'])

export function isSystemFile(name: string): boolean {
  return SYSTEM_FILES.has(name.slice(name.lastIndexOf('/') + 1))
}

/** Splits picked or dropped files into what uploads and what is left out. */
export function withoutSystemFiles(files: readonly DroppedFile[]): {
  files: DroppedFile[]
  skipped: string[]
} {
  const kept: DroppedFile[] = []
  const skipped: string[] = []
  for (const entry of files) {
    if (isSystemFile(entry.path)) skipped.push(entry.path)
    else kept.push(entry)
  }
  return { files: kept, skipped }
}

/** Files from an `<input type="file">`; a folder picker gives each its relative path. */
export function filesFromInput(list: FileList | readonly File[]): DroppedFile[] {
  return Array.from(list, (file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
}

/** The parts of the File System entry API a drop walk uses (a test stands in for them). */
export interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void
  createReader?: () => {
    readEntries: (
      success: (entries: EntryLike[]) => void,
      failure?: (error: unknown) => void,
    ) => void
  }
}

function fileOf(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file?.(resolve, reject))
}

async function readAll(entry: EntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader?.()
  if (!reader) return []
  const all: EntryLike[] = []
  // A directory reader answers in batches until it answers with none.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the reader's batches come one after another
    const batch = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

/** Every file under the dropped entries, each with its path from the drop. */
export async function filesFromEntries(entries: readonly EntryLike[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const walk = async (entry: EntryLike, base: string): Promise<void> => {
    if (entry.isFile) {
      out.push({ file: await fileOf(entry), path: `${base}${entry.name}` })
      return
    }
    if (!entry.isDirectory) return
    const children = await readAll(entry)
    await Promise.all(children.map((child) => walk(child, `${base}${entry.name}/`)))
  }
  await Promise.all(entries.map((entry) => walk(entry, '')))
  return out.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The files a drop holds, folders walked; plain files when the browser gives no entries. */
export async function filesFromDrop(transfer: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(transfer.items ?? [])
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry() as unknown as EntryLike | null)
    .filter((entry): entry is EntryLike => entry !== null)
  if (entries.length > 0) return filesFromEntries(entries)
  return filesFromInput(Array.from(transfer.files))
}

/** "3 files · 1 folder": what a drag carries, from what the browser says before the drop. */
export function dragSummary(transfer: DataTransfer | null): string | undefined {
  if (!transfer) return undefined
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file')
  if (items.length === 0) return undefined
  return `${items.length} ${items.length === 1 ? 'item' : 'items'}`
}

/** A drag that carries files (not text or a link). */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types).includes('Files'))
}

/** What a paste means on the Files page. */
export type PasteMeaning =
  | { kind: 'image'; file: File }
  | { kind: 'location'; location: StorageLocation }
  | { kind: 'none' }

export function pasteMeaning(
  paste: { files: readonly File[]; text: string },
  context: { buckets: readonly string[]; bucket: string },
): PasteMeaning {
  const image = paste.files.find((file) => file.type.startsWith('image/'))
  if (image) return { kind: 'image', file: image }
  const text = paste.text.trim()
  // Only a location that names a bucket this engine knows: a bare word is
  // somebody's clipboard, not a request to copy anything.
  if (/^(gs:\/\/|https?:\/\/)/i.test(text)) {
    const location = parseLocation(text, context)
    if (
      location &&
      context.buckets.includes(location.bucket) &&
      location.path !== '' &&
      !location.path.endsWith('/')
    )
      return { kind: 'location', location }
  }
  return { kind: 'none' }
}

/** `pasted-20261012-091504.png`: a pasted image's name, from the moment and its type. */
export function pastedName(now: Date, type: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const extension = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1]?.split('+')[0] ?? 'png')
  return `pasted-${stamp}.${extension}`
}
