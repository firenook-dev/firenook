// A link to something another section shows — the user a log line names,
// the function an event ran, the document a trigger read — without the
// section drawing it knowing the other's URLs. The target's registry says
// where a kind opens (`routes[kind]`, through `linkTo`), so the link follows
// that section as it lands: while the target section is absent from this
// engine or not built yet, the same thing is plain text, never a link into
// a placeholder.
//
// It is data, so it is the data face at 12 px, and it can always be copied:
// the thing a person most often does with an id is paste it somewhere.

import { Tooltip } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { EntityRef } from '@/api/generated/EntityRef'
import { useLinkTo } from '@/lib/links'
import { sectionById } from '@/lib/services'
import { CopyStripButton } from './strip-button'

export function EntityLink({ entity, testId }: { entity: EntityRef; testId?: string | undefined }) {
  const link = useLinkTo(entity)
  const text = entity.label ?? entity.key
  const section = sectionById(entity.kind.slice(0, Math.max(0, entity.kind.indexOf('.'))))
  return (
    <span
      className="group/entity relative inline-flex max-w-full min-w-0 items-start align-top"
      data-testid={testId}
      data-kind={entity.kind}
    >
      {link ? (
        <Tooltip
          content={`Open in ${section?.label ?? 'its section'}`}
          render={
            <Link
              to={link.to as never}
              search={link.search as never}
              className="min-w-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              data-testid={testId && `${testId}-link`}
            >
              {text}
            </Link>
          }
        />
      ) : (
        <span className="min-w-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] text-kumo-default">
          {text}
        </span>
      )}
      {/* The copy floats beside the link while it is pointed at — an id is
          most often wanted on the clipboard — and takes no room at rest, so
          whatever follows the link (a closing quote, a comma) sits against it. */}
      <span className="pointer-events-none absolute top-0 left-full z-10 flex items-center rounded-md bg-kumo-base px-0.5 opacity-0 shadow-sm ring ring-kumo-line group-hover/entity:pointer-events-auto group-hover/entity:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <CopyStripButton
          value={text}
          label={`Copy ${text}`}
          title="Copy"
          testId={testId && `${testId}-copy`}
        />
      </span>
    </span>
  )
}
