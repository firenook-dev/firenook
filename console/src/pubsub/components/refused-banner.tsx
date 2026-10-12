// What the app did that the emulator turned down (PS-02a): a publish to a
// topic that does not exist, a message the topic's schema refused, a pull
// from a subscription nobody created. The emulator answers the app and
// keeps nothing else, so this is the only place it is said — one strip per
// resource, coalesced with a count, and the nearest id that does exist,
// which is usually the typo. At most three strips, then a list.

import { Button, Popover } from '@cloudflare/kumo'
import type { PubsubRejected } from '@/api/generated/messaging/PubsubRejected'
import { SectionBanner } from '@/components/console/section-banner'
import { PanelTitle } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { shortName } from '../names'

/** Strips shown before the rest go into "and N more". */
export const REFUSED_SHOWN = 3

function times(count: number): string {
  return count === 1 ? 'once' : `${formatNumber(count)} times`
}

/** The sentence for one refusal, in the developer's terms: what the app did, what happened. */
export function refusedSentence(refused: PubsubRejected): string {
  const missing = refused.code === 'NOT_FOUND'
  const hint = [
    refused.suggestion ? ` Did you mean ${refused.suggestion}?` : '',
    refused.elsewhere !== null ? ` It exists in project ${refused.elsewhere || '(empty)'}.` : '',
  ].join('')
  switch (refused.operation) {
    case 'publish':
      return missing
        ? `Your app tried to publish to ${refused.resource} ${times(refused.count)}; it does not exist.${hint}`
        : `Your app's publish to ${refused.resource} was refused ${times(refused.count)}: ${refused.error}.`
    case 'pull':
    case 'streaming-pull':
      return missing
        ? `Your app tried to pull from ${refused.resource} ${times(refused.count)}; it does not exist.${hint}`
        : `Your app's pull from ${refused.resource} was refused ${times(refused.count)}: ${refused.error}.`
    case 'create-subscription':
      return missing
        ? `Your app tried to create a subscription on ${refused.resource} ${times(refused.count)}; the topic does not exist.${hint}`
        : `Your app's subscription on ${refused.resource} was refused ${times(refused.count)}: ${refused.error}.`
    default:
      return `A ${refused.operation} naming ${refused.resource} was refused ${times(refused.count)}: ${refused.error}.`
  }
}

export function RefusedBanners({
  items,
  onCreateTopic,
  onOpenTopic,
  onProject,
}: {
  items: readonly PubsubRejected[]
  /** Opens the create dialog with the refused id filled in. */
  onCreateTopic: (id: string) => void
  /** Opens a topic of the page's project by id. */
  onOpenTopic: (id: string) => void
  /** Shows another project's topics (`?project=`). */
  onProject: (project: string) => void
}) {
  if (items.length === 0) return null
  // The engine keeps them oldest first; the latest is the one being debugged.
  const latest = items.toSorted((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
  const shown = latest.slice(0, REFUSED_SHOWN)
  const rest = latest.slice(REFUSED_SHOWN)
  return (
    <div className="grid shrink-0" data-testid="pubsub-refused">
      {shown.map((refused) => (
        <SectionBanner
          key={`${refused.operation}|${refused.resource}|${refused.code}`}
          tone="warning"
          testId="pubsub-refused-banner"
          action={
            <RefusedActions
              refused={refused}
              onCreateTopic={onCreateTopic}
              onOpenTopic={onOpenTopic}
              onProject={onProject}
            />
          }
        >
          <span className="[overflow-wrap:anywhere]">{refusedSentence(refused)}</span>
        </SectionBanner>
      ))}
      {rest.length > 0 && (
        <SectionBanner
          tone="warning"
          testId="pubsub-refused-more"
          action={
            <Popover>
              <Popover.Trigger
                render={
                  <Button variant="secondary" size="xs" data-testid="pubsub-refused-more-open">
                    Show them
                  </Button>
                }
              />
              <Popover.Content className="grid max-h-96 w-[560px] max-w-[calc(100vw-2rem)] gap-3 overflow-auto">
                <PanelTitle>Refused requests</PanelTitle>
                <ul className="grid gap-2 text-[13px] text-kumo-default">
                  {rest.map((refused) => (
                    <li
                      key={`${refused.operation}|${refused.resource}|${refused.code}`}
                      className="[overflow-wrap:anywhere]"
                    >
                      {refusedSentence(refused)}
                    </li>
                  ))}
                </ul>
              </Popover.Content>
            </Popover>
          }
        >
          and {formatNumber(rest.length)} more refused {rest.length === 1 ? 'request' : 'requests'}
        </SectionBanner>
      )}
    </div>
  )
}

function RefusedActions({
  refused,
  onCreateTopic,
  onOpenTopic,
  onProject,
}: {
  refused: PubsubRejected
  onCreateTopic: (id: string) => void
  onOpenTopic: (id: string) => void
  onProject: (project: string) => void
}) {
  const missingTopic =
    refused.code === 'NOT_FOUND' &&
    (refused.operation === 'publish' || refused.operation === 'create-subscription') &&
    refused.resource.includes('/topics/')
  const id = shortName(refused.resource)
  return (
    <>
      {missingTopic && (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onCreateTopic(id)}
          data-testid="pubsub-refused-create"
        >
          Create <span className="font-mono text-[0.9em]">{id}</span>
        </Button>
      )}
      {refused.suggestion && refused.resource.includes('/topics/') && (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onOpenTopic(refused.suggestion ?? '')}
          data-testid="pubsub-refused-open"
        >
          Open <span className="font-mono text-[0.9em]">{refused.suggestion}</span>
        </Button>
      )}
      {refused.elsewhere !== null && (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onProject(refused.elsewhere ?? '')}
          data-testid="pubsub-refused-project"
        >
          Show <span className="font-mono text-[0.9em]">{refused.elsewhere || '(empty)'}</span>
        </Button>
      )}
    </>
  )
}
