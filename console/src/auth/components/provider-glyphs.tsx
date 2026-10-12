// A row's sign-in providers as quiet 14 px glyphs, one per kind, with every
// id in one tooltip: the ids are what a developer types into a filter, and a
// row of brand logos in colour would be the loudest thing in the grid for a
// fact that is rarely the point.

import { Tooltip } from '@cloudflare/kumo'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import { glyphsTooltip, rowGlyphs } from '../providers'

export function ProviderGlyphs({
  row,
}: {
  row: Pick<AuthUserRow, 'providers' | 'customAuth' | 'anonymous'>
}) {
  const glyphs = rowGlyphs(row)
  if (glyphs.length === 0)
    return (
      <span
        className="block h-px w-3 bg-kumo-line"
        role="img"
        aria-label="no provider"
        data-testid="not-set"
      />
    )
  return (
    <Tooltip
      content={<span className="whitespace-pre-line">{glyphsTooltip(glyphs)}</span>}
      render={
        <span
          className="inline-flex max-w-full items-center gap-1 text-kumo-subtle"
          data-testid="provider-glyphs"
          aria-label={glyphs.flatMap((entry) => entry.ids).join(', ')}
        >
          {glyphs.map((entry) => (
            <entry.glyph key={entry.key} size={14} className="shrink-0" aria-hidden />
          ))}
        </span>
      }
    />
  )
}
