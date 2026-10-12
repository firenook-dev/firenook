// Which functions an account change runs: compute's matcher
// (`useTriggersFor('auth', tenant)`, the one the Functions runtime uses)
// narrowed to the event a dialog is about — `user.create` for a new user,
// `user.delete` for a delete. While the matcher does not know (Functions
// starting, the Functions section not built), the answer stays `'unknown'`
// and the dialog says nothing rather than guessing.

import { type TriggersAnswer, useTriggersFor } from '@/lib/triggers'

export type AccountEvent = 'user.create' | 'user.delete'

/** The functions of an answer that listen to `event` (v1 `providers/firebase.auth/eventTypes/user.create` included). */
export function narrowTriggers(answer: TriggersAnswer, event: AccountEvent): TriggersAnswer {
  if (answer === 'unknown' || answer === 'absent') return answer
  return {
    backgroundEnabled: answer.backgroundEnabled,
    functions: answer.functions.filter(
      (fn) =>
        fn.eventType === event ||
        fn.eventType.endsWith(`/${event}`) ||
        fn.eventType.endsWith(`.${event}`),
    ),
  }
}

/** The functions `event` runs for users of this tenant (`undefined`: the project's users). */
export function useAccountTriggers(
  tenant: string | undefined,
  event: AccountEvent,
): TriggersAnswer {
  return narrowTriggers(useTriggersFor('auth', tenant ?? ''), event)
}

/** "onUserCreated runs once.", "No function listens to user.create.", or nothing while unknown. */
export function triggerSentence(answer: TriggersAnswer, event: AccountEvent): string | undefined {
  if (answer === 'unknown' || answer === 'absent') return undefined
  if (answer.functions.length === 0) return `No function listens to ${event}.`
  const names = answer.functions.map((fn) => fn.functionId.replace(/^[a-z]+-[a-z]+\d+-/, ''))
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  // Whether background triggers are paused is the shell banner's to say.
  return `${list} ${names.length === 1 ? 'runs' : 'run'} once.`
}
