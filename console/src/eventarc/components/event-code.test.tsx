import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { statusQuery } from '@/api/queries'
import { testStatus } from '@/test/status'
import { emptyDraft } from '../publish'
import { EventCode } from './event-code'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function withStatus(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(
    statusQuery.queryKey,
    testStatus({
      services: [{ name: 'eventarc', host: '127.0.0.1', port: 9299, listening: true, pid: null }],
    }),
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('an event as code', () => {
  const draft = {
    ...emptyDraft('projects/p/locations/us-central1/channels/firebase', 'test.greeter.v1.greeted'),
    subject: 'greetings/ada',
    data: '{"name":"Ada"}',
  }

  it('is the Admin SDK publish first, then curl to the emulator and the event as JSON', async () => {
    render(withStatus(<EventCode draft={draft} testId="event-code" />))
    await userEvent.click(screen.getByTestId('event-code'))
    const block = await screen.findByTestId('event-code-block')
    expect(block).toHaveTextContent('test.greeter.v1.greeted')
    expect(screen.getByTestId('event-code-popover')).toHaveTextContent('Admin SDK')
    await userEvent.click(screen.getByRole('tab', { name: 'curl' }))
    expect(screen.getByTestId('event-code-block')).toHaveTextContent(
      'http://127.0.0.1:9299/projects/p/locations/us-central1/channels/firebase:publishEvents',
    )
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(screen.getByTestId('event-code-block')).toHaveTextContent('greetings/ada')
  })
})
