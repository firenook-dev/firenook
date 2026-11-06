// Records how the official emulator answers a listener resuming with each kind
// of token or read time, including a token it issued before it restarted. Writes
// fixture.json and SHA256SUMS to a fresh directory; starts and stops only its own
// official emulator.
//
//   node conformance/src/suite/capture-listen-resume.mjs <fresh-output-directory>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observe, project } from './listen-resume-observe.mjs';

const JAR_SHA256 = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const output = resolve(process.argv[2] ?? '');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length > 0) throw new Error('the output must be empty: recorded oracle evidence is never overwritten');
const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (sha(await readFile(jar)) !== JAR_SHA256) throw new Error('not the pinned official emulator jar');
const java = process.env.JAVA ?? 'java';
const work = await mkdtemp(join(tmpdir(), 'firenook-listen-resume-capture-'));
const rules = join(work, 'firestore.rules');
await writeFile(rules, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");

const start = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  const child = spawn(java, ['-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project, '--rules', rules], { stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null) throw new Error('official emulator exited');
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('official emulator did not start');
    await delay(100);
  }
  return { port, child };
};
const stop = async ({ child }) => {
  child.kill();
  await Promise.race([once(child, 'exit'), delay(15_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

let running = await start();
const capturedAt = new Date().toISOString();
try {
  const { issued, answers } = await observe(running.port, async () => {
    await stop(running);
    running = await start();
    return running.port;
  }, undefined, (line) => console.log(line));
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const fixture = {
    schemaVersion: 1,
    syntheticOnly: true,
    project,
    capturedAt,
    oracle: {
      firestore: '1.22.0',
      jarSha256: JAR_SHA256,
      node: process.version,
      java: spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0],
      sdk: require('@google-cloud/firestore/package.json').version,
    },
    issuedToken: issued,
    answers,
    passed: true,
  };
  const bytes = `${JSON.stringify(fixture, null, 1)}\n`;
  await writeFile(join(output, 'fixture.json'), bytes);
  await writeFile(join(output, 'SHA256SUMS'), `${sha(bytes)}  fixture.json\n`);
  console.log(`wrote ${output}`);
} finally {
  await stop(running);
}
process.exit(0);
