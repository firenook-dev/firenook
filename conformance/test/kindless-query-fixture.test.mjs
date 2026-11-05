import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the kindless query capture pins what the official emulator answers', async () => {
  const root = new URL('../fixtures/kindless-query-v1/', import.meta.url);
  const bytes = await readFile(new URL('fixture.json', root));
  const sha = (await readFile(new URL('SHA256SUMS', root), 'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.passed, true);
  assert.equal(fixture.oracle.firestore, '1.22.0');

  // Names sort by path segment, numeric ids first, not by the bytes of the path.
  assert.deepEqual(fixture.queries['sdk-range-root'].grpc.documents, [
    'rd/__id5__', 'rd/A', 'rd/a', 'rd/a/sub/x', 'rd/a/sub/x/deep/y', 'rd/ghost/sub/z',
  ]);
  assert.equal(fixture.queries['root-all'].grpc.documents.indexOf('rd/ghost/sub/z') + 1,
    fixture.queries['root-all'].grpc.documents.indexOf('rd-sibling/a'));

  // Only names may filter or order it.
  assert.equal(fixture.queries['field-equal'].grpc.message, 'kind is required for filter: n');
  assert.equal(fixture.queries['field-order'].grpc.code, 3);
  assert.equal(fixture.queries['name-descending'].grpc.code, 9);
  assert.equal(fixture.queries['name-descending'].rest.errorStatus, 'FAILED_PRECONDITION');
  assert.equal(fixture.aggregations.sum.code, 3);
  assert.equal(fixture.aggregations['count-root'].aggregate.c.integerValue, '14');

  // A kindless listener hears no change after its first snapshot, while the
  // same driver hears every change on a plain collection.
  assert.deepEqual(fixture.listens['changes-under-document'].changes, []);
  assert.ok(fixture.listens['control-collection'].changes.includes('changed top/parent/c1/added'));

  // Rules must cover the whole subtree; the owner bypasses them.
  assert.equal(fixture.rules['one-collection'].user.root, 7);
  assert.equal(fixture.rules['one-subtree'].user.root, 7);
  assert.equal(fixture.rules['one-subtree'].user.underDocument, 0);
  assert.equal(fixture.rules['deny-all'].owner.root, 0);

  // The SDK deletes exactly the subtree it was given, past one query page.
  assert.ok(fixture.sdk['root-collection'].left.includes('rd-sibling/a'));
  assert.ok(!fixture.sdk['root-collection'].left.includes('rd/ghost/sub/z'));
  assert.equal(fixture.sdk['more-than-one-page'].ok, true);
  assert.ok(!fixture.sdk['more-than-one-page'].left.some((path) => path.startsWith('big/')));
});
