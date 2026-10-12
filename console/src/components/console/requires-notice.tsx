// "This needs another section", said one way everywhere: running a schedule
// now needs Pub/Sub, a storage trigger needs Functions. One line naming
// what needs what, and that section's own fix from the engine's status, so
// no page writes its own "Functions is not running…" sentence. The section
// it names is a link to that section's page: while it starts, the page that
// fills in by itself; while it is absent, its gate with the whole fix.

import { Button, Popover } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { statusQuery } from '@/api/queries'
import { PanelTitle } from '@/components/kit'
import { type SectionId, sectionById } from '@/lib/services'
import { CodeBlock } from './code-block'
import { sectionStatus } from './section-gate'
import { SectionBanner } from './section-banner'

/**
 * "Running a schedule now needs Pub/Sub, which this engine does not run."
 * with that section's fixes, or "…needs Pub/Sub, which is starting." while
 * it starts. Renders nothing while `section` is ready (or before the
 * engine's status has arrived).
 */
export function RequiresNotice({
  section: id,
  for: feature,
  testId = `requires-${id}`,
}: {
  section: SectionId
  /** What needs it, as the start of a sentence: "Running a schedule now". */
  for: string
  testId?: string
}) {
  const status = useQuery(statusQuery)
  const section = sectionById(id)
  if (!section || !status.data) return null
  const entry = sectionStatus(status.data.sections, id)
  if (entry.state === 'ready') return null
  const name = (
    <Link
      to={section.to as never}
      className="font-medium text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      data-testid={`${testId}-section`}
    >
      {section.label}
    </Link>
  )
  if (entry.state === 'starting') {
    return (
      <SectionBanner tone="info" testId={testId}>
        {feature} needs {name}, which is starting; it works as soon as it is up.
      </SectionBanner>
    )
  }
  return (
    <SectionBanner
      tone="warning"
      testId={testId}
      action={
        entry.fixes.length > 0 ? (
          <Popover>
            <Popover.Trigger
              render={
                <Button variant="secondary" size="xs" data-testid={`${testId}-how`}>
                  How to start it
                </Button>
              }
            />
            <Popover.Content className="grid w-[560px] max-w-[calc(100vw-2rem)] gap-4">
              <div className="grid gap-1">
                <PanelTitle>Start {section.label}</PanelTitle>
                {entry.detail && <p className="text-[13px] text-kumo-subtle">{entry.detail}</p>}
              </div>
              {entry.fixes.map((fix) => (
                <CodeBlock
                  key={`${fix.kind}:${fix.label}`}
                  label={fix.label}
                  code={fix.text}
                  language={fix.kind === 'firebase-json' ? 'json' : 'shell'}
                  testId={`${testId}-fix-${fix.kind}`}
                />
              ))}
            </Popover.Content>
          </Popover>
        ) : undefined
      }
    >
      {feature} needs {name}, which this engine does not run.
    </SectionBanner>
  )
}
