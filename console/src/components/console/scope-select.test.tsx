import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScopeSelect } from './scope-select'

afterEach(cleanup)

async function choose(element: HTMLElement) {
  const option = element.closest<HTMLElement>('[role="option"]') ?? element
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseDown(option, { button: 0 })
    fireEvent.pointerUp(option, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseUp(option, { button: 0 })
    fireEvent.click(option)
  })
}

async function open() {
  const trigger = screen.getByRole('combobox')
  await act(async () => {
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseDown(trigger, { button: 0 })
    fireEvent.click(trigger)
  })
}

describe('ScopeSelect', () => {
  it('names the scope inside the box and lists notes and details in the menu only', async () => {
    render(
      <ScopeSelect
        label="Tenant"
        value="acme"
        items={[
          { value: '', label: 'No tenant' },
          { value: 'acme', note: 'Acme Corp', detail: '5 users' },
        ]}
        onChange={() => {}}
      />,
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toBe('Tenantacme')
    await open()
    expect(screen.getByText('Acme Corp')).toBeTruthy()
    expect(screen.getByText('5 users')).toBeTruthy()
  })

  it('runs an action without changing the value', async () => {
    const onChange = vi.fn()
    const run = vi.fn()
    render(
      <ScopeSelect
        label="Tenant"
        value=""
        items={[
          { value: '', label: 'No tenant' },
          { value: 'acme', label: 'acme' },
        ]}
        onChange={onChange}
        actions={[{ id: 'new', label: 'New tenant…', run }]}
      />,
    )
    await open()
    await choose(screen.getByTestId('scope-action-new'))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    await open()
    await choose(screen.getByText('acme', { selector: 'span' }))
    expect(onChange).toHaveBeenCalledWith('acme')
  })
})
