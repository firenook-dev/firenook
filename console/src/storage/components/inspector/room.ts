// How much the file inspector's foot can say. Firestore's foot holds Code
// and Save, so its words go at the foundation's 350 px; this one holds Code,
// Download, Move, Duplicate, Delete, Revert and Save, which in words need
// about 580 px. Below that the four tools are icons with their names in
// tooltips, so Save is never pushed out of the panel.

import { useInspectorRoom } from '@/components/console/inspector'

/** The panel width from which the foot's tools carry their words. */
export const TOOL_LABELS_AT = 600

/** Whether the foot's tools carry their words at the panel's width now. */
export function useToolLabels(): boolean {
  return useInspectorRoom().width >= TOOL_LABELS_AT
}
