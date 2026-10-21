import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../fixtures/request-identity-v1/', import.meta.url);
const bytes = await readFile(new URL('fixture.json', root));
const fixture = JSON.parse(bytes);
const read = (database, identity, path) => fixture.reads.find((row) => row.database === database && row.identity === identity && row.path === path);

test('the request-identity capture is the pinned official emulator, unchanged', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), (await readFile(new URL('SHA256SUMS', root), 'utf8')).split(' ')[0]);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.oracle.target, 'java');
  assert.equal(fixture.oracle.firestore, '1.22.0');
  assert.equal(fixture.oracle.jarSha256, '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  assert.equal(fixture.reads.length, 2 * fixture.identities.length * 3);
});

test('a request without an Authorization header is a signed-out client on gRPC and REST', () => {
  for (const database of ['(default)', 'unlisted']) {
    assert.deepEqual([read(database, 'absent', 'deny/x').grpc.code, read(database, 'absent', 'deny/x').rest.status], [7, 403]);
    assert.deepEqual([read(database, 'absent', 'anon/x').grpc.code, read(database, 'absent', 'anon/x').rest.status], [5, 404]);
    for (const owner of ['owner', 'owner-lowercase', 'owner-uppercase']) assert.equal(read(database, owner, 'deny/x').grpc.code, 5);
  }
  const sdks = Object.fromEntries(fixture.sdkHeaders.map(({sdk, authorization}) => [sdk, authorization]));
  assert.deepEqual(sdks['@google-cloud/firestore (Admin SDK), gRPC'], ['Bearer owner']);
  assert.deepEqual(sdks['firebase/firestore (Node, gRPC), signed out'], ['absent']);
  assert.deepEqual(sdks['firebase/firestore/lite (REST), signed out'], ['absent']);
});

test('tokens are read without checking times, project, algorithm, signature or claims', () => {
  for (const identity of ['issued-at-zero', 'issued-tomorrow', 'other-project', 'other-audience', 'sub-only', 'no-alg', 'signed', 'padded-base64', 'user-lowercase-scheme']) {
    assert.equal(read('(default)', identity, 'alice/x').grpc.code, 5, identity);
    assert.equal(read('(default)', identity, 'anon/x').grpc.code, 7, identity);
  }
  for (const identity of ['user-id-only', 'empty-claims', 'numeric-sub']) {
    assert.equal(read('(default)', identity, 'anon/x').grpc.code, 7, identity);
    assert.equal(fixture.claims.find((row) => row.identity === identity && row.path === 'uid-null/x').rest.status, 404, identity);
  }
  for (const identity of ['two-segments', 'array-claims', 'not-a-jwt']) {
    assert.deepEqual([read('(default)', identity, 'anon/x').grpc.code, read('(default)', identity, 'anon/x').rest.status], [3, 400], identity);
  }
});

test('a database firebase.json does not list is governed by the same rules', () => {
  for (const row of fixture.reads.filter((row) => row.database === 'unlisted')) {
    const listed = read('(default)', row.identity, row.path);
    assert.deepEqual([row.grpc.code, row.rest.status], [listed.grpc.code, listed.rest.status], `${row.identity} ${row.path}`);
  }
});

test('collection ids need the owner, pipelines are ruled, and the reload route reads text/plain JSON', () => {
  for (const row of fixture.metadata) {
    assert.equal(row.grpc.code, row.identity === 'owner' ? 0 : 7, `${row.mode} ${row.identity}`);
    assert.equal(row.rest.status, row.identity === 'owner' ? 200 : 403, `${row.mode} ${row.identity}`);
    assert.equal(row.partition.code, 12, `${row.mode} ${row.identity}`);
  }
  assert.deepEqual(fixture.pipelines.map((row) => [row.identity, row.pipeline.code, row.query.code]), [['user', 7, 7], ['owner', 0, 0]]);
  assert.deepEqual(fixture.reload.map((row) => [row.body, row.status, row.governs]), [['json', 200, 403], ['text-plain', 200, 403], ['no-content-type', 200, 403]]);
  assert.equal(fixture.denials.noMatchingAllow.grpc.message, 'No matching allow statements');
  assert.equal(fixture.denials.twoAllows.grpc.message, "\nfalse for 'get' @ L11, false for 'get' @ L12");
});
