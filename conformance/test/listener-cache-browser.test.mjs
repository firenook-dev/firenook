// A device keeps its cache, and a resume token with it, when the emulator behind
// it restarts or changes. The real Firebase JS SDK in a real browser reattaches
// and must be told what the emulator holds now: no error, and nothing left over
// from before.
//
// The first emulator holds three documents and the second three others, at the
// same count of commits, so that a token from the first looks current to the
// second and a client would silently keep the old documents.
//
// LISTENER_CACHE_FIRST=official starts from the official emulator, as a project
// moving to the native engine does, and LISTENER_CACHE_SECOND=official ends on it,
// as the control. Both take FIRESTORE_EMULATOR_JAR or the pinned jar in the Firebase
// cache. FIRENOOK_BINARY runs against a given engine.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const project = 'demo-firenook-kept-cache';
const documents = `projects/${project}/databases/(default)/documents`;

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

const start = async (kind, ids) => {
  const work = await mkdtemp(join(tmpdir(), 'firenook-kept-cache-'));
  const rules = join(work, 'firestore.rules');
  await writeFile(rules, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
  const port = await reservePort();
  const child = kind === 'official'
    ? spawn(process.env.JAVA ?? 'java', ['-jar', process.env.FIRESTORE_EMULATOR_JAR ?? join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar'), '--host', '127.0.0.1', '--port', String(port), '--project_id', project, '--rules', rules], { stdio: 'ignore' })
    : spawn(await engine(), ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', rules], { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
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
  for (const id of ids) {
    const written = await fetch(`http://127.0.0.1:${port}/v1/${documents}/kept/${id}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { v: { integerValue: '1' } } }),
    });
    assert.equal(written.status, 200, `seed ${id}`);
  }
  return {
    port,
    stop: async () => {
      if (kind === 'official') child.kill();
      else child.stdin.end();
      await Promise.race([exited, delay(15_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
};

test('a kept cache meets a restarted or different emulator', { timeout: 300_000 }, async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/suite/listener-cache-browser-entry.mjs', import.meta.url))],
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  });
  const script = bundled.outputFiles[0].text;
  const page = createHttpServer((request, response) => {
    if (request.url === '/entry.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(script);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><script src="/entry.js"></script>');
  });
  page.listen(0, '127.0.0.1');
  await once(page, 'listening');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${page.address().port}/`);
    const attach = (port) => tab.evaluate(([to, id]) => window.attach(to, id), [port, project]);

    const first = await start(process.env.LISTENER_CACHE_FIRST ?? 'native', ['a', 'b', 'c']);
    let answer;
    try {
      answer = await attach(first.port);
    } finally {
      await first.stop();
    }
    assert.deepEqual(answer, { documents: ['a', 'b', 'c'] }, 'the first emulator');

    const second = await start(process.env.LISTENER_CACHE_SECOND ?? 'native', ['x', 'y', 'z']);
    try {
      answer = await attach(second.port);
    } finally {
      await second.stop();
    }
    assert.deepEqual(answer, { documents: ['x', 'y', 'z'] }, 'the second emulator, with the cache of the first');
  } finally {
    await browser.close();
    page.close();
  }
});
