// The conformance ledger for the Node replays: which recorded answers a
// replay compared with Firenook's own, and how much of each. The Rust tests
// write the same lines through `crates/conformance-ledger`.
//
// With FIRENOOK_CONFORMANCE_LEDGER naming a directory, each call appends one
// JSON line `{"set","case","result","compared","reason"?}` to
// `<directory>/node-<pid>.jsonl`; unset, the calls do nothing. `set` and
// `case` are the ids `cases.mjs` lists; `verify.mjs` joins the two. A replay
// notes a case only after its comparison passed. Node 24, no dependencies.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** What a replay compared of one recorded answer. */
export const COMPARED = Object.freeze({
  /** The status or code and the body as recorded, modulo the replay's documented normalisations (times, ids, tokens). */
  answer: 'answer',
  /** The status or code and the error message, for an answer that is an error; no success body. */
  error: 'error',
  /** The HTTP status or gRPC code only. */
  status: 'status',
  /** A rules allow/deny or a compile pass/fail only. */
  verdict: 'verdict',
  /** An observed effect: events delivered, a document or file written. */
  behaviour: 'behaviour',
});
const VALUES = new Set(Object.values(COMPARED));

const directory = process.env.FIRENOOK_CONFORMANCE_LEDGER || undefined;
let created = false;

/** True when the ledger is being written. */
export const enabled = directory !== undefined;

function note(set, id, result, compared, reason) {
  if (!directory) return;
  if (typeof set !== 'string' || typeof id !== 'string' || !set || !id) throw new Error(`ledger: bad case ${set} ${id}`);
  if (!VALUES.has(compared)) throw new Error(`ledger: ${set} ${id}: unknown compared value ${compared}`);
  if (result === 'differs' && !(typeof reason === 'string' && reason.trim())) throw new Error(`ledger: ${set} ${id}: differs needs a reason`);
  if (!created) {
    mkdirSync(directory, { recursive: true });
    created = true;
  }
  const line = { set, case: id, result, compared, ...(result === 'differs' ? { reason } : {}) };
  appendFileSync(join(directory, `node-${process.pid}.jsonl`), `${JSON.stringify(line)}\n`, 'utf8');
}

/** A replay compared this case, as far as `compared` says, and it matched. */
export function checked(set, id, compared) {
  note(set, id, 'checked', compared);
}

/** A replay checked this case, as far as `compared` says, and asserts Firenook deliberately answers otherwise. */
export function differs(set, id, compared, reason) {
  note(set, id, 'differs', compared, reason);
}
