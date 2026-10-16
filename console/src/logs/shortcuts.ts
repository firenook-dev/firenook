// The Logs page's keys, in the console's one registry (`useShortcuts`).
// The feed's own keys (↑ ↓ j k, Enter, End, Home, → ←, o) are `FeedList`'s,
// `p` is the `PauseButton`'s and `/` `f` the filter field's; these are the
// rest of the reserved-keys table's Logs rows, and none is bound twice.

import { useShortcuts } from '@/lib/shortcuts'

export interface LogsCommands {
  /** Escape: close the inspector, else drop the row cursor; false when there was neither. */
  escape: () => boolean
  errorsOnly: () => void
  warningsAndErrors: () => void
  clearView: () => void
  canClear: () => boolean
  /** `c` / Shift+C on the cursor row; false when there is none or text is selected. */
  copyCursor: (json: boolean) => boolean
  hasCursor: () => boolean
  /** F8 / Shift+F8. */
  nextProblem: (step: 1 | -1) => void
  /** Shift+F10: the cursor row's menu. */
  openRowMenu: () => void
}

/** Whether the person has text selected on the page (then `c` is the browser's copy). */
function textSelected(): boolean {
  return (globalThis.getSelection?.()?.toString() ?? '') !== ''
}

export function useLogsShortcuts(commands: LogsCommands): void {
  useShortcuts({ id: 'logs', label: 'Logs' }, [
    {
      key: 'Escape',
      label: 'Close the line, then drop the row cursor',
      when: () => commands.hasCursor(),
      run: () => {
        commands.escape()
      },
    },
    { key: 'e', label: 'Errors only, or back', run: commands.errorsOnly },
    { key: 'w', label: 'Warnings and errors, or back', run: commands.warningsAndErrors },
    {
      key: 'x',
      label: 'Clear the view',
      when: () => commands.canClear(),
      run: commands.clearView,
    },
    {
      key: 'c',
      label: 'Copy the row’s line',
      when: () => commands.hasCursor() && !textSelected(),
      run: () => {
        commands.copyCursor(false)
      },
    },
    {
      key: 'Shift+C',
      label: 'Copy the row as JSON',
      when: () => commands.hasCursor() && !textSelected(),
      run: () => {
        commands.copyCursor(true)
      },
    },
    { key: 'F8', label: 'Next problem', run: () => commands.nextProblem(1) },
    { key: 'Shift+F8', label: 'Previous problem', run: () => commands.nextProblem(-1) },
    {
      key: 'Shift+F10',
      label: 'The row’s menu',
      when: () => commands.hasCursor(),
      run: commands.openRowMenu,
    },
  ])
}
