// One running section on the Overview: its name (into the section), whether
// it is healthy, the address an app connects to, the figures its stream
// counts (`SectionStatus.summary`), its current problems (the section's
// gauge badges, each linking to the page that carries it) and where to go
// from here. A section whose stream counts nothing yet shows its address,
// its state and a line of what it holds, never a made-up zero.

import { Tooltip, cn } from '@cloudflare/kumo'
import { WarningIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { SummaryFigure } from '@/api/generated/SummaryFigure'
import { CopyField } from '@/components/console/copy-button'
import { StatusDot } from '@/components/kit'
import { useFlash } from '../flash'
import { type SectionCard as Card, addressOf, cardConnect, cardHolds, figureText } from '../model'
import { LINK_CLASS, TextLink } from './text-link'

export function SectionCard({
  card,
  tick,
  onConnect,
}: {
  card: Card
  /** The status the card was drawn from, so a figure's flash counts every status. */
  tick: unknown
  /** "Connect": open this snippet in "Connect your app". */
  onConnect: (param: NonNullable<ReturnType<typeof cardConnect>>) => void
}) {
  const { section, status, address, sharedWith, problems, health } = card
  const Icon = section.icon
  const figures = status.summary?.figures.slice(0, 3) ?? []
  const connect = cardConnect(section.id)
  const links = [
    { key: 'open', node: <TextLink link={{ to: section.to }}>Open {section.label}</TextLink> },
    ...card.pages.map((page) => ({
      key: page.to,
      node: <TextLink link={{ to: page.to }}>{page.label}</TextLink>,
    })),
    ...(card.logs
      ? [
          {
            key: 'logs',
            node: (
              <TextLink link={card.logs} testId={`overview-card-${section.id}-logs`}>
                Logs
              </TextLink>
            ),
          },
        ]
      : []),
    ...(connect
      ? [
          {
            key: 'connect',
            node: (
              <button
                type="button"
                className={LINK_CLASS}
                onClick={() => onConnect(connect)}
                data-testid={`overview-card-${section.id}-connect`}
              >
                Connect
              </button>
            ),
          },
        ]
      : []),
  ]
  return (
    <article
      className="flex min-w-0 flex-col gap-3 overflow-hidden rounded-lg bg-kumo-base px-5 py-4 shadow-xs ring ring-kumo-line"
      data-testid={`overview-card-${section.id}`}
      data-state={status.state}
      aria-labelledby={`overview-card-${section.id}-title`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={16} className="shrink-0 text-kumo-subtle" aria-hidden />
        <h3 className="min-w-0 truncate text-[14px] leading-5 font-medium">
          <Link
            to={section.to as never}
            className="text-kumo-default underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            id={`overview-card-${section.id}-title`}
          >
            {section.label}
          </Link>
        </h3>
        <StatusDot
          tone={health.tone}
          label={health.label}
          pulse={health.pulse}
          className="ml-auto"
          testId={`overview-card-${section.id}-health`}
        />
      </div>

      {address ? (
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <CopyField
            value={addressOf(address)}
            className="text-kumo-default"
            testId={`overview-card-${section.id}-address`}
          />
          {sharedWith && <span className="shrink-0 text-kumo-subtle">with {sharedWith.label}</span>}
        </div>
      ) : null}

      {status.state === 'starting' && status.detail ? (
        <p
          className="text-[12px] text-kumo-subtle"
          data-testid={`overview-card-${section.id}-detail`}
        >
          {status.detail}
        </p>
      ) : null}

      {figures.length === 0 && status.state === 'ready' && (
        <p
          className="line-clamp-2 text-[12px] leading-4 text-kumo-subtle"
          data-testid={`overview-card-${section.id}-holds`}
        >
          {cardHolds(section.id)}
        </p>
      )}

      {figures.length > 0 && (
        <dl
          className="flex min-w-0 flex-wrap gap-x-7 gap-y-2"
          data-testid={`overview-card-${section.id}-figures`}
        >
          {figures.map((figure) => (
            <Figure key={figure.label} figure={figure} tick={tick} section={section.id} />
          ))}
        </dl>
      )}

      {problems.length > 0 && (
        <ul className="grid gap-1" data-testid={`overview-card-${section.id}-problems`}>
          {problems.map((problem) => (
            <li
              key={problem.id}
              className="flex min-w-0 items-center gap-1.5 text-[12px] text-kumo-warning"
              data-badge={problem.id}
            >
              <WarningIcon size={12} weight="bold" className="shrink-0" aria-hidden />
              {problem.link ? (
                <TextLink link={problem.link} className="min-w-0 truncate text-kumo-warning">
                  {problem.text}
                </TextLink>
              ) : (
                <span className="min-w-0 truncate">{problem.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Each link carries the dot before it in a 16 px slot, and the row
          starts 16 px left of the card’s clip: the first link of every line
          has its dot cut off, so a wrapped row neither ends nor starts on a
          dangling separator. */}
      <div className="mt-auto overflow-hidden pt-1 pb-0.5">
        <div className="-ml-4 flex min-w-0 flex-wrap items-center gap-y-1 text-[12px]">
          {links.map((item) => (
            <span
              key={item.key}
              className="inline-flex min-w-0 items-center whitespace-nowrap before:w-4 before:shrink-0 before:text-center before:text-kumo-subtle before:content-['·']"
              data-testid="card-link"
            >
              {item.node}
            </span>
          ))}
        </div>
      </div>
    </article>
  )
}

/** One headline figure: the card's subject, so the one figure in the console above 14 px. */
function Figure({
  figure,
  tick,
  section,
}: {
  figure: SummaryFigure
  tick: unknown
  section: string
}) {
  const flashes = useFlash(figure.value, tick)
  const text = figureText(figure)
  const value = (
    <dd
      // A new key restarts the flash.
      key={flashes}
      className={cn(
        '-mx-1 w-fit rounded px-1 font-mono text-[16px] leading-6 font-medium text-kumo-default tabular-nums',
        flashes > 0 &&
          'bg-[linear-gradient(var(--row-flash),var(--row-flash))] [animation:row-flash_1.6s_ease-out] motion-reduce:[animation:none]',
      )}
      data-flashes={flashes}
      data-testid={`overview-figure-${section}-${figure.label.toLowerCase().replaceAll(' ', '-')}`}
    >
      {text}
    </dd>
  )
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      {/* The label reads under the figure, and comes first for a screen reader. */}
      <dt className="order-last truncate text-[12px] text-kumo-subtle">{figure.label}</dt>
      {figure.value === null ? <Tooltip content="Still counting" render={value} /> : value}
    </div>
  )
}
