import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CREATES, EXPRESSIONS, LISTS } from '../src/suite/rules-document-paths-observe.mjs';

test('the capture pins what the official rules runtime makes of paths and names', async () => {
  const root = new URL('../fixtures/rules-document-paths-v1/', import.meta.url);
  const bytes = await readFile(new URL('fixture.json', root));
  const sha = (await readFile(new URL('SHA256SUMS', root), 'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.passed, true);
  assert.equal(fixture.oracle.firestore, '1.22.0');
  assert.deepEqual(Object.keys(fixture.answers).sort(), Object.keys({ ...EXPRESSIONS, ...LISTS, ...CREATES }).sort());
  const status = (id) => fixture.answers[id].status;
  assert.equal(status('is-a-path'), 200);
  assert.equal(status('equals-a-literal-without-its-slash'), 200);
  assert.equal(status('not-equal-to-a-string'), 403);
  assert.equal(status('string-of-it-keeps-the-slash'), 200);
  assert.equal(status('exists-with-it'), 200);
  assert.equal(status('exists-with-a-string-is-an-error'), 403);
  for (const id of ['the-id', 'the-name-against-a-literal', 'the-name-against-a-literal-reversed', 'the-name-against-the-request-path', 'the-name-by-index', 'create-the-id', 'create-the-name', 'interpolated-slash-one-segment', 'interpolating-a-path', 'bind-through-path', 'a-percent-escape-is-read-in-a-literal']) {
    assert.equal(status(id), 200, id);
  }
  assert.equal(status('the-name-with-a-project'), 403);
  assert.equal(status('a-slash-escape-equals-two-segments'), 403);
  assert.equal(status('interpolated-slash-equals'), 403);
  assert.equal(status('list-the-id'), 403);
  assert.deepEqual(fixture.answers['a-bad-escape-in-a-literal'], { rulesRefused: 400 });
  assert.deepEqual(fixture.answers['interpolating-inside-a-segment'], { rulesRefused: 400 });
  for (const id of ['an-integer-is-an-error', 'a-null-is-an-error', 'no-argument-is-an-error', 'two-arguments-is-an-error', 'empty-text', 'a-doubled-slash', 'a-trailing-slash-alone', 'the-root-alone', 'two-leading-slashes']) {
    assert.equal(status(id), 403, id);
  }
});
