// One menu per user row, the same items in the same order however it is
// reached — right-click, Shift+F10, the row's ⋯, ⌘K while the row is the
// cursor: Open · Copy uid · Copy ID token · Send password reset · Disable or
// Enable · Delete…, the destructive one last in red. An item that cannot run
// stays listed, dimmed, with the reason, so the menu never changes shape.

import {
  CheckCircleIcon,
  CopyIcon,
  EnvelopeSimpleIcon,
  KeyIcon,
  ProhibitIcon,
  SidebarSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import type { RowMenuItem } from '@/components/console/row-menu'
import { copyToClipboard } from '@/lib/copy'
import { toast } from '@/lib/toasts'
import { identifierOf } from '../identifier'
import { type TenantScope, usersTenant } from '../tenant-scope'
import {
  announceSent,
  copyIdToken,
  refusal,
  sendPasswordReset,
  setUserDisabled,
} from '../user-actions'

/** Why a write is refused while the tenant in scope no longer exists. */
export const TENANT_GONE = 'This tenant no longer exists. Writing to it would create it again.'

export function useUserRowMenu(options: {
  project: string
  scope: TenantScope
  /** Writes are refused (the tenant was deleted); the reason is the tooltip. */
  blocked?: string | undefined
  onOpen: (row: AuthUserRow) => void
  onDelete: (row: AuthUserRow) => void
}): (row: AuthUserRow) => RowMenuItem[] {
  const navigate = useNavigate()
  const { project, scope, blocked } = options
  const tenant = usersTenant(scope)
  return (row) => {
    const target = { project, tenant, uid: row.uid }
    const label = identifierOf(row).text
    return [
      {
        id: 'open',
        label: 'Open',
        icon: SidebarSimpleIcon,
        shortcut: 'Enter',
        run: () => options.onOpen(row),
      },
      {
        id: 'copy-uid',
        label: 'Copy uid',
        icon: CopyIcon,
        shortcut: 'Mod+c',
        run: () => void copyToClipboard(row.uid, { what: row.uid }),
      },
      {
        id: 'copy-token',
        label: 'Copy ID token',
        icon: KeyIcon,
        run: () => void copyIdToken(target, label),
      },
      {
        id: 'password-reset',
        label: 'Send password reset',
        icon: EnvelopeSimpleIcon,
        disabled: row.email ? blocked : 'This user has no email address.',
        run: () => {
          const email = row.email
          if (!email) return
          sendPasswordReset(target, email).then(
            (activity) =>
              announceSent({
                project,
                activity,
                title: `Password reset sent to ${email}`,
                description: 'It is in the Inbox, as the email your app would have sent.',
                navigate: (link) => void navigate(link as never),
              }),
            (error: unknown) =>
              toast({
                key: `auth.reset.${row.uid}`,
                title: `The emulator did not send a password reset to ${email}`,
                description: refusal(error),
                tone: 'danger',
              }),
          )
        },
      },
      {
        id: row.disabled ? 'enable' : 'disable',
        label: row.disabled ? 'Enable' : 'Disable',
        icon: row.disabled ? CheckCircleIcon : ProhibitIcon,
        disabled: blocked,
        run: () =>
          void setUserDisabled(target, !row.disabled).then(
            () =>
              toast({
                key: `auth.disable.${row.uid}`,
                title: row.disabled ? `Enabled ${label}` : `Disabled ${label}`,
                description: row.disabled
                  ? undefined
                  : 'They cannot sign in or refresh a token; an ID token they hold keeps working until it expires.',
                tone: 'success',
              }),
            (error: unknown) =>
              toast({
                key: `auth.disable.${row.uid}`,
                title: `The emulator did not change ${label}`,
                description: refusal(error),
                tone: 'danger',
              }),
          ),
      },
      {
        id: 'delete',
        label: 'Delete…',
        icon: TrashIcon,
        danger: true,
        disabled: blocked,
        run: () => options.onDelete(row),
      },
    ]
  }
}
