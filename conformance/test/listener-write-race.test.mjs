// A write that lands while a listener is attaching, or right after a deletion
// the listener has not heard of yet, reaches the listener. The real Firebase JS
// SDK takes a read time as "the data was like this then", and drops a commit
// stamped no later than a read time that lacked it; the write then stays pending
// and never arrives.
//
// LISTENER_RACE_TARGET=official runs the same check against the official
// emulator (FIRESTORE_EMULATOR_JAR, or the pinned jar in the Firebase cache).
// FIRENOOK_BINARY runs it against a given engine.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const require = createRequire(new URL('../package.json', import.meta.url));
const { deleteApp, initializeApp } = require('firebase/app');
const { connectFirestoreEmulator, deleteDoc, doc, getFirestore, onSnapshot, setDoc, terminate } = require('firebase/firestore');
const official = process.env.LISTENER_RACE_TARGET === 'official';
const project = 'demo-firenook-listener-race';
const ROUNDS = 25;
const WAIT_MS = 5_000;
// A few rounds are proof enough once it fails, and each stuck one waits out WAIT_MS.
const ENOUGH_FAILURES = 3;

const rulesFile = async (work) => {
  const path = join(work, 'firestore.rules');
  await writeFile(path, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
  return path;
};

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};

const engine = async () => {
  if (process.env.FIRENOOK_BINARY) return process.env.FIRENOOK_BINARY;
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  return join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
};

const start = async (mode) => {
  const work = await mkdtemp(join(tmpdir(), 'firenook-listener-race-'));
  const rules = await rulesFile(work);
  const port = await reservePort();
  let child;
  if (official) {
    const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
    child = spawn(process.env.JAVA ?? 'java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project, '--rules', rules], { stdio: 'ignore' });
  } else {
    const args = ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', rules];
    if (mode === 'disk') args.push('--data-dir', join(work, 'state'));
    child = spawn(await engine(), args, { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  }
  const exited = once(child, 'exit');
  const deadline = Date.now() + 60_000;
  while (true) {
    assert.equal(child.exitCode, null, 'the emulator exited');
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      break;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, 'the emulator did not start');
    await delay(50);
  }
  return {
    port,
    stop: async () => {
      if (official) child.kill();
      else child.stdin.end();
      await Promise.race([exited, delay(15_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
};

let apps = 0;
const openClient = (port) => {
  const app = initializeApp({ apiKey: 'demo', projectId: project, appId: '1:1:web:1' }, `race-${process.pid}-${apps += 1}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', port);
  return { db, close: async () => { await terminate(db); await deleteApp(app); } };
};

// Resolves once the listener has the wanted value from the server, or says how
// far it got when the wait runs out.
const settled = (reference, value, act) => new Promise((resolve) => {
  let last = 'no snapshot';
  const timer = setTimeout(() => { unsubscribe(); resolve(last); }, WAIT_MS);
  const unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
    if (snapshot.exists() && snapshot.data().v === value) {
      last = `value ${value}, hasPendingWrites ${snapshot.metadata.hasPendingWrites}`;
      if (!snapshot.metadata.hasPendingWrites) {
        clearTimeout(timer);
        unsubscribe();
        resolve('settled');
      }
    }
  }, (error) => { clearTimeout(timer); resolve(`listener error ${error.code}`); });
  act().catch((error) => { clearTimeout(timer); unsubscribe(); resolve(`write error ${error.code}`); });
});

const SCENARIOS = {
  'a write right after attaching, on a new connection': async (port, id) => {
    const client = openClient(port);
    const reference = doc(client.db, 'race', id);
    const outcome = await settled(reference, 1, () => setDoc(reference, { v: 1 }));
    await client.close();
    return outcome;
  },
  'a write right after attaching, on a connection in use': async (port, id, shared) => {
    const reference = doc(shared.db, 'race', id);
    return settled(reference, 1, () => setDoc(reference, { v: 1 }));
  },
  'a document deleted and written again at once': async (port, id, shared) => {
    const reference = doc(shared.db, 'race', id);
    await setDoc(reference, { v: 1 });
    return settled(reference, 2, async () => {
      await Promise.all([deleteDoc(reference), setDoc(reference, { v: 2 })]);
    });
  },
};

for (const mode of official ? ['official'] : ['memory', 'disk']) {
  test(`a racing write reaches the listener (${mode})`, { timeout: 600_000 }, async () => {
    const backend = await start(mode);
    const shared = openClient(backend.port);
    const failures = [];
    try {
      for (const [name, run] of Object.entries(SCENARIOS)) {
        let failed = 0;
        for (let round = 0; round < ROUNDS && failed < ENOUGH_FAILURES; round += 1) {
          const outcome = await run(backend.port, `${name.length}-${round}`, shared);
          if (outcome !== 'settled') {
            failed += 1;
            failures.push(`${name}, round ${round}: ${outcome}`);
          }
        }
      }
    } finally {
      await shared.close();
      await backend.stop();
    }
    assert.deepEqual(failures, []);
  });
}
