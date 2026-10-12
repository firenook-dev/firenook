// One line in full, beside the list: the kit's `Inspector` with the
// message as its title, the level and time beside it, and bands for the
// whole message (wrapped and selectable), the payload's tree (each value
// can filter the list), where the line came from, and every link it
// carries — each a link only where the section it opens is built. It
// follows the list's cursor (↑ ↓, or its chevrons). The footer copies the
// line, hides lines like it, and reads the log around it in time.
//
// A line the list does not hold (an `entry=` link to one older than what
// is loaded) is read from the engine by its cursor; one the engine no
// longer keeps, or that an earlier engine run wrote, says so, with the way
// back to the latest lines.

import { Button, Empty, Tooltip } from '@cloudflare/kumo'
import {
  BracketsCurlyIcon,
  ClockClockwiseIcon,
  CopyIcon,
  EyeSlashIcon,
  FunnelSimpleIcon,
  ScrollIcon,
  SkipForwardIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/api/client'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { EntityLink } from '@/components/console/entity-link'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  useInspectorRoom,
} from '@/components/console/inspector'
import { JsonTree } from '@/components/console/json-tree'
import type { JsonPath } from '@/components/console/json-tree-model'
import { type KeyValueItem, KeyValueList } from '@/components/console/key-value-list'
import { PanelTitle } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatClock, formatNumber, relativeTime, useClockFormat } from '@/lib/format'
import { kindInfo, kindLabel } from '@/observe/kinds'
import { LevelWord } from '@/observe/level-word'
import { functionName } from '@/observe/source-chip'
import { entryQuery } from '../api'
import type { Highlighter } from '../highlight'
import { Highlighted } from './highlighted'

/** What the inspector's controls do, the page's to decide. */
export interface InspectorActions {
  copy: (entry: LogEntry) => void
  copyJson: (entry: LogEntry) => void
  hideLike: (entry: LogEntry) => void
  showInvocation: (execution: string) => void
  around: (entry: LogEntry) => void
  fromHere: (entry: LogEntry) => void
  filterPayload: (path: JsonPath, value: unknown) => void
  backToLatest: () => void
}

export function LogInspector({
  cursor,
  entry: held,
  repeat,
  last,
  project,
  highlight,
  actions,
  onClose,
  onPrev,
  onNext,
}: {
  /** The line's cursor (the URL's `entry`). */
  cursor: string
  /** The line, when the list holds it. */
  entry: LogEntry | undefined
  /** How many times the row's line was printed in a row. */
  repeat: number
  /** The newest of those, when it repeats. */
  last: LogEntry | undefined
  project: string
  highlight: Highlighter | undefined
  actions: InspectorActions
  onClose: () => void
  onPrev: (() => void) | undefined
  onNext: (() => void) | undefined
}) {
  const fetched = useQuery({ ...entryQuery(project, cursor), enabled: held === undefined })
  const entry = held ?? fetched.data
  const common = {
    widthKey: 'logs.entry',
    onClose,
    closeLabel: 'Close the line',
    onPrev,
    onNext,
    noun: 'line',
    testId: 'log-inspector',
  }
  if (!entry) {
    const error = fetched.error
    return (
      <Inspector {...common} title={<PanelTitle>Log line</PanelTitle>}>
        {fetched.isPending ? (
          <p className="m-0 px-5 py-4 text-[13px] text-kumo-subtle">Reading the line…</p>
        ) : (
          <div data-testid="log-inspector-gone">
            <Empty
              icon={<ScrollIcon size={40} className="text-kumo-inactive" />}
              title={error instanceof ApiError ? error.message : 'The engine did not answer.'}
              contents={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={actions.backToLatest}
                  data-testid="log-inspector-latest"
                >
                  Back to the latest
                </Button>
              }
            />
          </div>
        )}
      </Inspector>
    )
  }
  return (
    <Inspector
      {...common}
      title={<LineTitle entry={entry} />}
      meta={<LineMeta entry={entry} />}
      footer={<LineFooter entry={entry} actions={actions} />}
    >
      <InspectorSection title="When" testId="log-inspector-when">
        <When entry={entry} repeat={repeat} last={last} />
      </InspectorSection>
      <InspectorSection title="Message" testId="log-inspector-message">
        <pre className="m-0 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-kumo-default select-text">
          {highlight ? <Highlighted text={entry.message} highlight={highlight} /> : entry.message}
        </pre>
        {entry.truncated && (
          <p className="m-0 mt-1 text-[12px] text-kumo-subtle">
            The engine cut this line to fit its bounds: 64 KiB of message, 16 KiB of payload.
          </p>
        )}
      </InspectorSection>
      {entry.payload !== undefined && (
        <InspectorSection title="Payload" testId="log-inspector-payload">
          <div className="-mx-2">
            <JsonTree
              value={entry.payload}
              defaultDepth={2}
              onFilter={actions.filterPayload}
              ariaLabel="Payload"
              testId="inspector-payload-tree"
            />
          </div>
        </InspectorSection>
      )}
      <InspectorSection title="Context" testId="log-inspector-context">
        <KeyValueList items={contextItems(entry, actions)} testId="log-inspector-facts" />
      </InspectorSection>
      <InspectorSection title="Links" count={entry.refs?.length ?? 0} testId="log-inspector-links">
        <ul className="m-0 grid list-none gap-1 p-0">
          {(entry.refs ?? []).map((ref) => (
            <li key={`${ref.kind}|${ref.key}`} className="flex min-w-0 items-baseline gap-2">
              <span className="w-28 shrink-0 text-[13px] text-kumo-subtle">
                {refNoun(ref.kind)}
              </span>
              <EntityLink entity={{ ...ref, label: refLabel(ref) }} testId="log-inspector-ref" />
            </li>
          ))}
        </ul>
      </InspectorSection>
    </Inspector>
  )
}

/**
 * A link's words: the part of its key after the scope (`(default)|users/u_1`
 * → `users/u_1`), the database named in front when it is not the default.
 */
export function refLabel(ref: {
  kind: string
  key: string
  label?: string | null | undefined
}): string {
  if (ref.label) return ref.label
  const bar = ref.key.indexOf('|')
  if (bar === -1) return ref.key
  const scope = ref.key.slice(0, bar)
  const rest = ref.key.slice(bar + 1)
  if (ref.kind.startsWith('firestore.') && scope !== '(default)') return `${scope} › ${rest}`
  return rest
}

/** What a link points at, in words. */
function refNoun(kind: string): string {
  const nouns: Record<string, string> = {
    'firestore.document': 'Document',
    'firestore.collection': 'Collection',
    'firestore.decision': 'Rules decision',
    'functions.function': 'Function',
    'functions.invocation': 'Invocation',
    'functions.codebase': 'Codebase',
    'extensions.instance': 'Extension',
    'eventarc.event': 'Event',
    'auth.user': 'User',
    'auth.call': 'Auth call',
    'auth.message': 'Auth message',
    'storage.object': 'Object',
    'storage.folder': 'Folder',
    'storage.decision': 'Rules decision',
    'pubsub.topic': 'Topic',
    'pubsub.subscription': 'Subscription',
    'pubsub.schedule': 'Schedule',
    'tasks.queue': 'Queue',
    'tasks.task': 'Task',
    'logs.entry': 'Log line',
  }
  return nouns[kind] ?? kind
}

/** The message's first line: the inspector's title. */
function LineTitle({ entry }: { entry: LogEntry }) {
  const first = entry.message.split(/\r?\n/, 1)[0] ?? ''
  return (
    <Tooltip
      content={first}
      render={
        <span className="min-w-0 truncate" data-testid="log-inspector-title">
          <PanelTitle>{first || 'Empty line'}</PanelTitle>
        </span>
      }
    />
  )
}

/** The level and the time, beside the title. */
function LineMeta({ entry }: { entry: LogEntry }) {
  const { format } = useClockFormat()
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  return (
    <span className="flex items-center gap-1.5">
      <LevelWord level={entry.level} rail testId="log-inspector-level" />
      <span aria-hidden>·</span>
      <span className="font-mono text-[12px] tabular-nums">
        {formatClock(entry.time, format, now)}
      </span>
    </span>
  )
}

/** The exact time in both zones and how long ago; how often a repeated line came. */
function When({
  entry,
  repeat,
  last,
}: {
  entry: LogEntry
  repeat: number
  last: LogEntry | undefined
}) {
  const now = useNow('second')
  const local = formatClock(entry.time, 'time')
  const date = new Date(entry.time)
  const today = new Date(now).toDateString() === date.toDateString()
  const day = today ? 'Today' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return (
    <div className="grid gap-0.5 text-[12px] text-kumo-subtle">
      <span>
        <span className="font-mono text-kumo-default tabular-nums">
          {day} {local}
        </span>{' '}
        local · <span className="font-mono tabular-nums">{entry.time}</span> ·{' '}
        {relativeTime(entry.time, now)}
      </span>
      {repeat > 1 && last && (
        <span data-testid="log-inspector-repeat">
          Printed {formatNumber(repeat)} times in a row; the last at{' '}
          <span className="font-mono tabular-nums">{formatClock(last.time, 'time')}</span>
        </span>
      )}
    </div>
  )
}

function contextItems(entry: LogEntry, actions: InspectorActions): KeyValueItem[] {
  const items: KeyValueItem[] = []
  if (entry.function) {
    const { region } = functionName(entry.function)
    items.push({
      label: 'function',
      value: entry.function,
      copy: entry.function,
      hint: region ? `In ${region}` : undefined,
      testId: 'fact-function',
    })
  }
  if (entry.codebase)
    items.push({
      label: 'codebase',
      value: entry.codebase,
      copy: entry.codebase,
      testId: 'fact-codebase',
    })
  if (entry.extension)
    items.push({
      label: 'extension',
      value: entry.extension,
      copy: entry.extension,
      testId: 'fact-extension',
    })
  if (entry.execution) {
    const execution = entry.execution
    items.push({
      label: 'execution',
      value: (
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{execution}</span>
          <Button
            variant="ghost"
            size="xs"
            icon={<FunnelSimpleIcon />}
            onClick={() => actions.showInvocation(execution)}
            className="font-sans !text-kumo-link"
            data-testid="show-invocation"
          >
            Show this invocation
          </Button>
        </span>
      ),
      copy: execution,
      testId: 'fact-execution',
    })
  }
  items.push({
    label: 'service',
    value: entry.service,
    copy: entry.service,
    testId: 'fact-service',
  })
  if (entry.source)
    items.push({ label: 'source', value: entry.source, copy: entry.source, testId: 'fact-source' })
  if (entry.kind) {
    const info = kindInfo(entry.kind)
    items.push({
      label: 'kind',
      value: (
        <span>
          {entry.kind}
          <span className="ml-2 font-sans text-[12px] text-kumo-subtle">
            {kindLabel(entry.kind)}
          </span>
        </span>
      ),
      copy: entry.kind,
      hint: info?.problem
        ? 'A problem: kept longer than other lines and counted'
        : info?.internal
          ? 'Engine bookkeeping, left out unless asked for'
          : undefined,
      testId: 'fact-kind',
    })
  }
  items.push({ label: 'cursor', value: entry.cursor, copy: entry.cursor, testId: 'fact-cursor' })
  return items
}

function FooterButton({
  icon,
  label,
  word,
  wordFrom,
  onClick,
  testId,
}: {
  icon: ReactNode
  label: string
  word: string
  /** The inspector's width from which the word shows; below it, the glyph alone. */
  wordFrom: number
  onClick: () => void
  testId: string
}) {
  // Words give way by width, never by rule: the least needed first.
  const labels = useInspectorRoom().width >= wordFrom
  return (
    <Tooltip
      content={label}
      render={
        labels ? (
          <Button variant="secondary" size="sm" icon={icon} onClick={onClick} data-testid={testId}>
            {word}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            shape="square"
            icon={icon}
            aria-label={label}
            onClick={onClick}
            data-testid={testId}
          />
        )
      }
    />
  )
}

function LineFooter({ entry, actions }: { entry: LogEntry; actions: InspectorActions }) {
  return (
    <InspectorFooter
      testId="log-inspector-footer"
      tools={
        <>
          <FooterButton
            icon={<CopyIcon />}
            label="Copy the line as text · c"
            word="Copy"
            wordFrom={620}
            onClick={() => actions.copy(entry)}
            testId="inspector-copy"
          />
          <FooterButton
            icon={<BracketsCurlyIcon />}
            label="Copy the line as JSON · ⇧C"
            word="Copy JSON"
            wordFrom={620}
            onClick={() => actions.copyJson(entry)}
            testId="inspector-copy-json"
          />
          <FooterButton
            icon={<EyeSlashIcon />}
            label="Leave out the lines that start like this one"
            word="Hide lines like this"
            wordFrom={500}
            onClick={() => actions.hideLike(entry)}
            testId="inspector-hide-like"
          />
        </>
      }
      primary={
        <>
          <FooterButton
            icon={<ClockClockwiseIcon />}
            label="Every line within 30 seconds of this one"
            word="Around"
            wordFrom={360}
            onClick={() => actions.around(entry)}
            testId="inspector-around"
          />
          <FooterButton
            icon={<SkipForwardIcon />}
            label="Every line from this one on"
            word="From here"
            wordFrom={360}
            onClick={() => actions.fromHere(entry)}
            testId="inspector-from-here"
          />
        </>
      }
    />
  )
}
