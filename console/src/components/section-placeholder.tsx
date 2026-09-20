import { Badge, Empty, Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import type { ConsoleSection } from '@/lib/services'

// Every section keeps this honest shape until its real screen lands: what the
// engine already runs, and what the finished section will do.
export function SectionPlaceholder({ section }: { section: ConsoleSection }) {
  const status = useQuery(statusQuery)
  const running = status.data?.services.some((service) => section.services.includes(service.name))
  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Text variant="heading" size="lg" as="h1">
            {section.label}
          </Text>
          {status.data &&
            (running ? (
              <Badge variant="success" appearance="dot">
                running
              </Badge>
            ) : (
              <Badge variant="neutral" appearance="dot">
                not running
              </Badge>
            ))}
        </div>
        <Text variant="secondary">{section.summary}</Text>
      </div>
      <Empty
        icon={<section.icon size={48} className="text-kumo-inactive" />}
        title="This section is not built yet"
        description="The engine serves this service today; its console screen is on the way. Until then, the Google Emulator UI on this port covers it."
      />
    </div>
  )
}
