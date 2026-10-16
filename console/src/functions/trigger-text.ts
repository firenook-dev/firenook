// A trigger in words: one line for a table cell (`orders/{orderId} created ·
// (default)`), one sentence for the summary strip and the Trigger tab ("Runs
// when a document matching orders/{orderId} in (default) is created"), and
// the status a function that receives nothing is in, said out loud.
//
// Everything here reads the engine's flattened trigger (`FunctionTrigger`)
// and the kind it computed; it never parses a definition of its own.

import type { FunctionKind } from '@/api/generated/compute/FunctionKind'
import type { FunctionNotLoaded } from '@/api/generated/compute/FunctionNotLoaded'
import type { FunctionStatus } from '@/api/generated/compute/FunctionStatus'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { FunctionTrigger } from '@/api/generated/compute/FunctionTrigger'
import { describeSchedule } from './schedule-text'

/** The last segment of a resource name: `projects/p/topics/emails` → `emails`. */
export function lastSegment(name: string): string {
  const at = name.lastIndexOf('/')
  return at === -1 ? name : name.slice(at + 1)
}

/** The path an HTTP function answers on, from its URL: `/demo-x/us-central1/api`. */
export function urlPath(url: string | null): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * What a change is called, from the event type of either generation:
 * `document.create` and `document.v1.created` are both `created`.
 */
export function changeWord(eventType: string | null): string | undefined {
  if (!eventType) return undefined
  const type = eventType.replace(/\.withAuthContext$/, '')
  const tail = type.slice(type.lastIndexOf('.') + 1)
  const words: Record<string, string> = {
    create: 'created',
    created: 'created',
    update: 'updated',
    updated: 'updated',
    delete: 'deleted',
    deleted: 'deleted',
    write: 'written',
    written: 'written',
    finalize: 'finalized',
    finalized: 'finalized',
    archive: 'archived',
    archived: 'archived',
    metadataUpdate: 'metadata updated',
    metadataUpdated: 'metadata updated',
    messagePublished: 'published',
    publish: 'published',
    beforeCreate: 'before sign-up',
    beforeSignIn: 'before sign-in',
    beforeSendEmail: 'before an email is sent',
    beforeSendSms: 'before an SMS is sent',
  }
  return words[tail]
}

/** A blocking function's event, as the person knows it. */
export function blockingWords(event: string | null): string {
  if (event === 'beforeCreate') return 'beforeCreate (sign-up)'
  if (event === 'beforeSignIn') return 'beforeSignIn (sign-in)'
  return event ?? 'a blocking event'
}

/** The channel's short name: `projects/p/locations/us-central1/channels/firebase` → `firebase`. */
export function channelName(channel: string | null): string | undefined {
  return channel ? lastSegment(channel) : undefined
}

function filterText(filters: Readonly<Record<string, string>>, skip: readonly string[]): string {
  return Object.entries(filters)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

/** The expression, in words beside it when it is cron: `0 3 * * * (every day at 03:00) · America/New_York`. */
function scheduleText(trigger: FunctionTrigger): string {
  const expression = trigger.schedule ?? 'a schedule'
  const words = trigger.schedule ? describeSchedule(trigger.schedule) : undefined
  const said = words && words !== expression ? `${expression} (${words})` : expression
  return trigger.timeZone ? `${said} · ${trigger.timeZone}` : said
}

/**
 * The trigger as one line of data, for the overview's Trigger column and
 * the panel's tooltip: what a person would retype to find it in code.
 */
export function triggerText(summary: Pick<FunctionSummary, 'kind' | 'trigger' | 'url'>): string {
  const { kind, trigger } = summary
  switch (kind) {
    case 'http':
    case 'callable':
      return urlPath(summary.url) ?? ''
    case 'firestore': {
      const parts = [trigger.document ?? trigger.resource ?? '', changeWord(trigger.eventType)]
      const line = parts.filter(Boolean).join(' ')
      return trigger.database ? `${line} · ${trigger.database}` : line
    }
    case 'storage': {
      const bucket = trigger.bucket ?? trigger.resource
      const change = changeWord(trigger.eventType)
      return [bucket ? `gs://${bucket}` : undefined, change].filter(Boolean).join(' ')
    }
    case 'auth':
      return `user ${changeWord(trigger.eventType) ?? trigger.eventType ?? ''}`.trim()
    case 'pubsub':
      return trigger.topic ? `topic ${lastSegment(trigger.topic)}` : (trigger.eventType ?? '')
    case 'schedule':
      return scheduleText(trigger)
    case 'eventarc': {
      const extra = filterText(trigger.filters, [])
      const base = [trigger.eventType, channelName(trigger.channel)].filter(Boolean).join(' · ')
      return extra ? `${base} · ${extra}` : base
    }
    case 'tasks':
      return 'task queue'
    case 'blocking':
      return blockingWords(trigger.blockingEvent)
    case 'alerts':
      return trigger.filters.alerttype ?? trigger.eventType ?? ''
    case 'database': {
      const ref = trigger.pathPatterns.ref ?? trigger.resource ?? ''
      return [ref, changeWord(trigger.eventType)].filter(Boolean).join(' ')
    }
    default:
      return trigger.eventType ?? ''
  }
}

/** "is created", "is created, updated or deleted". */
function changeClause(eventType: string | null): string {
  const change = changeWord(eventType)
  if (change === 'written') return 'is created, updated or deleted'
  return change ? `is ${change}` : 'changes'
}

/**
 * The trigger as a sentence, for the summary strip of a background function
 * and the head of its Trigger tab. Code in it is marked with backticks,
 * which the caller renders in the data face (`sentenceParts`).
 */
export function triggerSentence(
  summary: Pick<FunctionSummary, 'kind' | 'trigger' | 'url'>,
): string {
  const { kind, trigger } = summary
  switch (kind) {
    case 'http':
      return `Runs on an HTTP request to \`${urlPath(summary.url) ?? ''}\``
    case 'callable':
      return `Runs when an app calls it through the Functions SDK`
    case 'firestore':
      return `Runs when a document matching \`${trigger.document ?? trigger.resource ?? ''}\` in \`${trigger.database ?? '(default)'}\` ${changeClause(trigger.eventType)}`
    case 'storage': {
      const change = changeWord(trigger.eventType) ?? 'changed'
      return `Runs when an object in \`${trigger.bucket ?? trigger.resource ?? ''}\` is ${change}`
    }
    case 'auth':
      return `Runs when an Authentication user is ${changeWord(trigger.eventType) ?? 'changed'}`
    case 'pubsub':
      return `Runs for each message published to \`${trigger.topic ? lastSegment(trigger.topic) : ''}\``
    case 'schedule': {
      const words = trigger.schedule ? describeSchedule(trigger.schedule) : undefined
      const said =
        words && words !== trigger.schedule
          ? `\`${trigger.schedule ?? ''}\` (${words})`
          : `\`${trigger.schedule ?? ''}\``
      return trigger.timeZone ? `Runs ${said} in \`${trigger.timeZone}\`` : `Runs ${said}`
    }
    case 'eventarc': {
      const filters = filterText(trigger.filters, [])
      const base = `Runs for \`${trigger.eventType ?? ''}\` events on \`${channelName(trigger.channel) ?? 'the default channel'}\``
      return filters ? `${base} whose \`${filters}\`` : base
    }
    case 'tasks':
      return 'Runs for each task in its Cloud Tasks queue'
    case 'blocking':
      return `Decides each ${trigger.blockingEvent === 'beforeSignIn' ? 'sign-in' : 'sign-up'} before Authentication completes it (\`${trigger.blockingEvent ?? ''}\`)`
    case 'alerts':
      return `Runs for Firebase Alerts of type \`${trigger.filters.alerttype ?? trigger.eventType ?? ''}\``
    case 'database':
      return `Runs when Realtime Database data at \`${trigger.pathPatterns.ref ?? trigger.resource ?? ''}\` ${changeClause(trigger.eventType)}`
    default:
      return trigger.eventType
        ? `Runs for \`${trigger.eventType}\` events`
        : 'Runs on a trigger the console has no words for'
  }
}

/** A sentence split into prose and the code inside its backticks. */
export function sentenceParts(sentence: string): { text: string; code: boolean }[] {
  return sentence
    .split('`')
    .map((text, index) => ({ text, code: index % 2 === 1 }))
    .filter((part) => part.text !== '')
}

/** The status word a list shows, for every status but receiving. */
export const STATUS_WORDS: Readonly<Record<FunctionStatus, string>> = {
  receiving: 'Receiving',
  ignored: 'Ignored',
  noService: 'No service',
  paused: 'Paused',
  removed: 'Removed',
}

/**
 * The engine's reason as a sentence: a capital and a full stop, whatever the
 * runtime wrote — except where it starts with data (an event type, a path),
 * which keeps its own spelling.
 */
export function asSentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return trimmed
  const first = /^\S+/.exec(trimmed)?.[0] ?? ''
  const prose = /^[a-z]+[,:;.!?]?$/.test(first)
  const capital = prose ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

/**
 * Why a function receives nothing, without the runtime's own lead-in
 * ("function ignored because …"), which the status word already says.
 */
export function statusReasonText(reason: string): string {
  return asSentence(reason.trim().replace(/^function (?:ignored|removed|paused) because\s+/i, ''))
}

/** "Ignored: The database emulator does not exist." — the status and the engine's reason. */
export function statusText(summary: Pick<FunctionSummary, 'status' | 'statusReason'>): string {
  const word = STATUS_WORDS[summary.status]
  if (summary.status === 'receiving' || !summary.statusReason) return word
  return `${word}: ${statusReasonText(summary.statusReason)}`
}

/** "Not loaded: google.firebase.remoteconfig.remoteConfig.v1.updated is not emulated." */
export function notLoadedText(entry: FunctionNotLoaded): string {
  return `Not loaded: ${asSentence(entry.reason)}`
}

/** The service a kind needs, as a section id, for "needs Storage" notices. */
export function serviceSection(
  service: string | null,
): 'firestore' | 'storage' | 'auth' | 'pubsub' | undefined {
  if (
    service === 'firestore' ||
    service === 'storage' ||
    service === 'auth' ||
    service === 'pubsub'
  )
    return service
  return undefined
}

/** What a function of `kind` waiting on `service` would receive: "onUpload to receive events". */
export function receivesWhat(kind: FunctionKind, name: string): string {
  if (kind === 'schedule') return `${name} to run on its schedule`
  return `${name} to receive events`
}
