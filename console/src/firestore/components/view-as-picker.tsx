// Who the workbench reads as. The engine evaluates rules for the chosen
// identity on every read, so a denial here is the denial the app would get,
// with the rule that decided it in the Requests drawer.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  ShieldCheckIcon,
  UserIcon,
  UserCircleDashedIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { authUsersQuery } from '../queries'
import { describeViewAs } from '../view-as'
import { useWorkbench } from './workbench-context'

export function ViewAsPicker() {
  const workbench = useWorkbench()
  const users = useQuery(authUsersQuery(workbench.project))
  const current = workbench.viewAs
  const Icon =
    current.kind === 'owner'
      ? ShieldCheckIcon
      : current.kind === 'anonymous'
        ? UserCircleDashedIcon
        : UserIcon
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant={current.kind === 'owner' ? 'ghost' : 'secondary'}
            size="sm"
            icon={<Icon size={14} />}
            aria-label="View as"
            data-testid="view-as"
          >
            <span className="flex items-center gap-1">
              <span className="text-kumo-subtle">as</span> {describeViewAs(current)}
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.Item
          icon={ShieldCheckIcon}
          selected={current.kind === 'owner'}
          onClick={() => workbench.setViewAs({ kind: 'owner' })}
        >
          Admin (bypasses rules)
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={UserCircleDashedIcon}
          selected={current.kind === 'anonymous'}
          onClick={() => workbench.setViewAs({ kind: 'anonymous' })}
        >
          Anonymous client
        </DropdownMenu.Item>
        {(users.data ?? []).map((user) => (
          <DropdownMenu.Item
            key={user.uid}
            icon={UserIcon}
            selected={current.kind === 'user' && current.uid === user.uid}
            onClick={() => workbench.setViewAs({ kind: 'user', uid: user.uid, email: user.email })}
          >
            <span className="flex flex-col">
              <span>{user.email ?? user.displayName ?? user.uid}</span>
              <span className="font-mono text-[11px] text-kumo-subtle">{user.uid}</span>
            </span>
          </DropdownMenu.Item>
        ))}
        {users.data?.length === 0 && (
          <DropdownMenu.Item disabled>
            No Auth users yet; sign one up from your app
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
