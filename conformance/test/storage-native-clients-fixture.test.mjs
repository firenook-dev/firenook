import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the Storage capture pins what the official emulator answers native clients', async () => {
  const root = new URL('../fixtures/storage-native-clients-v1/', import.meta.url);
  const bytes = await readFile(new URL('fixture.json', root));
  const sha = (await readFile(new URL('SHA256SUMS', root), 'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.passed, true);
  assert.equal(fixture.oracle.firebaseTools, '15.34.0');
  const { uploads, tokens, cors, lists } = fixture;

  // The iOS start on an object path is an upload, and finishes on the given URL.
  assert.equal(uploads['ios-start'].status, 200);
  assert.equal(uploads['ios-start'].uploadStatus, 'active');
  assert.equal(uploads['ios-start'].uploadUrl.name, 'open/hello.txt');
  assert.equal(uploads['ios-put-finalize'].uploadStatus, 'final');
  assert.equal(uploads['ios-put-finalize'].body.contentType, 'text/plain');
  assert.deepEqual(uploads['ios-put-finalize'].body.metadata, { k: 'v' });
  assert.equal(uploads['path-beats-query-finalize'].body.name, 'open/path.txt');

  // A start checks no rules; finalize does.
  assert.equal(uploads['ios-denied-start'].status, 200);
  assert.equal(uploads['ios-denied-finalize'].status, 403);
  assert.equal(uploads['ios-denied-finalize'].uploadStatus, 'final');

  // Only the JSON body sets the type.
  assert.equal(uploads['android-start-no-body'].status, 200);
  assert.equal(uploads['android-empty-finalize'].body.size, '3');
  assert.equal(uploads['android-typed-finalize'].body.contentType, 'image/png');
  assert.equal(uploads['android-untyped-finalize'].body.contentType, 'application/octet-stream');

  // Tokens on the same route stay admin-only.
  assert.equal(tokens['create-token-signed-out'].status, 403);
  assert.equal(tokens['create-token-owner'].status, 200);

  // A preflight repeats what it was asked; responses expose the upload headers.
  assert.ok(cors.preflight.allowHeaders.includes('x-goog-upload-header-content-length'));
  assert.ok(cors.preflight.allowHeaders.includes('x-made-up-header'));
  assert.ok(cors.exposed.includes('x-goog-upload-url'));
  assert.ok(cors.exposed.includes('x-goog-upload-status'));

  // A list is the folder and one more segment.
  assert.equal(lists['single-wildcard']['open/'].status, 200);
  assert.equal(lists['single-wildcard']['open/sub/'].status, 403);
  assert.equal(lists['root-single-wildcard']['(root)'].status, 200);
  assert.equal(lists['exact-folder']['open/'].status, 403);
  assert.equal(lists['deeper-single-wildcard']['open/sub/'].status, 200);
  assert.equal(lists['name-is-a-string']['open/'].status, 403);
  assert.equal(lists['name-or-true']['open/'].status, 200);
  assert.equal(lists['recursive-binding-is-path']['open/'].status, 200);
});
