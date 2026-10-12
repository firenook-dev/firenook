// "Open Settings": where an explanation's fix is a switch (one account per
// email, email enumeration protection, a tenant's sign-in methods), the
// card that holds it, for the tenant the call was made in.

import { Link, useRouterState } from '@tanstack/react-router'

export function SettingsLink({
  tenant,
  testId,
}: {
  tenant?: string | null | undefined
  testId?: string
}) {
  const project = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).project
      return typeof value === 'string' && value !== '' ? value : undefined
    },
  })
  return (
    <Link
      to="/auth/settings"
      search={{
        section: 'sign-in',
        ...(tenant ? { tenant } : {}),
        ...(project ? { project } : {}),
      }}
      className="inline-flex h-6 items-center rounded-md px-2 text-[12px] text-kumo-link ring ring-kumo-line hover:ink focus-visible:ring-kumo-focus focus-visible:outline-none"
      data-testid={testId}
    >
      Open Settings
    </Link>
  )
}
