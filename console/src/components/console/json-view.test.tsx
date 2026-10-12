import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { giveListsALayout } from '@/test/virtual'
import { JsonView } from './json-view'

giveListsALayout()
afterEach(cleanup)

const VALUE = { name: 'ada', team: { name: 'analytics', lead: 'ada' }, n: 3 }

describe('the JSON view', () => {
  it('searches the tree, says which match of how many, and steps through them', async () => {
    const user = userEvent.setup()
    render(<JsonView value={VALUE} testId="view" />)
    await user.type(screen.getByTestId('view-search'), 'ada')
    expect(screen.getByTestId('view-hits')).toHaveTextContent('1 of 2')
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('view-hits')).toHaveTextContent('2 of 2')
    await user.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByTestId('view-hits')).toHaveTextContent('1 of 2')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('view-hits')).toHaveTextContent('2 of 2')
    await user.clear(screen.getByTestId('view-search'))
    await user.type(screen.getByTestId('view-search'), 'nobody')
    expect(screen.getByTestId('view-hits')).toHaveTextContent('No match')
  })

  it('copies the text exactly as it came', async () => {
    const user = userEvent.setup()
    const text = '{"name":"ada",  "n": 3.0}'
    render(<JsonView value={{ name: 'ada', n: 3 }} text={text} testId="view" />)
    await user.click(screen.getByTestId('view-copy'))
    expect(await navigator.clipboard.readText()).toBe(text)
  })

  it('copies a value that came without text laid out, from the tree', async () => {
    const user = userEvent.setup()
    render(<JsonView value={{ name: 'ada', n: 3 }} testId="view" />)
    expect(screen.getByTestId('view-search')).toBeInTheDocument()
    await user.click(screen.getByTestId('view-copy'))
    expect(await navigator.clipboard.readText()).toBe('{\n  "name": "ada",\n  "n": 3\n}')
  })

  it('shows the raw text on its tab', async () => {
    const user = userEvent.setup()
    render(<JsonView value={{ a: 1 }} testId="view" />)
    await user.click(screen.getByRole('tab', { name: 'Raw' }))
    expect(screen.queryByTestId('view-search')).not.toBeInTheDocument()
    expect(await screen.findByText(/"a": 1/)).toBeInTheDocument()
  })

  it('leaves the raw tab out when the page shows the text elsewhere, and sizes to the value', () => {
    render(<JsonView value={{ a: 1 }} raw={false} height="content" testId="view" />)
    expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument()
    expect(screen.getByTestId('view')).not.toHaveClass('min-h-[240px]')
    expect(screen.getByTestId('view-tree')).toHaveStyle({ height: '20px' })
  })

  it('offers no raw text when the tree masks values, since it would show them', () => {
    render(<JsonView value={{ hash: 'x' }} mask={() => true} defaultTab="raw" testId="view" />)
    expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument()
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })
})
