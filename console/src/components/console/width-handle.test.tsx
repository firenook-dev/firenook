import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectorWidth, resetInspectorWidths } from './inspector-width'
import { WidthHandle } from './width-handle'

beforeEach(() => {
  localStorage.clear()
  resetInspectorWidths()
  vi.stubGlobal('innerWidth', 1440)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A panel on a page 1,600 px wide, its right edge at the page's. */
function mount() {
  render(
    <div data-testid="page">
      <aside data-testid="panel">
        <WidthHandle widthKey="auth.user" testId="grip" />
      </aside>
    </div>,
  )
  const page = screen.getByTestId('page')
  const panel = screen.getByTestId('panel')
  page.getBoundingClientRect = () => ({ width: 1600, right: 1600 }) as DOMRect
  panel.getBoundingClientRect = () => ({ width: 420, right: 1600 }) as DOMRect
  return screen.getByTestId('grip')
}

describe('the width handle', () => {
  it('steps with the arrows, four times as far with Shift, and remembers', () => {
    const grip = mount()
    fireEvent.keyDown(grip, { key: 'ArrowLeft' })
    expect(inspectorWidth('auth.user')).toBe(436)
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true })
    expect(inspectorWidth('auth.user')).toBe(372)
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBe('372')
    expect(grip).toHaveAttribute('aria-valuenow', '372')
  })

  it('follows the pointer by the distance dragged, and writes once at the end', () => {
    const grip = mount()
    grip.setPointerCapture = () => undefined
    grip.releasePointerCapture = () => undefined
    grip.hasPointerCapture = () => true
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 1180 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 1000 })
    expect(inspectorWidth('auth.user')).toBe(600)
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBeNull()
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 1000 })
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBe('600')
  })

  it('goes home on a double-click', () => {
    localStorage.setItem('firenook.console.inspector-width.auth.user', '700')
    resetInspectorWidths()
    const grip = mount()
    fireEvent.doubleClick(grip)
    expect(inspectorWidth('auth.user')).toBe(420)
  })
})
