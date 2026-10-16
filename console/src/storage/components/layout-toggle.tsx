// List or grid (`layout`, `v`): two buttons, the one in force pressed. The
// list draws type icons and reads no thumbnail; the grid asks the engine for
// small pictures, a few at a time.

import { Button, Tooltip } from '@cloudflare/kumo'
import { ListIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { useFiles } from '../files-state'

export function LayoutToggle() {
  const files = useFiles()
  const set = (layout: 'list' | 'grid') =>
    files.update({ layout: layout === 'list' ? undefined : layout }, { replace: true })
  return (
    <span className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Layout">
      <Tooltip
        content="List (v)"
        render={
          <Button
            variant={files.layout === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            shape="square"
            icon={<ListIcon />}
            aria-label="List"
            aria-pressed={files.layout === 'list'}
            onClick={() => set('list')}
            data-testid="layout-list"
          />
        }
      />
      <Tooltip
        content="Grid (v)"
        render={
          <Button
            variant={files.layout === 'grid' ? 'secondary' : 'ghost'}
            size="sm"
            shape="square"
            icon={<SquaresFourIcon />}
            aria-label="Grid"
            aria-pressed={files.layout === 'grid'}
            onClick={() => set('grid')}
            data-testid="layout-grid"
          />
        }
      />
    </span>
  )
}
