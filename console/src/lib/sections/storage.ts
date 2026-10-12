// Storage's registry entry. The section stays `built: false` — the Files
// route shows the placeholder, the nav lists no pages (`shownPages`), ⌘K
// offers none of its actions and links into it are text — until its journeys
// pass; what is filled in already is what the rest of the console routes
// through it: its two pages (Files, and Rules with the `storage.rules`
// badge), where an object, a folder or a rules decision opens, the ⌘K group
// labels, and the create actions. Buckets are not per project, so there is
// no `projectScope`.
//
// A registry file loads with the first route: icons, types and pure string
// helpers only (`splitKey`, `parentOf`).

import { FolderPlusIcon, HardDrivesIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { parentOf } from '@/storage/paths'
import type { ConsoleSection, SectionLink } from '../services'
import { splitKey } from './keys'

/** `<bucket>|<rest>`: buckets never contain `|`, so the name after it may. */
function split(key: string): [string, string] {
  const [bucket = '', rest = ''] = splitKey(key)
  return [bucket, rest]
}

export const storage: ConsoleSection = {
  id: 'storage',
  to: '/storage',
  label: 'Storage',
  services: ['storage'],
  area: 'data',
  icon: HardDrivesIcon,
  built: false,
  summary:
    'Every bucket and folder with live counts and sizes, previews for images, video, audio, PDFs, text and binaries, a metadata editor, download tokens, uploads of files and folders, move, copy and delete at any scale. Security rules have their own page: an editor that knows Storage rules, every decision with the line and values behind it, a playground and saved tests.',
  pages: [
    { to: '/storage', label: 'Files', exact: true },
    {
      to: '/storage/rules',
      label: 'Rules',
      badges: ['storage.rules'],
      keywords: 'security permissions decisions playground',
    },
  ],
  // `storage.uploads` is this tab's own badge ("3 uploading"), set by the
  // uploads beacon; `storage.jobs` comes with every section's item.
  badges: ['storage.uploads'],
  actions: [
    {
      id: 'storage.upload',
      title: 'Upload files',
      keywords: 'storage bucket object',
      icon: UploadSimpleIcon,
      link: { to: '/storage', search: { new: 'upload' } },
    },
    {
      id: 'storage.folder',
      title: 'Create a folder',
      keywords: 'storage bucket',
      icon: FolderPlusIcon,
      link: { to: '/storage', search: { new: 'folder' } },
    },
  ],
  searchLabels: { 'storage.object': 'Objects', 'storage.folder': 'Folders' },
  // Keys are the pinned ones entity.rs builds. The default bucket's `bucket`
  // param is dropped by the route, as the page writes it.
  routes: {
    'storage.object': (key): SectionLink => {
      const [bucket, name] = split(key)
      return { to: '/storage', search: { bucket, path: parentOf(name) || undefined, object: name } }
    },
    'storage.folder': (key): SectionLink => {
      const [bucket, prefix] = split(key)
      return { to: '/storage', search: { bucket, path: prefix || undefined } }
    },
    // `<bucket or *>|<decision id>`; `*` is the one scope of single-file mode.
    'storage.decision': (key): SectionLink => {
      const [scope, id] = split(key)
      return {
        to: '/storage/rules',
        search: { bucket: scope === '*' ? undefined : scope, panel: 'decisions', decision: id },
      }
    },
  },
}
