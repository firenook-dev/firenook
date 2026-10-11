// The glyph on a toggle that shows or hides a column of the shell: Kumo's
// own, the window and bar its `Sidebar.Trigger` draws at the foot of the
// nav. Kumo keeps it to the nav — it reads the nav's state from the
// sidebar's context — so the geometry is repeated here with the state
// passed in. The section panel's toggle drew Phosphor's half-filled square
// beside it: two marks for one idea, a column that comes and goes.

export function PanelIcon({ open, size = 18 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M21.25 6.72v10.56a2.97 2.97 0 0 1-2.97 2.97H5.72a2.97 2.97 0 0 1-2.97-2.97V6.72a2.97 2.97 0 0 1 2.97-2.97h12.56a2.97 2.97 0 0 1 2.97 2.97" />
      {/* The bar sits where the nav's does in the same state. */}
      <path
        d="M6.25 7.25v9.5"
        className={`transition-transform duration-200 motion-reduce:transition-none ${open ? 'translate-x-px' : 'translate-x-[10.5px]'}`}
      />
    </svg>
  )
}
