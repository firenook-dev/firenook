// One section on the Overview, as a tile that opens it: its name and state,
// the port an app connects to, its headline figure with up to two more
// beside it, and what is wrong with it now (the section's gauge badges,
// each leading to the page that carries it). A running section's state is
// its green dot alone; only the states worth reading — starting, a problem,
// not running — say a word. A section the engine does not run keeps its
// place in the grid as an outline with the engine's reason, and opens its
// gate, which says how to turn it on.

import { Tooltip, cn } from '@cloudflare/kumo'
import { ArrowRightIcon, WarningIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { SummaryFigure } from '@/api/generated/SummaryFigure'
import { CopyField } from '@/components/console/copy-button'
import { StatusDot } from '@/components/kit'
import { useFlash } from '../flash'
import { type SectionCard as Card, addressOf, cardHolds, figureText, tileAddress } from '../model'
import { TextLink } from './text-link'

export function ServiceTile({
  card,
  host,
  tick,
}: {
  card: Card
  /** The host every tile shares, written once above the grid; a tile on it shows its port alone. */
  host: string | undefined
  /** The status the tile was drawn from, so a figure's flash counts every status. */
  tick: unknown
}) {
  const { section, status, address, sharedWith, problems, health } = card
  const Icon = section.icon
  const absent = status.state === 'absent'
  const [primary, ...others] = status.summary?.figures ?? []
  const secondary = others.slice(0, 2)
  const id = `overview-card-${section.id}`
  return (
    <article
      className={cn(
        'relative flex min-h-[8.5rem] min-w-0 flex-col gap-5 rounded-lg px-4 pt-3.5 pb-4',
        absent
          ? 'border border-dashed border-kumo-line'
          : 'bg-kumo-base shadow-xs ring ring-kumo-line hover:ink',
      )}
      data-testid={id}
      data-state={status.state}
      aria-labelledby={`${id}-title`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            absent ? 'text-kumo-inactive ring ring-kumo-line' : 'bg-kumo-tint text-kumo-default',
          )}
          aria-hidden
        >
          <Icon size={15} />
        </span>
        <h3 className="min-w-0 truncate text-[14px] leading-5 font-medium">
          {/* The whole tile is the link: its box is stretched over the
              tile, and the port's copy sits above it. */}
          <Link
            to={section.to as never}
            id={`${id}-title`}
            className={cn(
              'outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-kumo-focus',
              absent ? 'text-kumo-subtle' : 'text-kumo-default',
            )}
          >
            {section.label}
          </Link>
        </h3>
        <StatusDot
          tone={health.tone}
          label={health.label}
          pulse={health.pulse}
          hideLabel={health.tone === 'success'}
          className="shrink-0"
          testId={`${id}-health`}
        />
        {address && (
          <Tooltip
            content={
              sharedWith
                ? `${addressOf(address)}, shared with ${sharedWith.label}`
                : addressOf(address)
            }
            render={
              <span className="relative z-10 ml-auto flex min-w-0">
                {/* The copy glyph shows on the port's left, so the port ends
                    where the figures under it end: after it, its hidden
                    glyph held the port 18 px short of that edge. */}
                <CopyField
                  value={addressOf(address)}
                  className="flex-row-reverse text-kumo-subtle"
                  testId={`${id}-address`}
                >
                  {tileAddress(address, host)}
                </CopyField>
              </span>
            }
          />
        )}
      </div>

      <div className="mt-auto grid min-w-0 gap-3">
        {absent ? (
          <div className="grid gap-1">
            <p
              className="line-clamp-2 text-[13px] leading-5 text-kumo-subtle"
              data-testid={`${id}-detail`}
            >
              {status.detail ?? `This engine does not run ${section.label}.`}
            </p>
            {/* The tile opens the section's gate, which has the fix to copy. */}
            <span className="flex items-center gap-1 text-[12px] text-kumo-link" aria-hidden>
              How to turn it on
              <ArrowRightIcon size={11} />
            </span>
          </div>
        ) : status.state === 'starting' ? (
          <p
            className="line-clamp-2 text-[13px] leading-5 text-kumo-subtle"
            data-testid={`${id}-detail`}
          >
            {status.detail ?? 'Starting…'}
          </p>
        ) : primary ? (
          // One grid for every figure, its rows aligned on their baselines:
          // a second figure reads on the line of the headline's number, the
          // last on the line of its name. Two stacks side by side, each
          // aligned to its own bottom, put neither on a line of the other.
          <dl
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5"
            data-testid={`${id}-figures`}
          >
            <Headline figure={primary} tick={tick} section={section.id} />
            {secondary.map((figure, index) => (
              <Secondary
                key={figure.label}
                figure={figure}
                tick={tick}
                section={section.id}
                line={index === secondary.length - 1 ? 'name' : 'number'}
              />
            ))}
          </dl>
        ) : (
          <p
            className="line-clamp-2 text-[13px] leading-5 text-kumo-subtle"
            data-testid={`${id}-holds`}
          >
            {cardHolds(section.id)}
          </p>
        )}

        {problems.length > 0 && (
          <ul
            className="relative z-10 grid gap-1 border-t border-kumo-hairline pt-2.5"
            data-testid={`${id}-problems`}
          >
            {problems.map((problem) => (
              <li
                key={problem.id}
                className="flex min-w-0 items-center gap-1.5 text-[12px] text-kumo-warning"
                data-badge={problem.id}
              >
                <WarningIcon size={12} weight="bold" className="shrink-0" aria-hidden />
                <TextLink link={problem.link} className="min-w-0 truncate text-kumo-warning">
                  {problem.text}
                </TextLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

/** The tile's subject: its first figure, large, with its name under it. */
function Headline({
  figure,
  tick,
  section,
}: {
  figure: SummaryFigure
  tick: unknown
  section: string
}) {
  const flashes = useFlash(figure.value, tick)
  const value = (
    <dd
      // A new key restarts the flash.
      key={flashes}
      className={cn(
        'col-start-1 row-start-1 -mx-1 w-fit rounded px-1 text-[22px] leading-7 font-semibold tracking-tight text-kumo-default tabular-nums',
        flashes > 0 && FLASH,
      )}
      data-flashes={flashes}
      data-testid={figureTestId(section, figure)}
    >
      {figureText(figure)}
    </dd>
  )
  return (
    <div className="contents">
      {/* The name reads under the figure, and comes first for a screen reader. */}
      <dt className="col-start-1 row-start-2 min-w-0 truncate text-[12px] leading-5 text-kumo-subtle">
        {figure.label}
      </dt>
      {figure.value === null ? <Tooltip content="Still counting" render={value} /> : value}
    </div>
  )
}

/** A figure beside the headline: its name, then the value in the data face. */
function Secondary({
  figure,
  tick,
  section,
  line,
}: {
  figure: SummaryFigure
  tick: unknown
  section: string
  /** Which of the headline's lines it reads on. */
  line: 'number' | 'name'
}) {
  const flashes = useFlash(figure.value, tick)
  return (
    <div
      className={cn(
        'col-start-2 flex min-w-0 items-baseline justify-end gap-2 text-[12px] leading-5',
        line === 'number' ? 'row-start-1' : 'row-start-2',
      )}
    >
      <dt className="min-w-0 truncate text-kumo-subtle">{figure.label}</dt>
      <dd
        key={flashes}
        className={cn(
          '-mx-1 shrink-0 rounded px-1 font-mono text-kumo-default tabular-nums',
          flashes > 0 && FLASH,
        )}
        data-flashes={flashes}
        data-testid={figureTestId(section, figure)}
      >
        {figure.value === null ? (
          <Tooltip content="Still counting" render={<span>{figureText(figure)}</span>} />
        ) : (
          figureText(figure)
        )}
      </dd>
    </div>
  )
}

const FLASH =
  'bg-[linear-gradient(var(--row-flash),var(--row-flash))] [animation:row-flash_1.6s_ease-out] motion-reduce:[animation:none]'

function figureTestId(section: string, figure: SummaryFigure): string {
  return `overview-figure-${section}-${figure.label.toLowerCase().replaceAll(' ', '-')}`
}
