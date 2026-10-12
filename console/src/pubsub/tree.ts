// The topics panel's tree, built from the topics index: every topic of the
// project with its subscriptions and the functions that consume it nested
// underneath, then the groups — the schedules' synthetic topics, the other
// projects the app wrote to, and subscriptions whose topic was deleted.
//
// Each figure is counted once on screen. A topic shows its most-behind
// subscription's backlog (never a sum, which would count one message once
// per subscription); a subscription its backlog; the row that is the page's
// scope shows nothing, because row two counts it. The functions' own
// `emulator-sub-*` subscriptions are drained at every publish and always
// empty, so they collapse into their function's row; one whose topic lost
// its functions is orphaned and listed as the ordinary subscription it now
// is.

import {
  BroadcastIcon,
  ClockIcon,
  LightningIcon,
  LinkBreakIcon,
  PaperPlaneTiltIcon,
  TrayArrowDownIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import type { PanelTreeNode } from '@/components/console/panel-tree'
import { formatNumber } from '@/lib/format'
import { isStalled, waitedText } from './states'
import { GROUP } from './tree-store'

/** What a row of the tree opens. */
export type TreeTarget =
  | { kind: 'topic'; topic: string }
  | { kind: 'subscription'; subscription: string; topic: string | null }
  | { kind: 'project'; project: string }

export interface TopicTree {
  nodes: PanelTreeNode[]
  /** By node id. Group rows open nothing (their caret toggles them). */
  targets: Map<string, TreeTarget>
}

/** The note an orphaned functions subscription carries (PS-08). */
export function orphanedNote(topicId: string): string {
  return `No function listens on ${topicId} any more, so nothing drains this subscription; it keeps every later message, as the official emulator does.`
}

/** The subscriptions a person reads: not the functions' own, which are always empty. */
export function visibleSubscriptions(
  topic: Pick<PubsubTopicSummary, 'subscriptions'>,
): PubsubSubscriptionSummary[] {
  return topic.subscriptions.filter((subscription) => subscription.managed !== 'functions')
}

/** The most-behind subscription a person reads, or undefined when none has a backlog to show. */
export function mostBehind(
  topic: Pick<PubsubTopicSummary, 'subscriptions'>,
): PubsubSubscriptionSummary | undefined {
  let worst: PubsubSubscriptionSummary | undefined
  for (const subscription of visibleSubscriptions(topic))
    if (!worst || subscription.counters.backlog > worst.counters.backlog) worst = subscription
  return worst
}

function subscriptionTitle(subscription: PubsubSubscriptionSummary, now: number): string {
  const { counters } = subscription
  if (isStalled(counters, now))
    return `No subscriber is connected and the oldest message has waited ${waitedText(counters.oldestUnackedAt, now)}.`
  const parts = [
    counters.backlog === 0 ? 'Nothing waiting' : `${formatNumber(counters.backlog)} waiting`,
  ]
  if (counters.outstanding > 0) parts.push(`${formatNumber(counters.outstanding)} leased`)
  const connected = counters.consumers.streaming + counters.consumers.waitingPulls
  if (connected > 0) parts.push(connected === 1 ? '1 subscriber' : `${connected} subscribers`)
  if (subscription.delivery === 'push') parts.push('push')
  return parts.join(' · ')
}

function subscriptionNode(
  subscription: PubsubSubscriptionSummary,
  current: string | undefined,
  now: number,
  topicId: string,
): PanelTreeNode {
  const isCurrent = subscription.name === current
  const orphaned = subscription.managed === 'orphaned'
  return {
    id: subscription.name,
    label: subscription.id,
    icon: subscription.delivery === 'push' ? PaperPlaneTiltIcon : TrayArrowDownIcon,
    count: isCurrent ? undefined : subscription.counters.backlog,
    tone: !isCurrent && isStalled(subscription.counters, now) ? 'warning' : undefined,
    title: orphaned ? orphanedNote(topicId) : subscriptionTitle(subscription, now),
  }
}

function topicNode(
  topic: PubsubTopicSummary,
  current: string | undefined,
  now: number,
  targets: Map<string, TreeTarget>,
): PanelTreeNode {
  targets.set(topic.name, { kind: 'topic', topic: topic.name })
  const children: PanelTreeNode[] = []
  for (const subscription of visibleSubscriptions(topic)) {
    targets.set(subscription.name, {
      kind: 'subscription',
      subscription: subscription.name,
      topic: topic.name,
    })
    children.push(subscriptionNode(subscription, current, now, topic.id))
  }
  for (const target of topic.functions) {
    // A function's row opens the subscription the emulator drains for it,
    // whose page explains it and leads to the deliveries.
    const own = topic.subscriptions.find((subscription) => subscription.managed === 'functions')
    targets.set(
      target.functionId,
      own
        ? { kind: 'subscription', subscription: own.name, topic: topic.name }
        : { kind: 'topic', topic: topic.name },
    )
    children.push({
      id: target.functionId,
      label: target.name,
      icon: LightningIcon,
      title:
        target.kind === 'schedule'
          ? `${target.name} runs for every tick of its schedule (${target.region}).`
          : `${target.name} runs for every message published to ${topic.id} (${target.region}).`,
    })
  }
  const worst = mostBehind(topic)
  const isCurrent = topic.name === current
  return {
    id: topic.name,
    label: topic.id,
    icon: topic.kind === 'schedule' ? ClockIcon : BroadcastIcon,
    count: isCurrent || !worst ? undefined : worst.counters.backlog,
    tone: !isCurrent && worst && isStalled(worst.counters, now) ? 'warning' : undefined,
    title: worst
      ? `Most behind: ${worst.id}, ${formatNumber(worst.counters.backlog)} waiting · ${formatNumber(topic.counters.published)} published since start`
      : topic.functions.length > 0
        ? `${formatNumber(topic.counters.published)} published since start; delivered to functions only`
        : `No subscriptions · ${formatNumber(topic.counters.published)} published since start`,
    children,
  }
}

/** The tree for `index`, with the page's scope (a topic or subscription full name) as `current`. */
export function topicTree(
  index: PubsubTopicIndex | undefined,
  options: { current?: string | undefined; configured?: string | undefined; now: number },
): TopicTree {
  const targets = new Map<string, TreeTarget>()
  const nodes: PanelTreeNode[] = []
  if (!index) return { nodes, targets }
  const { current, now } = options
  const schedules: PanelTreeNode[] = []
  for (const topic of index.items) {
    const node = topicNode(topic, current, now, targets)
    if (topic.kind === 'schedule') schedules.push(node)
    else nodes.push(node)
  }
  if (schedules.length > 0)
    nodes.push({
      id: GROUP.schedules,
      label: 'Function schedules',
      icon: ClockIcon,
      title: 'One topic per scheduled function: each tick of its schedule is a publish here.',
      children: schedules,
    })
  const others = index.otherProjects.filter((other) => other.project !== index.project)
  if (others.length > 0)
    nodes.push({
      id: GROUP.other,
      label: 'Other projects',
      icon: WarningIcon,
      title: `Topics under project ids other than ${index.project}. Open one to see its topics.`,
      children: others.map((other) => {
        const id = `project:${other.project}`
        targets.set(id, { kind: 'project', project: other.project })
        const isConfigured = other.project === options.configured
        return {
          id,
          label: other.project === '' ? '(empty project id)' : other.project,
          icon: BroadcastIcon,
          count: other.topics,
          title: `${formatNumber(other.topics)} ${other.topics === 1 ? 'topic' : 'topics'}, ${formatNumber(other.subscriptions)} ${other.subscriptions === 1 ? 'subscription' : 'subscriptions'} under ${other.project === '' ? 'an empty project id' : other.project}${isConfigured ? ', the emulator’s own project' : ''}.`,
        }
      }),
    })
  if (index.detached.length > 0)
    nodes.push({
      id: GROUP.detached,
      label: 'Topic deleted',
      icon: LinkBreakIcon,
      title:
        'Subscriptions whose topic was deleted. They keep their backlog and can still be read and pulled.',
      children: index.detached.map((subscription) => {
        targets.set(subscription.name, {
          kind: 'subscription',
          subscription: subscription.name,
          topic: null,
        })
        return {
          ...subscriptionNode(subscription, current, now, '_deleted-topic_'),
          icon: LinkBreakIcon,
        }
      }),
    })
  return { nodes, targets }
}

/** The ids to open so that `current` shows: its topic, and the group holding it. */
export function pathToCurrent(
  index: PubsubTopicIndex | undefined,
  current: string | undefined,
): string[] {
  if (!index || !current) return []
  for (const topic of index.items) {
    const holds =
      topic.name === current ||
      topic.subscriptions.some((subscription) => subscription.name === current)
    if (!holds) continue
    const path: string[] = topic.kind === 'schedule' ? [GROUP.schedules] : []
    if (topic.name !== current) path.push(topic.name)
    return path
  }
  if (index.detached.some((subscription) => subscription.name === current)) return [GROUP.detached]
  return []
}
