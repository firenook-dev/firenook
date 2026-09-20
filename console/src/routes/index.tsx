import { Badge, LayerCard, Link, Text } from '@cloudflare/kumo'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { statusQuery } from '@/api/queries'
import { ServiceTable } from '@/components/service-table'
import { SECTIONS } from '@/lib/services'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusQuery),
  component: Overview,
})

function Overview() {
  const { data } = useSuspenseQuery(statusQuery)
  const running = new Set(data.services.map((service) => service.name))
  return (
    <div className="grid gap-8">
      <div className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Overview
        </Text>
        <Text variant="secondary">
          {data.services.length} services running for project{' '}
          <span className="font-mono text-[0.9em]">{data.projectId}</span> on {data.engine.name}{' '}
          {data.engine.crateVersion}.
        </Text>
      </div>

      <section className="grid gap-3">
        <Text variant="heading" as="h2">
          Services
        </Text>
        <ServiceTable services={data.services} />
      </section>

      <section className="grid gap-3">
        <div className="grid gap-1.5">
          <Text variant="heading" as="h2">
            Sections
          </Text>
          <Text variant="secondary">
            Each section is a screen the console will own. The Google Emulator UI keeps answering on
            this port at <Link href="/">/</Link> until every section has landed.
          </Text>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {SECTIONS.map((section) => {
            const active = section.services.some((name) => running.has(name))
            return (
              <LayerCard key={section.to} className="px-5 py-4">
                <div className="grid gap-3">
                  <div className="flex items-start gap-2">
                    <span className="h-lh flex items-center text-kumo-subtle">
                      <section.icon size={16} />
                    </span>
                    <Link href={`/console${section.to}`} variant="inline">
                      {section.label}
                    </Link>
                    <span className="ml-auto">
                      {active ? (
                        <Badge variant="success" appearance="dot">
                          running
                        </Badge>
                      ) : (
                        <Badge variant="neutral" appearance="dot">
                          not running
                        </Badge>
                      )}
                    </span>
                  </div>
                  <Text variant="secondary" size="sm">
                    {section.summary}
                  </Text>
                </div>
              </LayerCard>
            )
          })}
        </div>
      </section>
    </div>
  )
}
