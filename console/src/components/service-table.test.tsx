import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ServiceTable } from './service-table'

describe('the service table', () => {
  it('labels every service and tells listeners from dependencies', () => {
    render(
      <ServiceTable
        services={[
          { name: 'auth', host: '127.0.0.1', port: 39099, listening: true, pid: null },
          { name: 'tasks', host: '127.0.0.1', port: 39499, listening: false, pid: null },
        ]}
      />,
    )
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Authentication')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('listening')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Cloud Tasks')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('dependency')).toBeInTheDocument()
    expect(screen.getByText('127.0.0.1:39499')).toBeInTheDocument()
  })
})
