#!/usr/bin/env node
// Joins the case list `cases.mjs` writes with the conformance ledger the
// replays write, so each recorded answer says whether a replay compared it.
//
//   node conformance/src/report/verify.mjs <cases.json> <ledger-dir> <output.json>
//
// The replays write the ledger when FIRENOOK_CONFORMANCE_LEDGER names a
// directory (every `.jsonl` file under <ledger-dir> is read, subdirectories
// included): the Rust tests through `crates/conformance-ledger`, the Node
// replays through `ledger.mjs`. Each line is `{"set","case","result":
// "checked"|"differs","compared","reason"?}`, where `compared` says what the
// replay compared: "answer" (status or code and body as recorded, modulo the
// replay's documented normalisations), "error" (status or code and the error
// message), "status" (the status or code only), "verdict" (a rules allow/deny
// or a compile pass/fail) or "behaviour" (an observed effect).
//
// A case noted more than once is fine: it takes the most complete comparison
// any replay made, in the order answer, error, behaviour, status, verdict.
// A line naming a case `cases.mjs` does not list, a malformed line, or one
// case noted both `checked` and `differs` is an error: it is printed, the
// output is not written and the exit code is 1.
//
// The output is `{schemaVersion: 1, sets: [{id, answers, checked, differs,
// unreplayed, compared: {answer, error, status, verdict, behaviour}}], cases:
// [{set, id, result, compared?, reason?}]}`, in the case list's order. Node 24,
// no dependencies.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const RESULTS = new Set(['checked', 'differs']);
/** Most complete first. */
const COMPARED = ['answer', 'error', 'behaviour', 'status', 'verdict'];

function main() {
  const [casesPath, ledgerDir, outputPath] = process.argv.slice(2);
  if (!casesPath || !ledgerDir || !outputPath) {
    console.error('usage: node conformance/src/report/verify.mjs <cases.json> <ledger-dir> <output.json>');
    process.exit(2);
  }
  const list = JSON.parse(readFileSync(casesPath, 'utf8'));
  const key = (set, id) => `${set}\u0000${id}`;
  const known = new Set(list.cases.map((entry) => key(entry.set, entry.id)));
  const knownSets = new Set(list.sets.map((set) => set.id));

  const errors = [];
  const notes = new Map();
  // Every `.jsonl` under the directory: CI gathers one subdirectory per job.
  const files = readdirSync(ledgerDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  let lines = 0;
  for (const file of files) {
    const text = readFileSync(join(ledgerDir, file), 'utf8');
    text.split('\n').forEach((raw, index) => {
      if (!raw.trim()) return;
      lines += 1;
      const where = `${file}:${index + 1}`;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        errors.push(`${where}: not JSON: ${raw.slice(0, 160)}`);
        return;
      }
      const { set, case: id, result, compared, reason } = line ?? {};
      if (typeof set !== 'string' || typeof id !== 'string' || !RESULTS.has(result)) {
        errors.push(`${where}: malformed line: ${raw.slice(0, 160)}`);
        return;
      }
      if (!COMPARED.includes(compared)) {
        errors.push(`${where}: ${set} ${id}: compared must be one of ${COMPARED.join(', ')}, not ${JSON.stringify(compared)}`);
        return;
      }
      if (result === 'differs' && (typeof reason !== 'string' || !reason.trim())) {
        errors.push(`${where}: ${set} ${id}: differs without a reason`);
        return;
      }
      if (!known.has(key(set, id))) {
        errors.push(`${where}: ${knownSets.has(set) ? `set ${set} has no case ${id}` : `no set ${set} (case ${id})`}`);
        return;
      }
      const note = notes.get(key(set, id)) ?? { results: new Set(), reasons: new Set(), compared: new Set() };
      note.results.add(result);
      note.compared.add(compared);
      if (result === 'differs') note.reasons.add(reason.trim());
      notes.set(key(set, id), note);
    });
  }
  for (const [name, note] of notes) {
    if (note.results.size > 1) {
      const [set, id] = name.split('\u0000');
      errors.push(`${set} ${id}: noted both checked and differs`);
    }
  }

  const cases = list.cases.map((entry) => {
    const note = notes.get(key(entry.set, entry.id));
    if (!note) return { set: entry.set, id: entry.id, result: 'unreplayed' };
    const compared = COMPARED.find((value) => note.compared.has(value));
    if (note.results.has('differs')) {
      return { set: entry.set, id: entry.id, result: 'differs', compared, reason: [...note.reasons].join('; ') };
    }
    return { set: entry.set, id: entry.id, result: 'checked', compared };
  });
  const sets = list.sets.map((set) => {
    const own = cases.filter((entry) => entry.set === set.id);
    const count = (result) => own.filter((entry) => entry.result === result).length;
    const compared = Object.fromEntries(COMPARED.map((value) => [value, own.filter((entry) => entry.compared === value).length]));
    return { id: set.id, answers: own.length, checked: count('checked'), differs: count('differs'), unreplayed: count('unreplayed'), compared };
  });

  const width = Math.max(4, ...sets.map((set) => set.id.length));
  const columns = ['answers', 'checked', 'differs', 'unreplayed', ...COMPARED];
  const row = (id, values) => `${id.padEnd(width)}${values.map((value, index) => String(value).padStart(Math.max(7, columns[index].length) + 2)).join('')}`;
  console.log(row('set', columns));
  const cells = (set) => [set.answers, set.checked, set.differs, set.unreplayed, ...COMPARED.map((value) => set.compared[value])];
  for (const set of sets) console.log(row(set.id, cells(set)));
  const totals = cells({
    answers: 0, checked: 0, differs: 0, unreplayed: 0, compared: Object.fromEntries(COMPARED.map((value) => [value, 0])),
  }).map((_, index) => sets.reduce((sum, set) => sum + cells(set)[index], 0));
  console.log(row('total', totals));
  console.log(`Ledger: ${files.length} files, ${lines} lines, ${notes.size} distinct cases`);

  if (errors.length) {
    console.error(`Errors (${errors.length}):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, sets, cases }, null, 2)}\n`);
  console.log(`Wrote ${target}`);
}

main();
