// Replays the official emulator's resume capture against the native engine, in
// memory and on disk. Every accepted difference is listed here with its reason;
// anything else fails.
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
import { observe } from '../src/suite/listen-resume-observe.mjs';
import * as ledger from '../src/report/ledger.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('../fixtures/listen-resume-v1/fixture.json', import.meta.url)));
const execute = promisify(execFile);

// A token this very run issued replays only what changed since, where the
// official emulator resends everything. The client ends up with the same data.
const REPLAYS_CHANGES = new Set(['own-token']);
// An old read time follows what production answers: a checkpoint, the documents
// and an existence filter. The client ends up with the same data.
const READ_TIME_AS_PRODUCTION = new Set(['read-time-a-day-ago', 'read-time-with-nanoseconds', 'read-time-zero']);

const engine = async () => {
  if (process.env.FIRENOOK_BINARY) return process.env.FIRENOOK_BINARY;
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  return join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
};

test('a listener resumes as the official capture says, in memory and on disk', { timeout: 300_000 }, async () => {
  const binary = await engine();
  for (const mode of ['memory', 'disk-wal']) {
    const work = await mkdtemp(join(tmpdir(), 'firenook-listen-resume-'));
    const rules = join(work, 'firestore.rules');
    await writeFile(rules, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
    const start = async () => {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const { port } = reservation.address();
      await new Promise((done) => reservation.close(done));
      const args = ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', rules];
      if (mode === 'disk-wal') args.push('--data-dir', join(work, 'state'));
      const child = spawn(binary, args, { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
      const exited = once(child, 'exit');
      const deadline = Date.now() + 30_000;
      while (true) {
        assert.equal(child.exitCode, null, 'the engine exited');
        try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; } catch { /* not listening yet */ }
        assert.ok(Date.now() < deadline, 'the engine did not start');
        await delay(50);
      }
      return { port, child, exited };
    };
    const stop = async ({ child, exited }) => {
      child.stdin.end();
      await Promise.race([exited, delay(15_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    let running = await start();
    try {
      const { answers } = await observe(running.port, async () => {
        await stop(running);
        running = await start();
        return running.port;
      }, fixture.issuedToken);
      for (const [id, expected] of Object.entries(fixture.answers)) {
        const actual = answers[id];
        const label = `${mode} ${id}`;
        assert.equal(actual.ending, expected.ending, `${label}: ${actual.message ?? ''}`);
        if (REPLAYS_CHANGES.has(id)) {
          assert.deepEqual(actual.frames, ['ADD', 'CURRENT', 'NO_CHANGE'], label);
          if (JSON.stringify(expected.frames) !== JSON.stringify(actual.frames)) {
            ledger.differs('listen-resume-v1', id, ledger.COMPARED.answer, 'a token this run issued replays only what changed since, where the official emulator resends everything; the client ends up with the same data');
          }
          continue;
        }
        if (READ_TIME_AS_PRODUCTION.has(id)) {
          assert.deepEqual(actual.documents, expected.documents, label);
          // The documents the listener ends with and how it ends; its frames
          // follow production and are not compared.
          ledger.checked('listen-resume-v1', id, ledger.COMPARED.behaviour);
          continue;
        }
        if (mode === 'disk-wal' && id.includes('after-a-restart')) {
          // The data outlives the restart here, and the target still starts over.
          const kept = id.endsWith('a-write') ? ['a', 'after', 'b', 'c'] : ['a', 'b', 'c'];
          assert.deepEqual(actual.documents, kept, label);
          assert.deepEqual(actual.frames, ['ADD', 'RESET', ...kept.map(() => 'documentChange'), 'CURRENT', 'NO_CHANGE'], label);
          continue;
        }
        assert.deepEqual(actual.frames, expected.frames, label);
        assert.deepEqual(actual.documents, expected.documents, label);
        ledger.checked('listen-resume-v1', id, ledger.COMPARED.answer);
      }
    } finally {
      await stop(running);
    }
  }
});
