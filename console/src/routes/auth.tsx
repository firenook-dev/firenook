import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { UsersPage } from '@/auth/components/users-page'
import { USERS_DEFAULTS, usersSearchSchema } from '@/auth/users-search'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { auth } from '@/lib/sections/auth'

// Authentication › Users. Every view is a link (`auth/users-search.ts`);
// the section's other pages are its siblings (`auth_.<page>.tsx`). Until
// the registry says the section is built, the honest placeholder stands.
export const Route = createFileRoute('/auth')({
  validateSearch: usersSearchSchema,
  search: { middlewares: [stripSearchParams(USERS_DEFAULTS)] },
  component: AuthUsersRoute,
})

function AuthUsersRoute() {
  if (!auth.built) return <UnbuiltSection section={auth} />
  return (
    <SectionFrame section="auth">
      <UsersPage />
    </SectionFrame>
  )
}
