// The real Firebase JS SDK against Storage in a real browser, which is the only
// place CORS is enforced: an HTTP test passes whatever the headers say.
//
// STORAGE_BROWSER_TARGET=firebase-tools runs the same check against the official
// emulator, to show what it expects is what the official emulator does.
// FIRENOOK_BINARY runs it against a given engine, such as a released one.
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
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const project = 'demo-firenook-browser-storage';
const bucket = `${project}.appspot.com`;
const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /open/{name} { allow read, write: if true; }
    match /deep/{allPaths=**} { allow read, write: if true; }
  }
}
`;

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};

async function startBackend(work, port) {
  const [hub, logging] = [await reservePort(), await reservePort()];
  await writeFile(join(work, 'storage.rules'), rules);
  await writeFile(join(work, 'firebase.json'), JSON.stringify({
    storage: { rules: 'storage.rules' },
    emulators: { storage: { host: '127.0.0.1', port }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging }, ui: { enabled: false }, singleProjectMode: true },
  }));
  let command;
  let args;
  if (process.env.STORAGE_BROWSER_TARGET === 'firebase-tools') {
    const require = createRequire(new URL('../package.json', import.meta.url));
    command = process.execPath;
    args = [join(dirname(require.resolve('firebase-tools/package.json')), 'lib/bin/firebase.js'), 'emulators:start', '--only', 'storage', '--project', project, '--config', join(work, 'firebase.json')];
  } else {
    command = process.env.FIRENOOK_BINARY;
    if (!command) {
      await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
      command = join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
    }
    args = ['suite', '--project-id', project, '--node', process.execPath, '--state-dir', join(work, 'state'), '--only', 'storage', '--no-ui', '--project-dir', work];
  }
  const child = spawn(command, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GCLOUD_PROJECT: project } });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; });
  const deadline = Date.now() + 120_000;
  while (!log.includes('All emulators ready')) {
    assert.equal(child.exitCode, null, log);
    assert.ok(Date.now() < deadline, log);
    await delay(50);
  }
  return {
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGINT');
      await Promise.race([once(child, 'exit'), delay(15_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

const seed = async (origin, name) => {
  const response = await fetch(`${origin}/v0/b/${bucket}/o?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { authorization: 'Bearer owner' }, body: 'seed',
  });
  assert.ok(response.ok, `seed ${name}: ${response.status}`);
};

test('the Firebase JS SDK uploads, reads back and lists in a real browser', { timeout: 600_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'firenook-storage-browser-'));
  const port = await reservePort();
  const backend = await startBackend(work, port);
  const origin = `http://127.0.0.1:${port}`;
  const bundle = await build({
    entryPoints: [join(root, 'conformance/src/suite/storage-browser-entry.mjs')],
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
  });
  const page = `<!doctype html><meta charset="utf-8"><title>storage</title><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
  const server = createHttpServer((_, response) => { response.setHeader('content-type', 'text/html'); response.end(page); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  let results;
  const refused = [];
  try {
    await seed(origin, 'open/sub/nested.txt');
    await seed(origin, 'deep/one.txt');
    await seed(origin, 'deep/sub/two.txt');
    await seed(origin, 'top.txt');
    const context = await browser.newContext();
    const tab = await context.newPage();
    // Chrome names what CORS refused only here, not to the page.
    tab.on('console', (message) => { if (/CORS|Access-Control/i.test(message.text())) refused.push(message.text()); });
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    results = await tab.evaluate((settings) => window.runStorageScenario(settings), { host: '127.0.0.1', port, bucket });
  } finally {
    await browser.close();
    server.close();
    await backend.stop();
  }
  console.log(JSON.stringify(results, null, 1));
  assert.deepEqual(refused, [], 'the browser refused a request');

  const type = { contentType: 'application/x-test', custom: { k: 'v' } };
  for (const [label, length] of [['100 KB', 102_400], ['300 KB', 307_200], ['1 MB', 1_048_576]]) {
    assert.deepEqual(results[`uploadBytesResumable ${label}`], { ok: true, state: 'success', transferred: length }, label);
    assert.deepEqual(results[`read back ${label}`], { ok: true, size: length, identical: true, ...type }, label);
  }
  assert.deepEqual(results['uploadBytes 1 MB'], { ok: true, size: 1_048_576, contentType: 'application/x-test' });
  assert.deepEqual(results['read back one-shot'], { ok: true, size: 1_048_576, identical: true });
  assert.deepEqual(results['uploadBytesResumable refused'], { ok: false, code: 'storage/unauthorized' });
  assert.deepEqual(results['uploadBytes refused'], { ok: false, code: 'storage/unauthorized' });
  assert.deepEqual(results['listAll under a single-segment rule'], {
    ok: true,
    items: ['open/one-shot.bin', 'open/resumable-102400.bin', 'open/resumable-1048576.bin', 'open/resumable-307200.bin'],
    prefixes: ['open/sub'],
  });
  assert.deepEqual(results['listAll below a single-segment rule'], { ok: false, code: 'storage/unauthorized' });
  assert.deepEqual(results['listAll above a single-segment rule'], { ok: false, code: 'storage/unauthorized' });
  assert.deepEqual(results['listAll under a recursive rule'], { ok: true, items: ['deep/one.txt'], prefixes: ['deep/sub'] });
  assert.deepEqual(results['listAll deeper under a recursive rule'], { ok: true, items: ['deep/sub/two.txt'], prefixes: [] });
});
