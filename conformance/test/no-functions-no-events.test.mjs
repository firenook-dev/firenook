// With no Functions emulator running, a new user or a new object sends nothing
// to the Functions port, as on the official emulator: its Auth and Storage
// dispatchers are enabled only when Functions is running.
//
// NO_FUNCTIONS_TARGET=firebase-tools runs the same check against the official
// emulator. FIRENOOK_BINARY runs it against a given engine.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const project = 'demo-firenook-no-functions';
const official = process.env.NO_FUNCTIONS_TARGET === 'firebase-tools';

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};

test('with Functions off, Auth and Storage send nothing to its port', { timeout: 300_000 }, async () => {
  // Stands where the Functions emulator would be, and answers, so a request
  // that reaches it counts as delivered, not failed.
  const received = [];
  const standIn = createHttpServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    request.resume();
    response.end('{}');
  });
  standIn.listen(0, '127.0.0.1');
  await once(standIn, 'listening');
  const [auth, storage, hub, logging] = [await reservePort(), await reservePort(), await reservePort(), await reservePort()];
  const work = await mkdtemp(join(tmpdir(), 'firenook-no-functions-'));
  await writeFile(join(work, 'storage.rules'), "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }\n");
  await writeFile(join(work, 'firebase.json'), JSON.stringify({
    storage: { rules: 'storage.rules' },
    emulators: {
      auth: { host: '127.0.0.1', port: auth },
      storage: { host: '127.0.0.1', port: storage },
      functions: { host: '127.0.0.1', port: standIn.address().port },
      hub: { host: '127.0.0.1', port: hub },
      logging: { host: '127.0.0.1', port: logging },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }));
  let command;
  let args;
  if (official) {
    const require = createRequire(new URL('../package.json', import.meta.url));
    command = process.execPath;
    args = [join(dirname(require.resolve('firebase-tools/package.json')), 'lib/bin/firebase.js'), 'emulators:start', '--only', 'auth,storage', '--project', project, '--config', join(work, 'firebase.json')];
  } else {
    command = process.env.FIRENOOK_BINARY;
    if (!command) {
      await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
      command = join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
    }
    args = ['suite', '--project-id', project, '--node', process.execPath, '--state-dir', join(work, 'state'), '--only', 'auth,storage', '--no-ui', '--project-dir', work];
  }
  const child = spawn(command, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GCLOUD_PROJECT: project } });
  const exited = once(child, 'exit');
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; });
  try {
    const deadline = Date.now() + 120_000;
    while (!log.includes('All emulators ready')) {
      assert.equal(child.exitCode, null, log);
      assert.ok(Date.now() < deadline, log);
      await delay(50);
    }
    const signUp = await fetch(`http://127.0.0.1:${auth}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com', password: 'secret123', returnSecureToken: true }),
    });
    assert.equal(signUp.status, 200, 'the sign-up itself succeeds');
    const { idToken } = await signUp.json();
    const remove = await fetch(`http://127.0.0.1:${auth}/identitytoolkit.googleapis.com/v1/accounts:delete?key=demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
    });
    assert.equal(remove.status, 200, 'the deletion itself succeeds');
    const objectUrl = `http://127.0.0.1:${storage}/v0/b/${project}.appspot.com/o`;
    const upload = await fetch(`${objectUrl}?name=a.txt`, { method: 'POST', body: 'a' });
    assert.equal(upload.status, 200, 'the upload itself succeeds');
    const erase = await fetch(`${objectUrl}/a.txt`, { method: 'DELETE' });
    assert.equal(erase.status, 204, 'the object deletion itself succeeds');
    // The delivery worker retries for about 0.4 s; give it well over that.
    await delay(1_500);
  } finally {
    if (child.exitCode === null) child.kill('SIGINT');
    await exited;
    standIn.close();
  }
  assert.deepEqual(received, [], 'nothing reaches the Functions port');
  if (!official) {
    const stopped = /stopped cleanly: (\{.*\})/.exec(log);
    assert.ok(stopped, log);
    const { delivery } = JSON.parse(stopped[1]);
    assert.equal(delivery.admitted, 0, 'nothing was admitted');
    assert.equal(delivery.failed, 0, 'no failed delivery is reported');
  }
});
