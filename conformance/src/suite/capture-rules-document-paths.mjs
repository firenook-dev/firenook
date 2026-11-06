// Records how the official emulator answers rules paths and document names. Writes
// fixture.json and SHA256SUMS to a fresh directory; starts and stops only its
// own official emulator.
//
//   node conformance/src/suite/capture-rules-document-paths.mjs <fresh-output-directory>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observe, project } from './rules-document-paths-observe.mjs';

const JAR_SHA256 = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const output = resolve(process.argv[2] ?? '');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length > 0) throw new Error('the output must be empty: recorded oracle evidence is never overwritten');
const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (sha(await readFile(jar)) !== JAR_SHA256) throw new Error('not the pinned official emulator jar');

const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const { port } = reservation.address();
await new Promise((done) => reservation.close(done));
const work = await mkdtemp(join(tmpdir(), 'firenook-rules-paths-capture-'));
const rules = join(work, 'firestore.rules');
await writeFile(rules, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
const java = process.env.JAVA ?? 'java';
const child = spawn(java, ['-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project, '--rules', rules], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; });
const capturedAt = new Date().toISOString();
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`official emulator exited: ${log}`);
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`official emulator did not start: ${log}`);
    await delay(100);
  }
  const observations = await observe(`127.0.0.1:${port}`, (line) => console.log(line));
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
    ...observations,
    passed: true,
  };
  const bytes = `${JSON.stringify(fixture, null, 1)}\n`;
  await writeFile(join(output, 'fixture.json'), bytes);
  await writeFile(join(output, 'SHA256SUMS'), `${sha(bytes)}  fixture.json\n`);
  console.log(`wrote ${output}`);
} finally {
  child.kill();
  await once(child, 'exit').catch(() => {});
}
process.exit(0);
