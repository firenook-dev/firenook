// Taking users out as a file the engine streams (`GET /users:export`):
// the current filter, the ticked users (at most 500 `uid=`, the URL's
// sensible limit — more is "Select all matching", which exports by the
// filter), or every user of the tenant. JSON is the emulator's own
// accounts.json, password hashes included, so it loads back here and with
// `--import`; CSV is for a spreadsheet and carries no hashes.

import { exportUsersHref } from './api'

/** The most users a selection export names one by one. */
export const SELECTED_EXPORT_MAX = 500

export type ExportScope = 'filter' | 'selected' | 'all'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** The file name the engine gives the export, so a saved file reads the same either way. */
export function exportFilename(
  project: string,
  tenant: string | undefined,
  format: 'json' | 'csv',
  now: Date = new Date(),
): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
  return `auth-users-${project}${tenant ? `-${tenant}` : ''}-${stamp}.${format}`
}

/** Where the engine streams this export from. */
export function exportHref(options: {
  project: string
  tenant: string | undefined
  format: 'json' | 'csv'
  scope: ExportScope
  q: string
  selected: readonly string[]
}): string {
  const { project, tenant, format } = options
  if (options.scope === 'selected')
    return exportUsersHref(project, {
      tenant,
      format,
      uids: options.selected.slice(0, SELECTED_EXPORT_MAX),
    })
  if (options.scope === 'filter') return exportUsersHref(project, { tenant, format, q: options.q })
  return exportUsersHref(project, { tenant, format })
}
