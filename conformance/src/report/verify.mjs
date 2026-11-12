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
// [{set, id, result, compared?, reason?}]}`, in the case list's order.
//
// With `--expect-unreplayed <file>` every recorded case must be noted by a
// replay unless the file lists it, with the issue that tracks it: a known bug
// whose replay waits for the fix. A case no replay noted that the file does
// not list, or a listed case that a replay now notes, fails the run after the
// output is written, so a new recording lands with its replay and a fix takes
// its case off the list. The file is `{schemaVersion: 1, cases: [{set, case,
// issue, why}]}`. Node 24, no dependencies.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const RESULTS = new Set(['checked', 'differs']);
/** Most complete first. */
const COMPARED = ['answer', 'error', 'behaviour', 'status', 'verdict'];

const USAGE = 'usage: node conformance/src/report/verify.mjs <cases.json> <ledger-dir> <output.json> [--expect-unreplayed <file>]';

/** The listed cases, by key; a malformed, duplicate or unknown entry is an error. */
function readExpected(path, known, key, errors) {
  const listed = new Map();
  let file;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return listed;
  }
  if (file?.schemaVersion !== 1 || !Array.isArray(file.cases)) {
    errors.push(`${path}: expected {schemaVersion: 1, cases: [...]}`);
    return listed;
  }
  file.cases.forEach((entry, index) => {
    const { set, case: id, issue, why } = entry ?? {};
    const where = `${path} cases[${index}]`;
    if (typeof set !== 'string' || typeof id !== 'string' || !Number.isInteger(issue) || issue < 1 || typeof why !== 'string' || !why.trim()) {
      errors.push(`${where}: needs set, case, issue (a number) and why`);
      return;
    }
    if (!known.has(key(set, id))) errors.push(`${where}: ${set} has no case ${id}`);
    else if (listed.has(key(set, id))) errors.push(`${where}: ${set} ${id} is listed twice`);
    else listed.set(key(set, id), { issue, why });
  });
  return listed;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--expect-unreplayed');
  const expectedPath = flag === -1 ? undefined : argv[flag + 1];
  const [casesPath, ledgerDir, outputPath, ...extra] = argv.filter((_, index) => flag === -1 || (index !== flag && index !== flag + 1));
  if (!casesPath || !ledgerDir || !outputPath || extra.length || (flag !== -1 && !expectedPath)) {
    console.error(USAGE);
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
      return { set: entry.set, id: entry.id, result: 'differs', compared, reason: [...note.reasons][0] };
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

  const expected = expectedPath ? readExpected(expectedPath, known, key, errors) : undefined;
  if (errors.length) {
    console.error(`Errors (${errors.length}):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, sets, cases }, null, 2)}\n`);
  console.log(`Wrote ${target}`);

  if (!expected) return;
  const unlisted = [];
  const stale = [];
  for (const entry of cases) {
    const listed = expected.get(key(entry.set, entry.id));
    if (entry.result === 'unreplayed' && !listed) unlisted.push(`${entry.set} ${entry.id}`);
    if (entry.result !== 'unreplayed' && listed) stale.push(`${entry.set} ${entry.id} (#${listed.issue}): now ${entry.result}`);
  }
  if (!unlisted.length && !stale.length) {
    console.log(`Every recorded case is replayed but the ${expected.size} that ${expectedPath} lists, each with its issue.`);
    return;
  }
  if (unlisted.length) {
    console.error(`Recorded, but no replay compares them (${unlisted.length}): add a replay, or list a known bug with its issue in ${expectedPath}.`);
    for (const line of unlisted) console.error(`  ${line}`);
  }
  if (stale.length) {
    console.error(`Listed in ${expectedPath}, but a replay now notes them (${stale.length}): take them off the list.`);
    for (const line of stale) console.error(`  ${line}`);
  }
  process.exit(1);
}

main();
