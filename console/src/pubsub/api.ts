// Pub/Sub's Console API, one typed function per route (messaging spec
// §7.3), under `/console/api/v1/pubsub`. Resource names travel whole in
// query strings and JSON bodies, never as path segments: an id may hold
// `%`, `+` and `~`, and a project segment may be empty. Every change is a
// JSON body (DELETE included), which the engine's guard asks of it. Errors
// arrive as `ApiError` with the engine's words and, where it has one, a fix.

import { API_BASE, apiGet, apiSend } from '@/api/client'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Job } from '@/api/generated/Job'
import type { Page } from '@/api/generated/Page'
import type { PubsubBacklogJobBody } from '@/api/generated/messaging/PubsubBacklogJobBody'
import type { PubsubBacklogRow } from '@/api/generated/messaging/PubsubBacklogRow'
import type { PubsubBacklogState } from '@/api/generated/messaging/PubsubBacklogState'
import type { PubsubCommitSchemaBody } from '@/api/generated/messaging/PubsubCommitSchemaBody'
import type { PubsubCreateSchemaBody } from '@/api/generated/messaging/PubsubCreateSchemaBody'
import type { PubsubCreateSubscriptionBody } from '@/api/generated/messaging/PubsubCreateSubscriptionBody'
import type { PubsubCreateTopicBody } from '@/api/generated/messaging/PubsubCreateTopicBody'
import type { PubsubDeleteTopicBody } from '@/api/generated/messaging/PubsubDeleteTopicBody'
import type { PubsubDispatchBody } from '@/api/generated/messaging/PubsubDispatchBody'
import type { PubsubFilterCheck } from '@/api/generated/messaging/PubsubFilterCheck'
import type { PubsubFilterCheckBody } from '@/api/generated/messaging/PubsubFilterCheckBody'
import type { PubsubMessageActionBody } from '@/api/generated/messaging/PubsubMessageActionBody'
import type { PubsubMessageCheck } from '@/api/generated/messaging/PubsubMessageCheck'
import type { PubsubMessageCheckBody } from '@/api/generated/messaging/PubsubMessageCheckBody'
import type { PubsubMessageDetail } from '@/api/generated/messaging/PubsubMessageDetail'
import type { PubsubMessageRow } from '@/api/generated/messaging/PubsubMessageRow'
import type { PubsubNameBody } from '@/api/generated/messaging/PubsubNameBody'
import type { PubsubPreview } from '@/api/generated/messaging/PubsubPreview'
import type { PubsubPublishBody } from '@/api/generated/messaging/PubsubPublishBody'
import type { PubsubPublishJobBody } from '@/api/generated/messaging/PubsubPublishJobBody'
import type { PubsubPublishResult } from '@/api/generated/messaging/PubsubPublishResult'
import type { PubsubPurged } from '@/api/generated/messaging/PubsubPurged'
import type { PubsubPushConfigBody } from '@/api/generated/messaging/PubsubPushConfigBody'
import type { PubsubRedeliverBody } from '@/api/generated/messaging/PubsubRedeliverBody'
import type { PubsubRedelivery } from '@/api/generated/messaging/PubsubRedelivery'
import type { PubsubRejectedList } from '@/api/generated/messaging/PubsubRejectedList'
import type { PubsubSchemaCheck } from '@/api/generated/messaging/PubsubSchemaCheck'
import type { PubsubSchemaCheckBody } from '@/api/generated/messaging/PubsubSchemaCheckBody'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import type { PubsubSchemaExample } from '@/api/generated/messaging/PubsubSchemaExample'
import type { PubsubSchemaExampleBody } from '@/api/generated/messaging/PubsubSchemaExampleBody'
import type { PubsubSchemaSummary } from '@/api/generated/messaging/PubsubSchemaSummary'
import type { PubsubSetup } from '@/api/generated/messaging/PubsubSetup'
import type { PubsubSetupResult } from '@/api/generated/messaging/PubsubSetupResult'
import type { PubsubSubscriptionDetail } from '@/api/generated/messaging/PubsubSubscriptionDetail'
import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicDetail } from '@/api/generated/messaging/PubsubTopicDetail'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import type { PubsubUpdateSubscriptionBody } from '@/api/generated/messaging/PubsubUpdateSubscriptionBody'
import type { PubsubUpdateTopicBody } from '@/api/generated/messaging/PubsubUpdateTopicBody'
import { type PageAt, withQuery } from '@/messaging/api'

export type { PageAt } from '@/messaging/api'

// ------------------------------------------------------------ topics

/** Every topic of `project` with its subscriptions, function targets and counters, answered whole. */
export function getTopicIndex(project: string, signal?: AbortSignal): Promise<PubsubTopicIndex> {
  return apiGet('/pubsub/topics', { project }, signal)
}

/** One topic: its configuration, schema binding, history window and subscriptions. */
export function getTopic(name: string, signal?: AbortSignal): Promise<PubsubTopicDetail> {
  return apiGet('/pubsub/topic', { name }, signal)
}

/** Creates a topic (and `<id>-sub` when `defaultSubscription`). */
export function createTopic(body: PubsubCreateTopicBody): Promise<PubsubTopicSummary> {
  return apiSend('POST', '/pubsub/topics', body)
}

/** Changes what `mask` names (`retention`, `schema`). */
export function updateTopic(body: PubsubUpdateTopicBody): Promise<PubsubTopicSummary> {
  return apiSend('PATCH', '/pubsub/topic', body)
}

/** Deletes a topic, its subscriptions too when `subscriptions: 'delete'`. */
export function deleteTopic(body: PubsubDeleteTopicBody): Promise<void> {
  return apiSend('DELETE', '/pubsub/topic', body)
}

// ------------------------------------------------------------ publishing

/** Publishes 1 to 1,000 messages at once, through the same path an app's publish takes. */
export function publish(body: Omit<PubsubPublishBody, 'dryRun'>): Promise<PubsubPublishResult> {
  return apiSend('POST', '/pubsub/topic/publish', { ...body, dryRun: false })
}

/** Message 1 as `publish` would send it (templates expanded by the engine); publishes nothing. */
export function previewPublish(
  body: Omit<PubsubPublishBody, 'dryRun'>,
  signal?: AbortSignal,
): Promise<PubsubPreview> {
  return apiSend(
    'POST',
    '/pubsub/topic/publish',
    { ...body, dryRun: true },
    signal ? { signal } : {},
  )
}

/** A `pubsub.publish` job: many messages, again, repeated or on an interval. Answers the job at once. */
export function startPublishJob(body: PubsubPublishJobBody): Promise<Job> {
  return apiSend('POST', '/pubsub/messages:publish', body)
}

// ------------------------------------------------------------ messages

/** What a topic's message list is filtered by: the shared grammar and a Pub/Sub filter expression. */
export interface MessageScope {
  topic: string
  q?: string | undefined
  expr?: string | undefined
}

/** One page of a topic's history, newest first. */
export function getMessages(
  scope: MessageScope,
  page: PageAt = {},
  signal?: AbortSignal,
): Promise<Page<PubsubMessageRow>> {
  return apiGet(
    '/pubsub/messages',
    { topic: scope.topic, q: scope.q, expr: scope.expr, ...page },
    signal,
  )
}

/** Loaded message rows read again by id (their delivery marks moved). `q` travels in the body. */
export function batchGetMessages(
  scope: Pick<MessageScope, 'topic' | 'expr'>,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<BatchGetResponse<PubsubMessageRow>> {
  return apiSend(
    'POST',
    withQuery('/pubsub/messages:batchGet', { topic: scope.topic, expr: scope.expr }),
    request,
    signal ? { signal } : {},
  )
}

/**
 * The address of a streamed export of the messages `scope` matches (or of
 * `ids` alone), for a link the browser downloads: never assembled here.
 */
export function messagesExportUrl(
  scope: MessageScope & { format?: 'ndjson' | 'json'; ids?: readonly string[] },
): string {
  return `${API_BASE}${withQuery('/pubsub/messages:export', {
    topic: scope.topic,
    q: scope.q,
    expr: scope.expr,
    format: scope.format,
    ids: scope.ids?.join(','),
  })}`
}

/** A message with its data, attributes and what became of it at each subscription and function. */
export function getMessage(
  topic: string,
  id: string,
  signal?: AbortSignal,
): Promise<PubsubMessageDetail> {
  return apiGet('/pubsub/message', { topic, id }, signal)
}

/** Acknowledges a message at one subscription, whoever holds it (console only). */
export function ackMessage(body: PubsubMessageActionBody): Promise<void> {
  return apiSend('POST', '/pubsub/message/ack', body)
}

/** Ends a message's lease now, as its own expiry would (console only). */
export function releaseMessage(body: PubsubMessageActionBody): Promise<void> {
  return apiSend('POST', '/pubsub/message/release', body)
}

/** Delivers a message to one function again, with a fresh event id. */
export function redeliver(body: PubsubRedeliverBody): Promise<PubsubRedelivery> {
  return apiSend('POST', '/pubsub/message/redeliver', body)
}

/**
 * The request a function received for a message (compute's record), or
 * rebuilt when that is gone. `eventId` picks one delivery of the function
 * (a run again has its own); without it, the newest whose request is kept.
 */
export function getDispatch(
  topic: string,
  id: string,
  functionId: string,
  eventId?: string,
  signal?: AbortSignal,
): Promise<PubsubDispatchBody> {
  return apiGet('/pubsub/dispatch', { topic, id, function: functionId, event: eventId }, signal)
}

/** Requests the Pub/Sub port refused (publish to a missing topic, a schema refusal), coalesced. */
export function getRejected(project: string, signal?: AbortSignal): Promise<PubsubRejectedList> {
  return apiGet('/pubsub/rejected', { project }, signal)
}

// ------------------------------------------------------------ subscriptions

export function getSubscription(
  name: string,
  signal?: AbortSignal,
): Promise<PubsubSubscriptionDetail> {
  return apiGet('/pubsub/subscription', { name }, signal)
}

export function createSubscription(
  body: PubsubCreateSubscriptionBody,
): Promise<PubsubSubscriptionSummary> {
  return apiSend('POST', '/pubsub/subscriptions', body)
}

/** Changes what `mask` names (`ackDeadline`, `push`, `retainAcked`, `retention`, `deadLetter`, `retry`, `exactlyOnce`). */
export function updateSubscription(
  body: PubsubUpdateSubscriptionBody,
): Promise<PubsubSubscriptionSummary> {
  return apiSend('PATCH', '/pubsub/subscription', body)
}

export function deleteSubscription(body: PubsubNameBody): Promise<void> {
  return apiSend('DELETE', '/pubsub/subscription', body)
}

/** Switches a subscription to push (an endpoint) or back to pull (none). */
export function setPushConfig(body: PubsubPushConfigBody): Promise<void> {
  return apiSend('POST', '/pubsub/subscription/push-config', body)
}

/** Acknowledges every message waiting at a subscription now (a seek to now). */
export function purgeSubscription(body: PubsubNameBody): Promise<PubsubPurged> {
  return apiSend('POST', '/pubsub/subscription/purge', body)
}

// ------------------------------------------------------------ backlogs

/** What a backlog page reads: one subscription, narrowed to one state or not. */
export interface BacklogScope {
  subscription: string
  state?: PubsubBacklogState | undefined
}

/** One page of a backlog in delivery order, read without leasing anything. */
export function getBacklog(
  scope: BacklogScope,
  page: PageAt = {},
  signal?: AbortSignal,
): Promise<Page<PubsubBacklogRow>> {
  return apiGet(
    '/pubsub/backlog',
    { subscription: scope.subscription, state: scope.state, ...page },
    signal,
  )
}

/** Loaded backlog rows read again by their position keys. */
export function batchGetBacklog(
  scope: BacklogScope,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<BatchGetResponse<PubsubBacklogRow>> {
  return apiSend(
    'POST',
    withQuery('/pubsub/backlog:batchGet', { subscription: scope.subscription, state: scope.state }),
    request,
    signal ? { signal } : {},
  )
}

/** A `pubsub.ack` job over backlog rows (keys, or every row a query matches). */
export function startBacklogAck(body: PubsubBacklogJobBody): Promise<Job> {
  return apiSend('POST', '/pubsub/backlog:ack', body)
}

/** A `pubsub.release` job: the leases end now, as their expiry would. */
export function startBacklogRelease(body: PubsubBacklogJobBody): Promise<Job> {
  return apiSend('POST', '/pubsub/backlog:release', body)
}

// ------------------------------------------------------------ schemas

/** Every schema of `project`, one page. */
export function getSchemas(
  project: string,
  signal?: AbortSignal,
): Promise<Page<PubsubSchemaSummary>> {
  return apiGet('/pubsub/schemas', { project }, signal)
}

/** A schema with every revision (oldest first) and the topics bound to it. */
export function getSchema(name: string, signal?: AbortSignal): Promise<PubsubSchemaDetail> {
  return apiGet('/pubsub/schema', { name }, signal)
}

export function createSchema(body: PubsubCreateSchemaBody): Promise<PubsubSchemaDetail> {
  return apiSend('POST', '/pubsub/schemas', body)
}

/** Commits a new revision. */
export function commitSchema(body: PubsubCommitSchemaBody): Promise<PubsubSchemaDetail> {
  return apiSend('POST', '/pubsub/schema/commit', body)
}

export function deleteSchema(body: PubsubNameBody): Promise<void> {
  return apiSend('DELETE', '/pubsub/schema', body)
}

/** Whether a definition parses, with the parser's reason and position when it does not. */
export function checkSchema(
  body: PubsubSchemaCheckBody,
  signal?: AbortSignal,
): Promise<PubsubSchemaCheck> {
  return apiSend('POST', '/pubsub/schema/check', body, signal ? { signal } : {})
}

/** Whether a message passes a schema revision (`name@revision`), with the failing path when not. */
export function checkMessage(
  body: PubsubMessageCheckBody,
  signal?: AbortSignal,
): Promise<PubsubMessageCheck> {
  return apiSend('POST', '/pubsub/schema/validate-message', body, signal ? { signal } : {})
}

/** An example message the engine builds for a topic's bound revision or a definition, checked before it is answered. */
export function schemaExample(
  body: PubsubSchemaExampleBody,
  signal?: AbortSignal,
): Promise<PubsubSchemaExample> {
  return apiSend('POST', '/pubsub/schema/example', body, signal ? { signal } : {})
}

// ------------------------------------------------------------ filters

/** Whether a subscription filter parses (with the position when not) and what it passes of a topic's history. */
export function checkFilter(
  body: PubsubFilterCheckBody,
  signal?: AbortSignal,
): Promise<PubsubFilterCheck> {
  return apiSend('POST', '/pubsub/filter/check', body, signal ? { signal } : {})
}

// ------------------------------------------------------------ setup

/** The project's topics, subscriptions and schemas (every revision), never messages. */
export function getSetup(project: string, signal?: AbortSignal): Promise<PubsubSetup> {
  return apiGet('/pubsub/setup', { project }, signal)
}

/** Creates what a setup file holds in dependency order, skipping what exists. */
export function importSetup(setup: PubsubSetup): Promise<PubsubSetupResult> {
  return apiSend('POST', '/pubsub/setup/import', setup)
}
