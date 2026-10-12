// happy-dom lays nothing out, so every box is 0 × 0 and a virtualized list
// draws no rows. These give elements the size a virtualizer reads (offset
// and client sizes) and a scroll height from what the list asks its inner
// box to be, so the components under test virtualize as they do in a
// browser.

const STUBBED = [
  'offsetHeight',
  'offsetWidth',
  'clientHeight',
  'clientWidth',
  'scrollHeight',
] as const

/** Every element `height` × `width`; a scroller's scroll height follows its first child's set height. */
export function stubLayout(size: { height: number; width?: number }): () => void {
  const proto = HTMLElement.prototype
  const saved = STUBBED.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const)
  const width = size.width ?? 1200
  const define = (name: (typeof STUBBED)[number], get: (this: HTMLElement) => number) =>
    Object.defineProperty(proto, name, { configurable: true, get })
  // A table's header and rows are their own height, as the console sets them.
  define('offsetHeight', function offsetHeight(this: HTMLElement) {
    if (this.tagName === 'THEAD') return 33
    if (this.tagName === 'TR') return 32
    return size.height
  })
  define('clientHeight', () => size.height)
  define('offsetWidth', () => width)
  define('clientWidth', () => width)
  define('scrollHeight', function scrollHeight(this: HTMLElement) {
    const inner = this.firstElementChild as HTMLElement | null
    const set = Number.parseFloat(inner?.style.height ?? '')
    return Math.max(size.height, Number.isFinite(set) ? set : 0)
  })
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor)
      else delete (proto as unknown as Record<string, unknown>)[name]
    }
  }
}

/** Scrolls an element as a person would: the position, then the event the virtualizer listens for. */
export function scrollTo(element: Element, top: number): void {
  element.scrollTop = top
  element.dispatchEvent(new Event('scroll'))
}

/** A key press as the shell's one listener receives it. */
export function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}
