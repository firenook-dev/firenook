import { TooltipProvider } from '@cloudflare/kumo'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionEvents } from '@/api/generated/compute/ExtensionEvents'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { handlerName, handlerSnippet, publishedText } from './events-tab'
import { VendorDialog, vendorCommand } from './vendor-dialog'

afterEach(() => {
  cleanup()
})

const STRIPE: ExtensionInstanceSummary = {
  instanceId: 'stripe',
  written: 'acme/greeter@1.2.3',
  kind: 'registry',
  reference: 'acme/greeter@1.2.3',
  version: '1.2.3',
  displayName: 'Greeter',
  name: 'greeter',
  description: null,
  publisher: 'acme',
  origin: 'cache',
  sourceDir: null,
  sidecar: true,
  offlineReady: false,
  readinessNote: null,
  state: 'running',
  error: null,
  functionCount: 1,
  ignoredFunctionCount: 0,
  warnings: [],
}

/** The words for a count the engine answered. */
const read = (data: { count: number; exact: boolean } | null) =>
  publishedText('greeter', { isPending: false, isError: false, data })

describe("an instance's events", () => {
  it('names a handler for the first allowed type, on its channel', () => {
    expect(handlerName('test.greeter.v1.greeted')).toBe('onGreeted')
    const events: ExtensionEvents = {
      channel: 'projects/p/locations/us-central1/channels/firebase',
      channelRef: null,
      source: 'projects/p/instances/greeter',
      declared: [{ type: 'test.greeter.v1.greeted', description: null, allowed: true }],
      allowed: ['test.greeter.v1.greeted'],
    }
    expect(handlerSnippet(events)).toContain("channel: 'locations/us-central1/channels/firebase'")
  })

  it('says how many it published, leaving the events themselves to Eventarc', () => {
    expect(publishedText('greeter', { isPending: true, isError: false })).toBe('Counting…')
    expect(read({ count: 0, exact: true })).toBe(
      'greeter has published no events since the engine started.',
    )
    expect(read({ count: 1, exact: true })).toBe('1 event since the engine started.')
    expect(read({ count: 1_000, exact: false })).toBe(
      '1,000 events or more since the engine started.',
    )
    expect(read(null)).toBe('Its events are in Eventarc.')
  })
})

describe('vendoring', () => {
  it('gives the CLI command for the instance, then reloads it', () => {
    expect(vendorCommand('stripe')).toBe('firenook ext:vendor --instance stripe')
    const onReload = vi.fn()
    render(
      <TooltipProvider>
        <VendorDialog
          open
          onOpenChange={() => undefined}
          summary={STRIPE}
          reloading={false}
          onReload={onReload}
        />
      </TooltipProvider>,
    )
    expect(screen.getByTestId('vendor-command')).toHaveTextContent(
      'firenook ext:vendor --instance stripe',
    )
    expect(screen.getByTestId('vendor-dialog')).toHaveTextContent('acme/greeter@1.2.3')
    fireEvent.click(screen.getByTestId('vendor-reload'))
    expect(onReload).toHaveBeenCalledOnce()
  })
})
