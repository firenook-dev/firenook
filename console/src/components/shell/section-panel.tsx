// A section's second column. The shell keeps a slot beside the content;
// a section renders `<SectionPanel label="Schema">…</SectionPanel>` and its
// children appear there, still inside the section's own React tree (a
// portal), so every provider the section set up reaches them. The shell
// shows the slot only while a section fills it, and hides it on `t`.

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
