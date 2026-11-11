// Replays the official capture of rules paths and document names against the native
// engine, with no differences accepted.
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
import { observe } from '../src/suite/rules-document-paths-observe.mjs';
import * as ledger from '../src/report/ledger.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('../fixtures/rules-document-paths-v1/fixture.json', import.meta.url)));
const execute = promisify(execFile);

const engine = async () => {
  if (process.env.FIRENOOK_BINARY) return process.env.FIRENOOK_BINARY;
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  return join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
};

test('rules paths and document names answer as the official capture says', { timeout: 300_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'firenook-rules-path-'));
  const rules = join(work, 'firestore.rules');
  await writeFile(rules, "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }\n");
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  const child = spawn(await engine(), ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', rules], { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      assert.equal(child.exitCode, null, 'the engine exited');
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; } catch { /* not listening yet */ }
      assert.ok(Date.now() < deadline, 'the engine did not start');
      await delay(50);
    }
    const { answers } = await observe(`127.0.0.1:${port}`);
    assert.deepEqual(answers, fixture.answers);
    // Each row recorded only a status, or that the rules were refused.
    for (const [id, answer] of Object.entries(fixture.answers)) {
      ledger.checked('rules-document-paths-v1', id, answer.rulesRefused !== undefined ? ledger.COMPARED.verdict : ledger.COMPARED.status);
    }
  } finally {
    child.stdin.end();
    await Promise.race([exited, delay(15_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
