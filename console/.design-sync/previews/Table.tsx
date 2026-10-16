import { Badge, InlineCopyText, LayerCard, Link, Table, Text } from '@firenook/kit'

const ORDERS = [
  {
    id: 'o_20251',
    status: 'paid',
    total: '42.00',
    created: '2 min ago',
    customer: 'users/u_9f3k2',
  },
  { id: 'o_20250', status: 'paid', total: '18.50', created: '1 h ago', customer: 'users/u_9f3k2' },
  {
    id: 'o_20249',
    status: 'refunded',
    total: '99.00',
    created: 'yesterday',
    customer: 'users/u_1x8pq',
  },
  {
    id: 'o_20248',
    status: 'pending',
    total: '7.25',
    created: '3 days ago',
    customer: 'users/u_7c0aa',
  },
]

const statusVariant = (status: string) =>
  status === 'paid' ? 'success' : status === 'refunded' ? 'neutral' : 'warning'

/** Rows alternate on the elevated surface; ids copy on hover; references are links. */
export function Basic() {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>id</Table.Head>
            <Table.Head>status</Table.Head>
            <Table.Head>total</Table.Head>
            <Table.Head>createdAt</Table.Head>
            <Table.Head>customer</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {ORDERS.map((row) => (
            <Table.Row key={row.id} className="group">
              <Table.Cell>
                <InlineCopyText value={row.id} className="font-mono text-[0.9em]">
                  {row.id}
                </InlineCopyText>
              </Table.Cell>
              <Table.Cell>
                <Badge variant={statusVariant(row.status)} appearance="dot">
                  {row.status}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <span className="font-mono text-[0.9em] tabular-nums">{row.total}</span>
              </Table.Cell>
              <Table.Cell>
                <Text variant="secondary" size="sm">
                  {row.created}
                </Text>
              </Table.Cell>
              <Table.Cell>
                <Link href="#" className="font-mono text-[0.9em]">
                  {row.customer}
                </Link>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}

/** Checkbox selection: the header checkbox is indeterminate while some rows are selected; a selected row uses the tint. */
export function WithSelection() {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.CheckHead
              checked={false}
              indeterminate
              onCheckedChange={() => {}}
              aria-label="Select all"
            />
            <Table.Head>id</Table.Head>
            <Table.Head>status</Table.Head>
            <Table.Head>total</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {ORDERS.slice(0, 3).map((row, index) => (
            <Table.Row key={row.id} variant={index === 1 ? 'selected' : 'default'}>
              <Table.CheckCell
                checked={index === 1}
                onCheckedChange={() => {}}
                aria-label={`Select ${row.id}`}
              />
              <Table.Cell>
                <span className="font-mono text-[0.9em]">{row.id}</span>
              </Table.Cell>
              <Table.Cell>
                <Badge variant={statusVariant(row.status)} appearance="dot">
                  {row.status}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <span className="font-mono text-[0.9em] tabular-nums">{row.total}</span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}

/** The compact header for dense grids: 12 px on the elevated surface. */
export function CompactHeader() {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header variant="compact">
          <Table.Row>
            <Table.Head>identifier</Table.Head>
            <Table.Head>provider</Table.Head>
            <Table.Head>created</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          <Table.Row>
            <Table.Cell>ada@example.test</Table.Cell>
            <Table.Cell>password</Table.Cell>
            <Table.Cell>2026-09-18</Table.Cell>
          </Table.Row>
          <Table.Row>
            <Table.Cell>+1 555 0100</Table.Cell>
            <Table.Cell>phone</Table.Cell>
            <Table.Cell>2026-09-19</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table>
    </LayerCard>
  )
}
