// The one place to make users: New ▾ — a user (`n`), users from a file,
// sample users, a tenant. Each opens its dialog through `?new=`, so every
// one is a link too.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  BuildingsIcon,
  CaretDownIcon,
  PlusIcon,
  UploadSimpleIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'

export type NewChoice = 'user' | 'import' | 'sample' | 'tenant'

export function NewUserMenu({
  onChoose,
  blocked,
}: {
  onChoose: (choice: NewChoice) => void
  /** Why users cannot be made here now (the tenant was deleted). */
  blocked: string | undefined
}) {
  const trigger = (
    <Button
      variant="primary"
      size="sm"
      icon={<PlusIcon />}
      disabled={blocked !== undefined}
      data-testid="new-users-menu"
    >
      <span className="flex items-center gap-1">
        New
        <CaretDownIcon size={12} />
      </span>
    </Button>
  )
  if (blocked)
    return <Tooltip content={blocked} render={<span className="inline-flex">{trigger}</span>} />
  return (
    <DropdownMenu>
      <Tooltip
        content="New user (n), users from a file, sample users or a tenant"
        render={<DropdownMenu.Trigger render={trigger} />}
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item
          icon={UserPlusIcon}
          onClick={() => onChoose('user')}
          data-testid="new-user"
        >
          <span className="flex flex-1 items-center gap-3">
            User
            <DropdownMenu.Shortcut>n</DropdownMenu.Shortcut>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={UploadSimpleIcon}
          onClick={() => onChoose('import')}
          data-testid="new-import"
        >
          Users from a file…
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={UsersThreeIcon}
          onClick={() => onChoose('sample')}
          data-testid="new-sample"
        >
          Sample users…
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={BuildingsIcon}
          onClick={() => onChoose('tenant')}
          data-testid="new-tenant"
        >
          Tenant…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
