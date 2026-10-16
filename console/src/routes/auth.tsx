import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { UsersPage } from '@/auth/components/users-page'
import { USERS_DEFAULTS, usersSearchSchema } from '@/auth/users-search'
import { SectionFrame } from '@/components/console/section-gate'

// Authentication › Users. Every view is a link (`auth/users-search.ts`);
// the section's other pages are its siblings (`auth_.<page>.tsx`).
export const Route = createFileRoute('/auth')({
  validateSearch: usersSearchSchema,
  search: { middlewares: [stripSearchParams(USERS_DEFAULTS)] },
  component: AuthUsersRoute,
})

function AuthUsersRoute() {
  return (
    <SectionFrame section="auth">
      <UsersPage />
    </SectionFrame>
  )
}
