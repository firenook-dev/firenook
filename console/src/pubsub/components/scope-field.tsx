// Row one's path: `project › topic › subscription`, a field the way an
// address bar is. Reading it and typing it are the same box — click the
// empty end and type a topic id, `topic/subscription` or a full name, with
// completion from the topics index — and the one control that acts on the
// whole path, copying the full resource name, sits inside it against its
// right edge, where a longer path cannot move it. Where you are is the
// segment that is not faded.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import { PlusIcon } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { Anchored } from '@/components/console/completions'
import { CopyGlyph, useCopied } from '@/components/kit'
import { type TypedScope, idProblem, resolveTyped, scopeCompletions, shortName } from '../names'

export function ScopeField({
  index,
  project,
  topic,
  subscription,
  detached,
  onNavigate,
  onCreateTopic,
}: {
  index: PubsubTopicIndex | undefined
  project: string
  /** The topic's full name, when one is in view. */
  topic: string | undefined
  /** The subscription's full name, when one is in view. */
  subscription: string | undefined
  /** The subscription's topic was deleted. */
  detached: boolean
  onNavigate: (scope: TypedScope) => void
  /** A typed id that names nothing yet: offered as a new topic. */
  onCreateTopic: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const field = useRef<HTMLDivElement>(null)
  const { copied, copy } = useCopied()
  const fullName = subscription ?? topic ?? `projects/${project}`
  const completions = editing === null ? [] : scopeCompletions(editing, index)
  const typed = editing?.trim() ?? ''
  const creatable =
    typed !== '' &&
    !typed.includes('/') &&
    idProblem(typed) === undefined &&
    resolveTyped(typed, index, project) === undefined
      ? typed
      : undefined
  const choices = completions.length + (creatable ? 1 : 0)

  const commit = (text: string) => {
    const scope = resolveTyped(text, index, project)
    if (!scope) return
    setEditing(null)
    onNavigate(scope)
  }
  const pick = (at: number) => {
    const completion = completions[at]
    if (completion) {
      commit(completion.label)
      return
    }
    if (creatable) {
      setEditing(null)
      onCreateTopic(creatable)
    }
  }

  return (
    <div
      ref={field}
      className={cn(
        'relative flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 pl-1',
        editing === null ? 'hover:ink' : 'bg-kumo-control ring ring-kumo-focus',
      )}
      data-testid="pubsub-scope"
    >
      {editing === null ? (
        <>
          <div className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Segment
              label={project === '' ? '(empty project)' : project}
              current={!topic && !subscription}
              onClick={() => onNavigate({})}
              first
              testId="scope-project"
            />
            {(topic || detached) && (
              <Segment
                label={topic ? shortName(topic) : '_deleted-topic_'}
                current={!subscription}
                {...(topic ? { onClick: () => onNavigate({ topic }) } : {})}
                testId="scope-topic"
              />
            )}
            {subscription && (
              <Segment label={shortName(subscription)} current testId="scope-subscription" />
            )}
          </div>
          <button
            type="button"
            className="h-7 flex-1 basis-0 cursor-text rounded-md px-1.5 text-left text-[12px] text-kumo-inactive"
            onClick={() => {
              setHighlight(0)
              setEditing('')
            }}
            aria-label="Go to a topic or subscription"
            data-testid="scope-edit"
          >
            {!topic && !subscription ? 'Type a topic or subscription id' : ''}
          </button>
        </>
      ) : (
        <input
          ref={input}
          // Mounted by the click that starts editing: it takes the keys at once.
          autoFocus
          value={editing}
          onChange={(event) => {
            setEditing(event.target.value)
            setHighlight(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && choices > 0) {
              event.preventDefault()
              setHighlight((at) => (at + 1) % choices)
            } else if (event.key === 'ArrowUp' && choices > 0) {
              event.preventDefault()
              setHighlight((at) => (at - 1 + choices) % choices)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (resolveTyped(editing, index, project)) commit(editing)
              else if (choices > 0) pick(highlight)
            } else if (event.key === 'Tab' && completions[highlight]) {
              event.preventDefault()
              setEditing(completions[highlight]?.label ?? editing)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setEditing(null)
            }
          }}
          onBlur={() =>
            window.setTimeout(
              () => setEditing((current) => (current === editing ? null : current)),
              120,
            )
          }
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none placeholder:font-sans placeholder:text-kumo-placeholder"
          placeholder="orders, orders/orders-worker or a full name"
          spellCheck={false}
          autoComplete="off"
          aria-label="Topic or subscription"
          role="combobox"
          aria-expanded={choices > 0}
          aria-autocomplete="list"
          data-testid="scope-input"
        />
      )}
      <Tooltip
        content={copied ? 'Copied' : `Copy ${fullName}`}
        render={
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CopyGlyph copied={copied} />}
            aria-label="Copy the full name"
            className="h-7 w-7 shrink-0"
            onClick={() => void copy(fullName)}
            data-testid="scope-copy"
          />
        }
      />
      {editing !== null && choices > 0 && (
        <Anchored anchor={field} testId="scope-completions" width="content">
          <ul className="max-h-64 w-max max-w-[40rem] min-w-80 overflow-auto p-1" role="listbox">
            {creatable && (
              <li>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:ink',
                    highlight === completions.length && 'bg-kumo-tint',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(completions.length)}
                  data-testid="scope-create-topic"
                >
                  <PlusIcon size={14} className="shrink-0 text-kumo-subtle" />
                  <span className="min-w-0 flex-1 truncate">
                    Create topic <span className="font-mono text-[0.9em]">{creatable}</span>
                  </span>
                </button>
              </li>
            )}
            {completions.map((completion, at) => (
              <li key={completion.label}>
                <button
                  type="button"
                  role="option"
                  aria-selected={highlight === at}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:ink',
                    highlight === at && 'bg-kumo-tint',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(at)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {completion.label}
                  </span>
                  <span className="shrink-0 text-[11px] text-kumo-subtle">{completion.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </Anchored>
      )}
    </div>
  )
}

function Segment({
  label,
  current,
  onClick,
  first,
  testId,
}: {
  label: string
  current: boolean
  onClick?: () => void
  first?: boolean
  testId: string
}) {
  return (
    <span className="flex shrink-0 items-center">
      {!first && (
        <span className="px-0.5 text-[12px] text-kumo-inactive" aria-hidden>
          ›
        </span>
      )}
      {onClick && !current ? (
        <button
          type="button"
          onClick={onClick}
          className="flex h-7 items-center rounded-md px-1.5 font-mono text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
          data-testid={testId}
        >
          {label}
        </button>
      ) : (
        <span
          className={cn(
            'flex h-7 items-center px-1.5 font-mono text-[12px]',
            current ? 'text-kumo-default' : 'text-kumo-subtle',
          )}
          aria-current={current ? 'location' : undefined}
          data-testid={testId}
        >
          {label}
        </span>
      )}
    </span>
  )
}
