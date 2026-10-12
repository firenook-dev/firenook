// The detail panel every section opens beside its list: a user, an object,
// an invocation, a message, a task. One anatomy for all of them, measured on
// Firestore's document inspector, so nine sections read as one product:
//
//   header 44 px   the entity's key (data face, copyable) · meta · actions ·
//                  previous / next · close
//   tabs           segmented, `Label · N`
//   body           one content column (px-5): facts, payloads, sections
//   footer 48 px   tools left │ destructive · · · the primary action right
//
// Its width is the person's: a share of the window on first open, dragged on
// the left edge, remembered per inspector (`widthKey`). It floats over the
// list below `xl` and sits in the flow from `xl`, positioned `relative`
// there, never `static` — only a positioned element is a containing block,
// and under `static` the grip on its edge escaped to an ancestor and drew
// itself down the side of the list.

import { Button, InlineCopyText, Tabs, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { type ReactNode, createContext, useContext, useMemo } from 'react'
import { isTyping } from '@/lib/shortcuts'
import { CODE_LABEL_AT, useInspectorWidth } from './inspector-width'
import { WidthHandle } from './width-handle'

/** What the parts of an open inspector can read about it. */
const InspectorContext = createContext<{ widthKey: string } | null>(null)

/**
 * Whether the footer has room for its words: below `CODE_LABEL_AT` (350 px)
 * the least important control keeps its glyph and gives up its word. Labels
 * go by width, never by rule.
 */
export function useInspectorRoom(): { width: number; labels: boolean } {
  const context = useContext(InspectorContext)
  const { width } = useInspectorWidth(context?.widthKey ?? 'detached')
  return { width, labels: width >= CODE_LABEL_AT }
}

/** A key pressed in one of these belongs to it, not to the inspector around it. */
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

export interface InspectorTabs {
  items: readonly { value: string; label: string; count?: number | undefined }[]
  value: string
  onChange: (value: string) => void
}

export function Inspector({
  widthKey,
  title,
  meta,
  actions,
  onClose,
  closeLabel,
  tabs,
  onPrev,
  onNext,
  noun,
  footer,
  testId,
  children,
}: {
  /** Where its width is remembered: one per inspector ('auth.user', 'logs.entry'). */
  widthKey: string
  /** An `InspectorTitle` for an entity; a `PanelTitle` for a panel whose title is English. */
  title: ReactNode
  /** Quiet facts beside the title: `472 B · 3 d ago`. */
  meta?: ReactNode
  /** Icon actions in the header: Kumo ghost `sm` squares, each in a `Tooltip`. */
  actions?: ReactNode
  onClose: () => void
  /** "Close the user". */
  closeLabel: string
  tabs?: InspectorTabs | undefined
  /**
   * The previous and next row of the list the item came from. The table's
   * ↑ ↓ move the same cursor and the inspector follows; each chevron is
   * disabled where there is no row that way (the ends of what is loaded).
   */
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  /** What a row is, for the chevrons' tooltips: "Previous user ↑". Shows the chevrons. */
  noun?: string | undefined
  /** An `InspectorFooter`. */
  footer?: ReactNode
  testId: string
  children: ReactNode
}) {
  const { width } = useInspectorWidth(widthKey)
  const stepping = noun !== undefined || onPrev !== undefined || onNext !== undefined
  const thing = noun ?? 'row'
  const context = useMemo(() => ({ widthKey }), [widthKey])
  return (
    <InspectorContext value={context}>
      <aside
        className="absolute inset-y-0 right-0 z-20 flex min-h-0 max-w-full shrink-0 flex-col border-l border-kumo-line bg-kumo-base shadow-lg xl:relative xl:shadow-none"
        // The person's width, dragged: the one thing a class cannot carry.
        style={{ width }}
        aria-label={typeof title === 'string' ? title : undefined}
        data-testid={testId}
        onKeyDown={(event) => {
          // Escape closes the inspector before anything else on the page
          // clears: but not from a field (a value being typed reverts
          // first), and not from a menu or dialog that hangs off it.
          if (event.key !== 'Escape' || event.defaultPrevented) return
          if (isTyping(event.target)) return
          if (event.target instanceof Element && event.target.closest(OVERLAY)) return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <WidthHandle widthKey={widthKey} testId={`${testId}-resize`} />
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line pr-3 pl-5">
          <div className="flex min-w-0 flex-1 items-center">{title}</div>
          {meta !== undefined && meta !== null && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-[12px] text-kumo-subtle tabular-nums"
              data-testid={`${testId}-meta`}
            >
              {meta}
            </span>
          )}
          {actions !== undefined && actions !== null && (
            <span className="flex shrink-0 items-center gap-0.5">{actions}</span>
          )}
          {stepping && (
            <span className="flex shrink-0 items-center gap-0.5">
              <StepButton
                label={`Previous ${thing}`}
                keyHint="↑"
                icon={<CaretUpIcon />}
                onClick={onPrev}
                testId={`${testId}-prev`}
              />
              <StepButton
                label={`Next ${thing}`}
                keyHint="↓"
                icon={<CaretDownIcon />}
                onClick={onNext}
                testId={`${testId}-next`}
              />
            </span>
          )}
          <Tooltip
            content={closeLabel}
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<XIcon />}
                aria-label={closeLabel}
                onClick={onClose}
                data-testid={`${testId}-close`}
              />
            }
          />
        </header>
        {tabs && (
          <div
            className="shrink-0 border-b border-kumo-line px-5 py-2"
            data-testid={`${testId}-tabs`}
          >
            <Tabs
              size="sm"
              variant="segmented"
              value={tabs.value}
              onValueChange={tabs.onChange}
              tabs={tabs.items.map((item) => ({
                value: item.value,
                label: item.count === undefined ? item.label : `${item.label} · ${item.count}`,
              }))}
            />
          </div>
        )}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          data-testid={`${testId}-body`}
        >
          {children}
        </div>
        {footer}
      </aside>
    </InspectorContext>
  )
}

function StepButton({
  label,
  keyHint,
  icon,
  onClick,
  testId,
}: {
  label: string
  keyHint: string
  icon: ReactNode
  onClick: (() => void) | undefined
  testId: string
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={icon}
      aria-label={label}
      disabled={onClick === undefined}
      onClick={onClick}
      data-testid={testId}
    />
  )
  // A disabled button takes no pointer, so its tip hangs on a wrapper, as
  // Kumo's own Button does.
  return onClick === undefined ? (
    <Tooltip
      content={`${label} ${keyHint}`}
      render={<span className="inline-flex shrink-0">{button}</span>}
    />
  ) : (
    <Tooltip content={`${label} ${keyHint}`} render={button} />
  )
}

/**
 * An entity inspector's title: the entity's key, which is data, so the data
 * face at 12 px — copyable, with the whole value in a tooltip when the panel
 * cuts it. `children` is what to show when it is not the key itself.
 */
export function InspectorTitle({ value, children }: { value: string; children?: ReactNode }) {
  // Kumo's monospace variants are fixed at 13 px; the face is asked for and
  // the size comes from the scale.
  return (
    <Tooltip
      content={value}
      render={
        <InlineCopyText
          value={value}
          variant="body"
          size="xs"
          className="min-w-0 flex-1 truncate font-mono"
        >
          {children ?? value}
        </InlineCopyText>
      }
    />
  )
}

/**
 * A band of the body with a heading: `Claims · 3`. Empty, it is one line —
 * `Sessions · none` — because a heading followed by "None yet." is two grey
 * lines of which the louder says nothing.
 */
export function InspectorSection({
  title,
  count,
  action,
  testId,
  children,
}: {
  title: string
  /** Shown after the title; `0` reads `none` and the section is its heading alone. */
  count?: number | undefined
  /** One control at the right of the heading: an icon button, a small "Add". */
  action?: ReactNode
  testId?: string | undefined
  children?: ReactNode
}) {
  const empty = count === 0
  const hasBody = !empty && children !== undefined && children !== null && children !== false
  return (
    <section
      aria-label={title}
      className="shrink-0 border-t border-kumo-line px-5 py-2 first:border-t-0"
      data-testid={testId}
    >
      <div className={`flex min-h-6 items-center gap-2 ${hasBody ? 'mb-1' : ''}`}>
        <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
          {title}
          {count !== undefined && ` · ${empty ? 'none' : count.toLocaleString('en-US')}`}
        </h3>
        {action !== undefined && action !== null && (
          <span className="ml-auto flex items-center">{action}</span>
        )}
      </div>
      {hasBody && children}
    </section>
  )
}

/** Whether a slot was given something to draw. */
function has(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false
}

/**
 * The inspector's foot: tools on the left — what looks at the item — then a
 * rule, then what destroys it (a ghost button with red children: `TrashIcon
 * className="text-kumo-danger"` and a red word), and the one primary action
 * at the right end, where a hand goes looking for it and as far from the
 * destructive control as the row allows.
 */
export function InspectorFooter({
  tools,
  danger,
  primary,
  testId,
}: {
  tools?: ReactNode
  danger?: ReactNode
  primary?: ReactNode
  testId?: string | undefined
}) {
  return (
    <footer
      className="flex h-12 shrink-0 items-center gap-2 border-t border-kumo-line px-5"
      data-testid={testId}
    >
      <div className="flex shrink-0 items-center gap-1">
        {tools}
        {has(tools) && has(danger) && (
          <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
        )}
        {danger}
      </div>
      {has(primary) && <div className="ml-auto flex min-w-0 items-center gap-2">{primary}</div>}
    </footer>
  )
}
