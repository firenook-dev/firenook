// A section's second column. The shell keeps a slot beside the content;
// a section renders `<SectionPanel label="Schema">…</SectionPanel>` and its
// children appear there, still inside the section's own React tree (a
// portal), so every provider the section set up reaches them. The shell
// shows the slot only while a section fills it, and hides it on `t`.

import { Button, Tooltip } from '@cloudflare/kumo'
import { SquareHalfIcon } from '@phosphor-icons/react'
import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLayout } from '@/lib/layout'

export function SectionPanel({ label, children }: { label: string; children: ReactNode }) {
  const slot = useLayout((state) => state.slot)
  const open = useLayout((state) => state.panelOpen)
  const setPanel = useLayout((state) => state.setPanel)
  useEffect(() => {
    setPanel({ present: true, label })
    return () => setPanel({ present: false, label: '' })
  }, [setPanel, label])
  if (!slot || !open) return null
  return createPortal(children, slot)
}

/**
 * The panel's own hide and show, placed by the section: at the start of
 * the panel's first row while it shows, and at the start of the section's
 * toolbar while it does not. Both begin under the shell's bar at the
 * content's left edge, so the two are one spot — pressed to hide, pressed
 * again where it was to show.
 *
 * It sat in the shell's bar, which is the console's as a whole: the
 * project, the engine, the theme, search. A control for one section's
 * column, above every section, read as a setting of all of them.
 */
export function PanelToggle({ where }: { where: 'panel' | 'toolbar' }) {
  const panel = useLayout((state) => state.panel)
  const open = useLayout((state) => state.panelOpen)
  const toggle = useLayout((state) => state.togglePanel)
  if (!panel.present || open !== (where === 'panel')) return null
  const name = `the ${panel.label.toLowerCase()} panel`
  return (
    <Tooltip
      content={`${open ? 'Hide' : 'Show'} ${name} (t)`}
      render={
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<SquareHalfIcon />}
          aria-label={`${open ? 'Hide' : 'Show'} ${name}`}
          aria-pressed={open}
          onClick={toggle}
          className="shrink-0 !text-kumo-subtle hover:!text-kumo-default"
          data-testid="panel-toggle"
        />
      }
    />
  )
}
