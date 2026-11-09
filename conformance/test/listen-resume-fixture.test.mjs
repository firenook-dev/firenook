import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the resume capture pins that the official emulator starts a target over', async () => {
  const root = new URL('../fixtures/listen-resume-v1/', import.meta.url);
  const bytes = await readFile(new URL('fixture.json', root));
  const sha = (await readFile(new URL('SHA256SUMS', root), 'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.passed, true);
  assert.equal(fixture.oracle.firestore, '1.22.0');
  assert.ok(fixture.issuedToken.length > 0);

  const documents = Array(3).fill('documentChange');
  assert.deepEqual(fixture.answers['no-token'].frames, ['ADD', ...documents, 'CURRENT', 'NO_CHANGE']);
  for (const id of [
    'empty-token', 'malformed-token', 'text-token', 'token-from-the-other-emulator', 'own-token',
    'read-time-a-day-ago', 'read-time-a-day-ahead', 'read-time-with-nanoseconds', 'read-time-zero',
  ]) {
    assert.deepEqual(fixture.answers[id].frames, ['ADD', 'RESET', ...documents, 'CURRENT', 'NO_CHANGE'], id);
    assert.deepEqual(fixture.answers[id].documents, ['a', 'b', 'c'], id);
    assert.equal(fixture.answers[id].ending, 'current', id);
  }
  assert.deepEqual(fixture.answers['own-token-after-a-restart'].frames, ['ADD', 'RESET', 'CURRENT', 'NO_CHANGE']);
  assert.deepEqual(fixture.answers['own-token-after-a-restart-and-a-write'].documents, ['after']);
});
