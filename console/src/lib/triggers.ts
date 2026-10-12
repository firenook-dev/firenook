// Which functions fire for a resource: the Firestore path a delete would
// remove, a Storage object, an Auth tenant, a Pub/Sub topic, an Eventarc
// type on a channel, a task queue. Every destructive confirmation and every
// trigger chip asks here, one way (foundation spec §7.14).
//
// This is the foundation's stub. The compute stream implements it against
// `GET /functions/triggers?service=&resource=&event=` in its own commit,
// without changing the signature. Until then the answer is `'unknown'`,
// and callers draw no trigger line for it: "No function listens" is said
// only when the engine knows it, never because nobody asked.

/** One function that would run, as the engine names it. */
export type TriggerFunction = {
  functionId: string
  codebase: string
  eventType: string
  kind: string
}

/** A service whose changes can fire a function. */
export type TriggerService = 'firestore' | 'auth' | 'storage' | 'pubsub' | 'eventarc' | 'tasks'

/**
 * The functions that would fire, with whether background triggers are
 * delivered at all; `'unknown'` while the answer is not known (compute not
 * built, the functions registry not built yet, Functions starting);
 * `'absent'` when Functions are not part of the suite.
 */
export type TriggersAnswer =
  | { functions: readonly TriggerFunction[]; backgroundEnabled: boolean }
  | 'unknown'
  | 'absent'

/**
 * Which functions fire for this resource (§7.14 formats: a Firestore
 * document path, `<bucket>|<name>` for Storage, the tenant id or `''` for
 * Auth, the topic, `<channel>|<type>` for Eventarc, the queue).
 */
export function useTriggersFor(
  _service: TriggerService,
  _resource: string | undefined,
  _event?: string,
): TriggersAnswer {
  return 'unknown'
}
