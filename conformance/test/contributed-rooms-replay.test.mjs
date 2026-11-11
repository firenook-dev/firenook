// Replays the contributed rooms cases (fixtures/rules-v2/contributed-rooms,
// recorded from the official emulator 1.22.0) against the native engine, in
// order against one seed, as they were recorded. Every status must match. An
// allowed case's answer must match too, its server times left out; a denial's
// error status must match, while its message is Firenook's own (see
// COMPATIBILITY.md), so a denial counts as its status.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as ledger from '../src/report/ledger.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = new URL('../fixtures/rules-v2/contributed-rooms/', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('cases.json', directory), 'utf8'));
const rulesPath = fileURLToPath(new URL('firestore.rules', directory));
const execute = promisify(execFile);
const SET = 'rules-v2/contributed-rooms';
const NO_DONE = 'Firenook ends a runQuery stream without "done": true, as production does';

const engine = async () => {
  if (process.env.FIRENOOK_BINARY) return process.env.FIRENOOK_BINARY;
  await execute('cargo', ['build', '--locked', '-p', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  return join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
};

/** An answer with its server times left out and its keys in one order. */
function normalized(value, inTransform = false) {
  if (Array.isArray(value)) return value.map((item) => normalized(item, inTransform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['createTime', 'updateTime', 'readTime', 'commitTime'].includes(key))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => [key, inTransform && key === 'timestampValue' ? '<server time>' : normalized(item, inTransform || key === 'transformResults')]));
  }
  return value;
}

const base64Url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned ID token, as the emulators accept and as the recording sent. */
function token({ uid, claims }) {
  const now = Math.floor(Date.now() / 1000) - 60;
  const payload = {
    aud: fixture.projectId, auth_time: now, exp: now + 3600, firebase: { sign_in_provider: 'custom' }, iat: now,
    iss: `https://securetoken.google.com/${fixture.projectId}`, sub: uid, user_id: uid, ...claims,
  };
  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url(payload)}.`;
}

test('the contributed rooms cases answer as the official emulator recorded them', { timeout: 300_000 }, async () => {
  assert.equal(fixture.cases.length, fixture.allowCases + fixture.denyCases);
  const work = await mkdtemp(join(tmpdir(), 'firenook-contributed-rooms-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  const child = spawn(await engine(), ['firestore', '--host', '127.0.0.1', '--port', String(port), '--rules', rulesPath], { cwd: work, env: { ...process.env, FIRENOOK_CONTROL_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  const origin = `http://127.0.0.1:${port}`;
  const documents = `projects/${fixture.projectId}/databases/(default)/documents`;
  const send = async (method, path, body, bearer) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : text };
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      assert.equal(child.exitCode, null, 'the engine exited');
      try { await fetch(`${origin}/`, { signal: AbortSignal.timeout(500) }); break; } catch { /* not listening yet */ }
      assert.ok(Date.now() < deadline, 'the engine did not start');
      await delay(50);
    }
    const seeded = await send('POST', `/v1/${documents}:commit`, { writes: fixture.seed.map(({ path, fields }) => ({ update: { name: `${documents}/${path}`, fields } })) }, 'owner');
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

    const notes = [];
    for (const testCase of fixture.cases) {
      const { request, observed } = testCase;
      const body = request.body === undefined ? undefined : JSON.parse(JSON.stringify(request.body).replaceAll('{documents}', documents));
      const got = await send(request.method, `/v1/projects/${fixture.projectId}/databases/(default)/${request.path}`, body, testCase.auth ? token(testCase.auth) : undefined);
      assert.equal(got.status, observed.status, `${testCase.id}: status`);
      if (testCase.expected === 'DENY') {
        assert.equal(got.body?.error?.status, observed.body?.error?.status, `${testCase.id}: error status`);
        notes.push(() => ledger.checked(SET, `contributed-rooms/${testCase.id}`, ledger.COMPARED.status));
        continue;
      }
      const runQuery = request.path.endsWith(':runQuery');
      const recorded = runQuery ? observed.body.map(({ done: _done, ...rest }) => rest) : observed.body;
      assert.deepEqual(normalized(got.body), normalized(recorded), `${testCase.id}: answer`);
      const endedWithDone = runQuery && observed.body.some((entry) => entry.done === true);
      if (endedWithDone) assert.ok(got.body.every((entry) => entry.done === undefined), `${testCase.id}: no done`);
      notes.push(() => endedWithDone
        ? ledger.differs(SET, `contributed-rooms/${testCase.id}`, ledger.COMPARED.answer, NO_DONE)
        : ledger.checked(SET, `contributed-rooms/${testCase.id}`, ledger.COMPARED.answer));
    }
    // Noted only once every case has passed.
    for (const note of notes) note();
  } finally {
    child.stdin.end();
    await Promise.race([exited, delay(15_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
