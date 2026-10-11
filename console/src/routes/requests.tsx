import { createFileRoute, redirect } from '@tanstack/react-router'

// Rules decisions — what the Requests section was going to be — live on the
// Firestore rules page now, beside the rules they point at. The address
// stays a way there rather than a dead end.
export const Route = createFileRoute('/requests')({
  beforeLoad: () => {
    throw redirect({ to: '/firestore/rules', replace: true })
  },
})
