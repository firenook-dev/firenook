import { Badge, InlineCopyText, LayerCard, Table } from '@cloudflare/kumo'
import type { ServiceStatus } from '@/api/generated/ServiceStatus'
import { serviceLabel } from '@/lib/services'

export function ServiceTable({ services }: { services: readonly ServiceStatus[] }) {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Service</Table.Head>
            <Table.Head>Address</Table.Head>
            <Table.Head>Kind</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {services.map((service) => (
            <Table.Row key={service.name} className="group">
              <Table.Cell>{serviceLabel(service.name)}</Table.Cell>
              <Table.Cell>
                <InlineCopyText
                  value={`${service.host}:${service.port}`}
                  className="font-mono text-[0.9em]"
                >
                  {service.host}:{service.port}
                </InlineCopyText>
              </Table.Cell>
              <Table.Cell>
                {service.listening ? (
                  <Badge variant="success" appearance="dot">
                    listening
                  </Badge>
                ) : (
                  <Badge variant="neutral" appearance="dot">
                    dependency
                  </Badge>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}
