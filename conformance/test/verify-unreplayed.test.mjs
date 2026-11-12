import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const VERIFY = fileURLToPath(new URL('../src/report/verify.mjs', import.meta.url));

// Three recorded cases; a replay noted only `a`.
function scene(listed) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-unreplayed-'));
  writeFileSync(join(dir, 'cases.json'), JSON.stringify({
    schemaVersion: 1,
    sets: [{ id: 'set' }],
    cases: ['a', 'b', 'c'].map((id) => ({ set: 'set', id })),
  }));
  mkdirSync(join(dir, 'ledger'));
  writeFileSync(join(dir, 'ledger', 'rust.jsonl'), `${JSON.stringify({ set: 'set', case: 'a', result: 'checked', compared: 'answer' })}\n`);
  const args = [VERIFY, join(dir, 'cases.json'), join(dir, 'ledger'), join(dir, 'verify.json')];
  if (listed) {
    writeFileSync(join(dir, 'unreplayed.json'), JSON.stringify({ schemaVersion: 1, cases: listed }));
    args.push('--expect-unreplayed', join(dir, 'unreplayed.json'));
  }
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { ...run, written: existsSync(join(dir, 'verify.json')) };
}
const known = (id, issue = 7) => ({ set: 'set', case: id, issue, why: 'waits for the fix' });

test('without the list, unreplayed cases are only counted', () => {
  const run = scene();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.written);
});

test('every unreplayed case listed with its issue passes', () => {
  const run = scene([known('b'), known('c')]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Every recorded case is replayed but the 2 that/);
});

test('a recorded case that is neither replayed nor listed fails, after the output is written', () => {
  const run = scene([known('b')]);
  assert.equal(run.status, 1);
  assert.ok(run.written);
  assert.match(run.stderr, /no replay compares them \(1\)/);
  assert.match(run.stderr, /^ {2}set c$/m);
});

test('a listed case that a replay now notes fails, so the fix takes it off the list', () => {
  const run = scene([known('a', 12), known('b'), known('c')]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /set a \(#12\): now checked/);
});

test('an entry without an issue, an unknown case or a repeated one is refused before anything is written', () => {
  for (const listed of [
    [{ set: 'set', case: 'b', why: 'no issue' }, known('c')],
    [known('b'), known('c'), known('z')],
    [known('b'), known('b'), known('c')],
  ]) {
    const run = scene(listed);
    assert.equal(run.status, 1);
    assert.equal(run.written, false);
    assert.match(run.stderr, /Errors \(1\)/);
  }
});
