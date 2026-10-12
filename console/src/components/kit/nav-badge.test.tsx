import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSeen } from '@/lib/badges'
import { useBadges } from '@/lib/live/shell'
import { testStatus } from '@/test/status'
import { CountBadge } from './count-badge'
import { NavBadge } from './nav-badge'

function withStatus(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(['status'], testStatus({ projectId: 'demo-x', instance: 'i1' }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  localStorage.clear()
  useSeen.setState({ seen: {} })
})
afterEach(() => {
  cleanup()
  useBadges.setState({ badges: new Map() })
})

describe('the nav badge', () => {
  it('carries its sentence as its accessible name, since a tooltip is not announced', () => {
    useBadges.setState({
      badges: new Map([
        [
          'firestore.rules',
          {
            id: 'firestore.rules',
            count: 1,
            kind: 'gauge',
            tone: 'danger',
            noun: { one: 'rules file does not compile', other: 'rules files do not compile' },
          },
        ],
      ]),
    })
    render(withStatus(<NavBadge ids={['firestore.rules']} testId="badge" />))
    const badge = screen.getByTestId('badge')
    expect(badge).toHaveTextContent('1')
    expect(badge).toHaveAttribute('aria-label', '1 rules file does not compile')
    expect(badge).toHaveAttribute('data-tone', 'danger')
  })

  it('renders nothing when nothing is up', () => {
    render(withStatus(<NavBadge ids={['firestore.rules']} testId="badge" />))
    expect(screen.queryByTestId('badge')).not.toBeInTheDocument()
  })

  it('caps a large count', () => {
    render(<CountBadge count={12_000} tone="attention" testId="count" />)
    expect(screen.getByTestId('count')).toHaveTextContent('999+')
  })
})
