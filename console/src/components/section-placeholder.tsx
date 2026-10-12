// Every section keeps this honest shape until its real screen lands
// (`built: false` in its registry file): the engine runs the service — the
// gate in front of it has already said so — and the finished section's
// summary says what is coming. Nothing here is presented as working.

import { Badge, Empty, Text } from '@cloudflare/kumo'
import { SectionFrame } from '@/components/console/section-gate'
import { Page } from '@/components/shell/page'
import type { ConsoleSection } from '@/lib/services'

export function SectionPlaceholder({ section }: { section: ConsoleSection }) {
  return (
    <Page className="grid gap-6">
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Text variant="heading" size="lg" as="h1">
            {section.label}
          </Text>
          <Badge variant="success" appearance="dot">
            running
          </Badge>
        </div>
        <Text variant="secondary">{section.summary}</Text>
      </div>
      <Empty
        icon={<section.icon size={48} className="text-kumo-inactive" />}
        title="This section is not built yet"
        description="The engine serves this service today; its console screen is on the way. Until then, the Google Emulator UI on this port covers it."
      />
    </Page>
  )
}

/** A section route before its screen lands: the shell banners, the gate, then the placeholder. */
export function UnbuiltSection({ section }: { section: ConsoleSection }) {
  return (
    <SectionFrame section={section.id}>
      <SectionPlaceholder section={section} />
    </SectionFrame>
  )
}
