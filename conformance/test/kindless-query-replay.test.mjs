// Replays the official emulator's kindless query capture against the native
// engine, in memory and on disk. Every accepted difference is listed here with
// its reason; anything else fails.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { observe } from '../src/suite/kindless-query-observe.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('../fixtures/kindless-query-v1/fixture.json', import.meta.url)));
const execute = promisify(execFile);

// A selector with an empty id and no allDescendants lists the direct children
// of every collection under the parent in the official emulator. No SDK sends
// it, and the native engine keeps refusing it as an invalid scope.
const REFUSED = new Set(['empty-id-direct-children']);

function assertQuery(id, actual, expected) {
  assert.equal(actual.code, expected.code, `${id} code: ${actual.message ?? ''}`);
  if (expected.code === 0) {
    assert.deepEqual(actual.documents, expected.documents, id);
    assert.deepEqual(actual.fields, expected.fields, `${id} fields`);
    assert.deepEqual(actual.aggregate, expected.aggregate, `${id} aggregate`);
  } else {
    assert.equal(actual.message, expected.message, `${id} message`);
  }
}

test('kindless queries and recursiveDelete match the official capture in memory and on disk', { timeout: 900_000 }, async () => {
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  const binary = process.env.FIRENOOK_BINARY ?? join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
  for (const mode of ['memory', 'disk-wal']) {
    const work = await mkdtemp(join(tmpdir(), 'firenook-kindless-'));
    await writeFile(join(work, 'firestore.rules'), "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const { port } = reservation.address();
    await new Promise((done) => reservation.close(done));
    const args = ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', join(work, 'firestore.rules')];
    if (mode === 'disk-wal') args.push('--data-dir', join(work, 'state'));
    const peer = spawn(binary, args, { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(peer, 'exit');
    let log = '';
    for (const stream of [peer.stdout, peer.stderr]) stream.on('data', (bytes) => { log += bytes; });
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        assert.equal(peer.exitCode, null, log);
        try {
          await (await fetch(`http://127.0.0.1:${port}/emulator/v1/debug/memory`, { signal: AbortSignal.timeout(250) })).arrayBuffer();
          break;
        } catch { /* not listening yet */ }
        assert.ok(Date.now() < deadline, log);
        await delay(25);
      }
      const actual = await observe(`127.0.0.1:${port}`);

      for (const [id, expected] of Object.entries(fixture.queries)) {
        const { grpc, rest } = actual.queries[id];
        if (REFUSED.has(id)) {
          assert.equal(grpc.code, 3, `${mode} ${id}`);
          assert.equal(rest.status, 400, `${mode} ${id}`);
          continue;
        }
        assertQuery(`${mode} ${id} grpc`, grpc, expected.grpc);
        assert.equal(rest.status, expected.rest.status, `${mode} ${id} rest: ${rest.message ?? ''}`);
        assert.deepEqual(rest.documents, expected.rest.documents, `${mode} ${id} rest`);
        assert.equal(rest.message, expected.rest.message, `${mode} ${id} rest message`);
        assert.equal(rest.errorStatus, expected.rest.errorStatus, `${mode} ${id} rest status`);
      }
      for (const [id, expected] of Object.entries(fixture.aggregations)) {
        assertQuery(`${mode} ${id}`, actual.aggregations[id], expected);
      }
      for (const [id, expected] of Object.entries(fixture.listens)) {
        const listened = actual.listens[id];
        assert.equal(listened.code, expected.code, `${mode} listen ${id}`);
        assert.deepEqual(listened.documents, expected.documents, `${mode} listen ${id}`);
        // The official emulator repeats a change on a plain collection, so
        // the control compares what was heard, not how often.
        assert.deepEqual([...new Set(listened.changes)], [...new Set(expected.changes)], `${mode} listen ${id} changes`);
      }
      // Who may read, and what they read. Denial wording is the rules
      // engine's own and is compared elsewhere.
      assert.deepEqual(actual.rules, fixture.rules, `${mode} rules`);
      assert.deepEqual(actual.databases, fixture.databases, `${mode} databases`);
      assert.deepEqual(actual.sdk, fixture.sdk, `${mode} sdk`);
    } finally {
      peer.stdin.end();
      if (peer.exitCode === null) peer.kill();
      await exited;
    }
  }
});
