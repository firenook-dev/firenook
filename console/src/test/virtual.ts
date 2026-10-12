// Sizes for a virtualized list under happy-dom, which lays nothing out: the
// TanStack virtualizer reads `offsetHeight` from its scroller and each row,
// and with every size 0 it would draw two rows. Call once in a test file:
// the scroller (an element with one of `scrollerRoles`) is `viewport` tall,
// every other element `row` tall.

import { afterAll, beforeAll } from 'vitest'

export function giveListsALayout({
  viewport = 600,
  row = 20,
  width = 800,
  scrollerRoles = ['tree', 'grid', 'log', 'listbox'],
}: { viewport?: number; row?: number; width?: number; scrollerRoles?: readonly string[] } = {}) {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return scrollerRoles.includes(this.getAttribute('role') ?? '') ? viewport : row
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => width,
    })
  })
  afterAll(() => {
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    if (wide) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', wide)
  })
}
