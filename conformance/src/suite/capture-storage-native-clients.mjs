// Records how the official Storage emulator answers the requests native SDKs
// and browsers send. Writes fixture.json and SHA256SUMS to a fresh directory;
// starts and stops only its own official emulator.
//
//   node conformance/src/suite/capture-storage-native-clients.mjs <fresh-output-directory>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observe, project, startRules } from './storage-native-clients-observe.mjs';

const output = resolve(process.argv[2] ?? '');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length > 0) throw new Error('the output must be empty: recorded oracle evidence is never overwritten');
const require = createRequire(new URL('../../package.json', import.meta.url));
const toolsRoot = require.resolve('firebase-tools/package.json').replace(/package\.json$/, '');
const tools = JSON.parse(await readFile(join(toolsRoot, 'package.json'), 'utf8'));

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};
const [storage, hub, logging] = [await reservePort(), await reservePort(), await reservePort()];
const work = await mkdtemp(join(tmpdir(), 'firenook-native-clients-capture-'));
await writeFile(join(work, 'storage.rules'), startRules);
await writeFile(join(work, 'firebase.json'), JSON.stringify({
  storage: { rules: 'storage.rules' },
  emulators: { storage: { host: '127.0.0.1', port: storage }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging }, ui: { enabled: false }, singleProjectMode: true },
}, null, 2));
const child = spawn(process.execPath, [join(toolsRoot, 'lib/bin/firebase.js'), 'emulators:start', '--only', 'storage', '--project', project, '--config', join(work, 'firebase.json')], {
  cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GCLOUD_PROJECT: project },
});
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; });
const capturedAt = new Date().toISOString();
try {
  const deadline = Date.now() + 120_000;
  while (!log.includes('All emulators ready')) {
    if (child.exitCode !== null) throw new Error(`official emulator exited: ${log}`);
    if (Date.now() > deadline) throw new Error(`official emulator did not start: ${log}`);
    await delay(100);
  }
  const observations = await observe(`http://127.0.0.1:${storage}`, (line) => console.log(line));
  const fixture = {
    schemaVersion: 1,
    syntheticOnly: true,
    project,
    capturedAt,
    oracle: {
      firebaseTools: tools.version,
      node: process.version,
      java: spawnSync(process.env.JAVA ?? 'java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0],
    },
    ...observations,
    passed: true,
  };
  const bytes = `${JSON.stringify(fixture, null, 1)}\n`;
  await writeFile(join(output, 'fixture.json'), bytes);
  await writeFile(join(output, 'SHA256SUMS'), `${createHash('sha256').update(bytes).digest('hex')}  fixture.json\n`);
  console.log(`wrote ${output}`);
} finally {
  child.kill('SIGINT');
  await Promise.race([once(child, 'exit'), delay(15_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
process.exit(0);
