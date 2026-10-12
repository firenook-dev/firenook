// Cloud Tasks' registry entry. The messaging stream fills in its pages,
// badges, actions, routes and search labels when it builds the section;
// until its journeys pass it stays `built: false` and shows the placeholder.

import { QueueIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const tasks: ConsoleSection = {
  id: 'tasks',
  to: '/tasks',
  label: 'Cloud Tasks',
  services: ['tasks'],
  area: 'messaging',
  icon: QueueIcon,
  built: false,
  projectScope: true,
  summary:
    'Queues with stats, pending and running tasks with their retry attempt and next dispatch, and enqueue a task by hand.',
}
