// Replays the official emulator's capture of what native SDKs and browsers send
// to Storage against the native engine. Every accepted difference is listed
// here with its reason; anything else fails.
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
import { observe, project, startRules } from '../src/suite/storage-native-clients-observe.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('../fixtures/storage-native-clients-v1/fixture.json', import.meta.url)));
const execute = promisify(execFile);

// firebase-tools 15.34.0 stores a one-shot v0 upload's Content-Type; 15.22.0,
// pinned by storage-rules-v1, ignored it. No SDK sends this shape.
const MEDIA_TYPE_NOT_READ = new Set(['object-path-media', 'object-path-media-put', 'bucket-path-media-put']);
// The same refusal, with a JSON error natively and an empty body officially.
const REFUSAL_BODY_DIFFERS = new Set(['start-without-a-name', 'command-without-an-id', 'create-token-not-true']);
// The rules path() function is not implemented natively, so this denies.
const NEEDS_THE_PATH_FUNCTION = new Set(['recursive-binding-negated']);

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};

test('what native SDKs and browsers send to Storage matches the official capture', { timeout: 600_000 }, async () => {
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  const binary = process.env.FIRENOOK_BINARY ?? join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
  const work = await mkdtemp(join(tmpdir(), 'firenook-native-clients-'));
  const [storage, hub, logging] = [await reservePort(), await reservePort(), await reservePort()];
  await writeFile(join(work, 'storage.rules'), startRules);
  await writeFile(join(work, 'firebase.json'), JSON.stringify({
    storage: { rules: 'storage.rules' },
    emulators: { storage: { host: '127.0.0.1', port: storage }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging }, ui: { enabled: false }, singleProjectMode: true },
  }));
  const child = spawn(binary, ['suite', '--project-id', project, '--node', process.execPath, '--state-dir', join(work, 'state'), '--only', 'storage', '--no-ui', '--project-dir', work], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; });
  try {
    const deadline = Date.now() + 60_000;
    while (!log.includes('All emulators ready')) {
      assert.equal(child.exitCode, null, log);
      assert.ok(Date.now() < deadline, log);
      await delay(25);
    }
    // Through JSON, as the fixture went, so an absent field is simply absent.
    const actual = JSON.parse(JSON.stringify(await observe(`http://127.0.0.1:${storage}`)));
    for (const section of ['uploads', 'downloads', 'tokens']) {
      for (const [id, expected] of Object.entries(fixture[section])) {
        if (REFUSAL_BODY_DIFFERS.has(id)) {
          assert.equal(actual[section][id].status, expected.status, `${section} ${id}`);
        } else if (MEDIA_TYPE_NOT_READ.has(id)) {
          assert.deepEqual(actual[section][id], { ...expected, body: { ...expected.body, contentType: 'application/octet-stream' } }, `${section} ${id}`);
        } else {
          assert.deepEqual(actual[section][id], expected, `${section} ${id}`);
        }
      }
    }
    assert.deepEqual(actual.cors, fixture.cors, 'cors');
    for (const [id, expected] of Object.entries(fixture.lists)) {
      if (!NEEDS_THE_PATH_FUNCTION.has(id)) assert.deepEqual(actual.lists[id], expected, `lists ${id}`);
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGINT');
    await exited;
  }
});
