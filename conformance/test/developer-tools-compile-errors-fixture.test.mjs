import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixtures = new URL('../fixtures/', import.meta.url);
const root = new URL('developer-tools-compile-errors-v1/', fixtures);
const bytes = await readFile(new URL('fixture.json', root));
const fixture = JSON.parse(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const reload = id => fixture.reloads.find(value => value.id === id);
const lines = value => value.response.error.message.split('\n').slice(1);

test('compile-error capture has pinned identity, inputs and checksums', async () => {
  assert.equal(await readFile(new URL('SHA256SUMS', root), 'utf8'), hash(bytes) + '  fixture.json\n');
  assert.equal(fixture.captureSha256, hash(await readFile(new URL('../src/developer-tools/capture-compile-errors.mjs', import.meta.url))));
  assert.equal(fixture.syntheticOnly, true);
  assert.match(fixture.project, /^demo-/);
  assert.equal(fixture.oracle.firestore, '1.21.0');
  assert.equal(fixture.oracle.firebaseTools, '15.22.0');
  assert.equal(fixture.oracle.node, '24.20.0');
  assert.equal(fixture.oracle.jarSha256, 'c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e');
  assert.deepEqual(fixture.request, { method: 'PUT', path: `/emulator/v1/projects/${fixture.project}:securityRules`, file: 'firestore.rules' });
  assert.equal(fixture.reloads.length, 120);
  assert.equal(new Set(fixture.reloads.map(value => value.id)).size, 120);
  assert.equal(new Set(fixture.reloads.map(value => value.source)).size, 120);
  assert.ok(!/Bearer |\/Users\/|\/home\/|\/var\/folders\//.test(bytes.toString()));
});

test('every refusal is one positioned line per problem under the official framing', () => {
  assert.deepEqual(reload('baseline').response, {});
  const refused = fixture.reloads.filter(value => value.status !== 200);
  assert.equal(refused.length, 113);
  for (const value of refused) {
    assert.equal(value.status, 400, value.id);
    assert.equal(value.response.error.code, 400, value.id);
    assert.equal(value.response.error.status, 'INVALID_ARGUMENT', value.id);
    assert.match(value.response.error.message, /^Error compiling rules:\n/, value.id);
    for (const line of lines(value)) assert.match(line, /^L\d+:\d+ \S/, value.id);
  }
  assert.deepEqual(lines(reload('top/empty')), ['L0:0 Rules content empty. Compilation aborted.']);
  assert.equal(fixture.reloads.filter(value => value.status === 200 && value.response.issues).length, 3);
});

test('the coverage capture and production Rules API agree with this capture on the inputs they share', async () => {
  const coverage = JSON.parse(await readFile(new URL('developer-tools-coverage-v1/fixture.json', fixtures)));
  assert.equal(reload('top/broken').source, coverage.invalidReload.body.rules.files[0].content);
  assert.deepEqual(reload('top/broken').response, coverage.invalidReload.response);
  const production = JSON.parse(await readFile(new URL('rules-v2/production-parse-errors.json', fixtures)));
  for (const id of ['unexpected-token', 'unclosed-block', 'duplicate-let', 'recursive-function', 'invalid-recursive-wildcard']) {
    const recorded = production.observations.find(value => value.id === id);
    const value = reload(`production/${id}`);
    assert.equal(value.source, recorded.source, id);
    // Production answers each issue with its severity; the emulator refuses
    // with every one of them, warnings included, in the same words.
    assert.deepEqual(lines(value), recorded.response.issues.map(issue => `L${issue.sourcePosition.line}:${issue.sourcePosition.column} ${issue.description}`), id);
  }
});
