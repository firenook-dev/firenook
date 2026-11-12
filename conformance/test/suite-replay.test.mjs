// Replays the suite-level recordings only a running engine can answer: the
// hub, the UI port, the logging feed, start-up, shutdown and a restart on the
// same ports, and the Functions requests made of that suite
// (firebase-suite-v1: suite, functions, pubsub), each as its capture made
// them, against the engine binary. Every case is compared with the
// recording after the capture's own normalisation is applied to Firenook's
// answer, and noted in the conformance ledger only after it matched.
// Differences Firenook adopts deliberately are listed with where they are
// documented; anything else is a bug candidate, listed and asserted to still
// differ, never noted.
//
//   FIREBASE_FUNCTIONS_7_2_ROOT=<node_modules>/firebase-functions \
//   [FIRENOOK_BINARY=target/debug/firenook] node --test conformance/test/suite-replay.test.mjs
//
// firebase-admin is read beside firebase-functions, as the Functions replay
// reads it. The workers run on this Node (CI: 24.20, as recorded).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile, access } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as ledger from '../src/report/ledger.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = new URL('../fixtures/', import.meta.url);
const readFixture = async (path) => JSON.parse(await readFile(new URL(path, fixtures), 'utf8'));
const HOST = '127.0.0.1';
const SUITE = 'firebase-suite-v1/suite';

const functionsRoot = process.env.FIREBASE_FUNCTIONS_7_2_ROOT;
const adminRoot = functionsRoot ? join(dirname(functionsRoot), 'firebase-admin') : undefined;

async function engine() {
  if (process.env.FIRENOOK_BINARY) return process.env.FIRENOOK_BINARY;
  const execute = promisify(execFile);
  await execute('cargo', ['build', '--locked', '--bin', 'firenook'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const metadata = JSON.parse((await execute('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
  return join(metadata.target_directory, 'debug', process.platform === 'win32' ? 'firenook.exe' : 'firenook');
}

const reservePort = async () => {
  const reservation = createServer();
  reservation.listen(0, HOST);
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
};

async function reservePorts(names) {
  const ports = {};
  for (const name of names) ports[name] = await reservePort();
  return ports;
}

const PORT_FLAGS = {
  auth: '--auth-port', eventarc: '--eventarc-port', functions: '--functions-port', hub: '--hub-port', logging: '--logging-port',
  pubsub: '--pubsub-port', tasks: '--tasks-port', ui: '--ui-port', firestore: '--firestore-port', storage: '--storage-port',
  firestoreWebsocket: '--firestore-websocket-port',
};

/**
 * Starts the engine's suite; resolves once it prints its ready line, or,
 * with `mayExit`, once it exits before that (`suite.refused` then holds
 * how it exited).
 */
async function startSuite({ binary, projectDir, project, only, ports, tmp, ui = true, mayExit = false }) {
  await mkdir(join(projectDir, 'gcloud'), { recursive: true });
  await writeFile(join(projectDir, 'demo-adc.json'), JSON.stringify({ type: 'authorized_user', client_id: 'demo', client_secret: 'demo', refresh_token: 'demo' }));
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}`,
    TMPDIR: tmp,
    GOOGLE_APPLICATION_CREDENTIALS: join(projectDir, 'demo-adc.json'),
    CLOUDSDK_CONFIG: join(projectDir, 'gcloud'),
  });
  const args = ['suite', '--host', HOST, '--project-id', project, '--project-dir', projectDir, '--state-dir', join(projectDir, 'state'), '--node', process.execPath, '--only', only];
  if (!ui) args.push('--no-ui');
  for (const [name, port] of Object.entries(ports)) if (PORT_FLAGS[name]) args.push(PORT_FLAGS[name], String(port));
  // The logging emulator runs with or without the UI, as officially: a
  // free port of its own, never the default another suite may hold.
  if (!ports.logging) args.push(PORT_FLAGS.logging, String(await reservePort()));
  const started = performance.now();
  const child = spawn(binary, args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
  const suite = { child, exited, log: '', started };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { suite.log += bytes; });
  const deadline = Date.now() + 120_000;
  while (!/(^|\n)All emulators ready\r?\n/u.test(suite.log)) {
    if (mayExit && (child.exitCode !== null || child.signalCode !== null)) {
      suite.refused = await suite.exited;
      return suite;
    }
    assert.equal(child.exitCode, null, suite.log);
    assert.ok(Date.now() < deadline, `not ready:\n${suite.log}`);
    await delay(25);
  }
  return suite;
}

/** SIGINT, as the capture stopped the official CLI; the outcome it recorded. */
async function stopSuite(suite, ports, locator) {
  suite.child.kill('SIGINT');
  const result = await Promise.race([suite.exited, delay(30_000, null, { ref: false })]);
  assert.ok(result, `the suite did not stop:\n${suite.log}`);
  const locatorDeleted = await waitFor(async () => !(await exists(locator)), 5_000);
  const portsClosed = await waitFor(async () => !(await Promise.all(Object.values(ports).map(isPortOpen))).some(Boolean), 5_000);
  return { clean: result.code === 0 || result.code === 130 || result.signal === 'SIGINT', exitCode: result.code, signalCode: result.signal, locatorDeleted, portsClosed };
}

async function forceStop(suite) {
  if (!suite || suite.child.exitCode !== null || suite.child.signalCode !== null) return;
  suite.child.kill('SIGKILL');
  await suite.exited;
}

const exists = async (path) => access(path).then(() => true, () => false);

async function waitFor(condition, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await delay(50);
  }
  return false;
}

function isPortOpen(port) {
  return new Promise((done) => {
    const socket = new Socket();
    socket.setTimeout(200);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
    socket.connect(port, HOST);
  });
}

async function requestJson(base, method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** The capture's `normalize`: the suite root, ports, pids, generated ids and times. */
function normalizer(roots, ports) {
  const labels = new Map(Object.entries(ports).map(([name, port]) => [port, `<${name}-port>`]));
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number') return labels.get(value) ?? value;
      if (typeof value !== 'string') return value;
      let result = value;
      for (const path of roots) result = result.replaceAll(path, '<suite-root>');
      for (const [port, label] of labels) result = result.replaceAll(String(port), label);
      return result;
    }
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pid' && typeof child === 'number') output[key] = '<suite-pid>';
      else if (key === 'analytics' && typeof child === 'string') output[key] = '<analytics-session>';
      else if (['id', 'messageId'].includes(key) && typeof child === 'string' && /^\d+$/u.test(child)) output[key] = `<generated-${key}>`;
      else if (['time', 'timestamp'].includes(key) && (typeof child === 'number' || typeof child === 'string')) output[key] = `<generated-${key}>`;
      else output[key] = normalize(child);
    }
    return output;
  };
  return normalize;
}

/**
 * Every path where `actual` differs from `expected`, as `path: actual where
 * expected`. Object members are compared by name (JSON gives their order no
 * meaning), array items in order.
 */
function differences(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && Array.isArray(expected) === Array.isArray(actual)
    && (!Array.isArray(expected) || expected.length === actual.length)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) => differences(expected[key], actual[key], `${path}.${key}`));
  }
  return [`${path}: ${JSON.stringify(actual)} where ${JSON.stringify(expected)}`];
}

/**
 * Header differences outside the recorded answer (status and body): they do
 * not hold a case back, are reported, and are asserted to still occur.
 */
const HEADER_ONLY = [
  // A JSON answer's Content-Type has no charset parameter (RFC 8259 defines
  // none; Express adds it).
  /^content-type application\/json where application\/json; charset=utf-8$/u,
];

/**
 * Compares one answer with its recording: status, `content-type` and body.
 * The recorded `content-length` measures the official body before
 * normalisation; the body itself is compared.
 */
function compareObservation(recorded, answer, normalize) {
  const found = [];
  if (answer.status !== recorded.status) found.push(`status ${answer.status} where ${recorded.status}`);
  const type = recorded.responseHeaders?.['content-type'];
  if (type !== undefined && answer.headers.get('content-type') !== type) found.push(`content-type ${answer.headers.get('content-type')} where ${type}`);
  found.push(...differences(recorded.response, normalize(answer.body), 'body'));
  return found;
}

/**
 * Notes each compared case, or asserts it is a listed deliberate difference
 * or bug candidate. `compared` holds [case, found differences, level].
 */
function settle(set, compared, { differs = {}, bugs = {}, headerOnly = HEADER_ONLY }) {
  const unexplained = [];
  for (const [id, found, level] of compared) {
    const remaining = found.filter((difference) => !headerOnly.some((pattern) => pattern.test(difference)));
    if (differs[id]) {
      assert.ok(remaining.length > 0, `${set} ${id} matches now: note it checked and leave the differs table`);
      assert.ok(remaining.every((difference) => differs[id].expected.some((pattern) => pattern.test(difference))), `${set} ${id}: ${remaining.join('; ')}`);
      ledger.differs(set, id, level, differs[id].reason);
    } else if (bugs[id]) {
      assert.ok(remaining.length > 0, `${set} ${id} matches now: move it from the bug candidates into the ledger`);
      assert.ok(remaining.every((difference) => bugs[id].expected.some((pattern) => pattern.test(difference))), `${set} ${id}: ${remaining.join('; ')}`);
    } else if (remaining.length > 0) {
      unexplained.push(`${id}: ${remaining.join('; ')}`);
    } else {
      ledger.checked(set, id, level);
    }
  }
  assert.deepEqual(unexplained, [], `${set}: differences no table names`);
}

async function linkSdk(functionsDir) {
  await mkdir(join(functionsDir, 'node_modules'), { recursive: true });
  await symlink(functionsRoot, join(functionsDir, 'node_modules/firebase-functions'), 'dir');
  await symlink(adminRoot, join(functionsDir, 'node_modules/firebase-admin'), 'dir');
}

async function inventory(directory, normalize) {
  const files = [];
  const walk = async (path) => {
    for (const entry of await readdir(path)) {
      const child = join(path, entry);
      if ((await stat(child)).isDirectory()) await walk(child);
      else files.push(child);
    }
  };
  await walk(directory);
  const entries = [];
  for (const file of files.sort()) {
    const rel = relative(directory, file);
    const entry = { path: rel };
    if (rel.endsWith('.json')) entry.json = normalize(JSON.parse(await readFile(file, 'utf8')));
    entries.push(entry);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** The capture's `normalizeDynamic` for exported accounts. */
function exportedTimes(value) {
  if (Array.isArray(value)) return value.map(exportedTimes);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['createdAt', 'lastLoginAt', 'lastRefreshAt', 'validSince'].includes(key) && (typeof child === 'string' || typeof child === 'number') ? `<generated-${key}>` : exportedTimes(child)]));
}

async function readEvents(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForEvents(path, count, timeout = 20_000) {
  assert.ok(await waitFor(async () => (await readEvents(path)).length >= count, timeout), `expected ${count} function events`);
}

/** The recorded `waitForSuite`: the five probes and the Functions inventory. */
async function readiness(suite, ports, project) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const [hub, backends, auth, pubsub, ui] = await Promise.all([
        fetch(`http://${HOST}:${ports.hub}/`),
        fetch(`http://${HOST}:${ports.functions}/backends`),
        fetch(`http://${HOST}:${ports.auth}/`),
        fetch(`http://${HOST}:${ports.pubsub}/v1/projects/${project}/topics`),
        fetch(`http://${HOST}:${ports.ui}/api/config`),
      ]);
      const body = await backends.json();
      await Promise.all([hub, auth, pubsub, ui].map((response) => response.arrayBuffer()));
      const functionTriggerCount = (body.backends ?? []).reduce((count, backend) => count + (backend.functionTriggers?.length ?? 0), 0);
      if (hub.ok && backends.ok && auth.ok && pubsub.ok && ui.ok && functionTriggerCount >= 4) {
        return {
          statuses: { hub: hub.status, functions: backends.status, auth: auth.status, pubsub: pubsub.status, ui: ui.status },
          backendCount: body.backends?.length,
          functionTriggerCount,
        };
      }
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`the suite never answered the five readiness probes:\n${suite.log}`);
}

// ------------------------------------------------- firebase-suite-v1 suite

/** Differences Firenook adopts deliberately, with where they are documented. */
const SUITE_DIFFERS = {
  'ui-config-logging-and-websocket/ui-index-html': {
    reason: "the UI port's root leads to Firenook's own console at /console (COMPATIBILITY.md Hub/UI: Google's Emulator UI is not served since 0.2.0-next.3)",
    expected: [/^status 307 where 200$/u, /^content-type null where text\/html; charset=UTF-8$/u, /^body\./u],
  },
  'ui-config-logging-and-websocket/logging-websocket/2': {
    reason: "no warning that package.json names an outdated firebase-functions: the official CLI asks the npm registry for its latest version, and Firenook reaches the network only for its own update check and unvendored Extensions (SECURITY.md)",
    expected: [/^not in the feed's \d+ messages: warn /u],
  },
  'suite-startup-readiness-shutdown-and-restart/first-stop': {
    reason: "the stop after the origin guard refused an export is clean, exit 0; the official CLI exited 2 there, a fault the recording itself names (invariants originGuardFallthroughObservedInOfficialSuite, originGuardedRunExitedCleanly false), and its second, unguarded stop was clean",
    expected: [/^\.clean: true where false$/u, /^\.exitCode: 0 where 2$/u],
  },
};

/**
 * Bug candidates: answered otherwise with no documented reason. Never noted;
 * `settle` fails once one matches, so whoever fixes it moves it out of here.
 */
const SUITE_BUGS = {};

const FUNCTIONS_SET = 'firebase-suite-v1/functions';
const FUNCTIONS_DIFFERS = {};
const FUNCTIONS_BUGS = {};
const PUBSUB_SET = 'firebase-suite-v1/pubsub';
const PUBSUB_BUGS = {};

test('the suite answers its hub, UI, logging, Functions and Pub/Sub recordings, stops and restarts on the same ports', { timeout: 600_000, skip: functionsRoot ? false : 'FIREBASE_FUNCTIONS_7_2_ROOT is not set' }, async () => {
  const binary = await engine();
  const functionsFixture = await readFixture('firebase-suite-v1/functions-callable-http-and-error-contract/fixture.json');
  const pubsubFixture = await readFixture('firebase-suite-v1/pubsub-schedule-and-function-dispatch/fixture.json');
  const hubFixture = await readFixture('firebase-suite-v1/hub-locator-export-and-background-controls/fixture.json');
  const uiFixture = await readFixture('firebase-suite-v1/ui-config-logging-and-websocket/fixture.json');
  const lifecycleFixture = await readFixture('firebase-suite-v1/suite-startup-readiness-shutdown-and-restart/fixture.json');
  const project = lifecycleFixture.targetProject;
  for (const fixture of [functionsFixture, pubsubFixture, hubFixture, uiFixture]) assert.equal(fixture.targetProject, project);

  const tmp = await mkdtemp('/tmp/fnsr-');
  const suiteRoot = await mkdtemp(join(tmp, 'suite-'));
  const roots = [...new Set([suiteRoot, await realpath(suiteRoot)])];
  const ports = await reservePorts(['auth', 'eventarc', 'functions', 'hub', 'logging', 'pubsub', 'tasks', 'ui']);
  const normalize = normalizer(roots, ports);
  const eventsPath = join(suiteRoot, 'function-events.jsonl');
  const functionsDir = join(suiteRoot, 'functions');
  const exportPath = join(suiteRoot, 'hub-export');
  const locator = join(tmp, `hub-${project}.json`);

  // The capture's synthetic project (`writeSyntheticProject`).
  await mkdir(functionsDir, { recursive: true });
  await writeFile(join(functionsDir, 'package.json'), `${JSON.stringify({
    name: 'firenook-phase4-suite-oracle-functions', version: '0.0.0', private: true, main: 'index.js', engines: { node: '24' },
    dependencies: { 'firebase-admin': '13.10.0', 'firebase-functions': '7.2.5' },
  }, null, 2)}\n`);
  await linkSdk(functionsDir);
  await writeFile(join(functionsDir, 'index.js'), `
const fs = require("node:fs");
const { onCall, onRequest, HttpsError } = require(${JSON.stringify(join(functionsRoot, 'lib/v2/providers/https.js'))});
const { onSchedule } = require(${JSON.stringify(join(functionsRoot, 'lib/v2/providers/scheduler.js'))});
const { onMessagePublished } = require(${JSON.stringify(join(functionsRoot, 'lib/v2/providers/pubsub.js'))});
const capturePath = ${JSON.stringify(eventsPath)};
function record(value) {
  fs.appendFileSync(capturePath, JSON.stringify(value) + "\\n", "utf8");
}
exports.httpEcho = onRequest((request, response) => {
  response.status(200).json({
    method: request.method,
    query: request.query,
    body: request.body,
    unicode: "火🔥",
  });
});
exports.callableEcho = onCall((request) => {
  if (request.data && request.data.fail === true) {
    throw new HttpsError("invalid-argument", "phase4 invalid", { unicode: "火🔥" });
  }
  return { echo: request.data, authUid: request.auth ? request.auth.uid : null, unicode: "火🔥" };
});
exports.scheduledTick = onSchedule("every 5 minutes", (event) => {
  record({ kind: "schedule", id: event.id, time: event.time, data: event.data || null });
});
exports.topicEcho = onMessagePublished("phase4-topic", (event) => {
  const message = event.data && event.data.message;
  record({
    kind: "topic",
    id: event.id,
    time: event.time,
    data: message && message.data ? Buffer.from(message.data, "base64").toString("utf8") : null,
    attributes: message ? message.attributes || {} : {},
  });
});
`.trimStart());
  await writeFile(join(suiteRoot, 'firebase.json'), `${JSON.stringify({
    functions: [{ source: 'functions', codebase: 'phase4-oracle' }],
    emulators: {
      auth: { host: HOST, port: ports.auth }, eventarc: { host: HOST, port: ports.eventarc }, functions: { host: HOST, port: ports.functions },
      hub: { host: HOST, port: ports.hub }, logging: { host: HOST, port: ports.logging }, pubsub: { host: HOST, port: ports.pubsub },
      tasks: { host: HOST, port: ports.tasks }, ui: { enabled: true, host: HOST, port: ports.ui }, singleProjectMode: true,
    },
  }, null, 2)}\n`);

  const start = { binary, projectDir: suiteRoot, project, only: 'auth,functions,pubsub', ports, tmp };
  let suite;
  const suiteCases = [];
  const functionsCases = [];
  const pubsubCases = [];
  try {
    suite = await startSuite(start);
    const first = await readiness(suite, ports, project);
    // The recorded start-up took 18 s; time is not compared (it is the host's).
    suiteCases.push(['suite-startup-readiness-shutdown-and-restart/first-start', differences({ statuses: lifecycleFixture.firstReadiness.statuses, backendCount: lifecycleFixture.firstReadiness.backendCount, functionTriggerCount: lifecycleFixture.firstReadiness.functionTriggerCount }, first), ledger.COMPARED.behaviour]);

    // captureFunctions
    const functions = `http://${HOST}:${ports.functions}`;
    const callable = `/${project}/us-central1/callableEcho`;
    for (const [id, method, path, body] of [
      ['functions-backends', 'GET', '/backends'],
      ['http-function-get', 'GET', `/${project}/us-central1/httpEcho?mode=get`],
      ['http-function-post', 'POST', `/${project}/us-central1/httpEcho`, { unicode: '火🔥', nested: { n: 4 } }],
      ['callable-success', 'POST', callable, { data: { unicode: '火🔥', n: 4 } }],
      ['callable-typed-error', 'POST', callable, { data: { fail: true } }],
      ['callable-invalid-get', 'GET', callable],
      ['unknown-function', 'POST', `/${project}/us-central1/missingFunction`, { data: {} }],
    ]) {
      const recorded = functionsFixture.observations.find((observation) => observation.id === id);
      assert.equal(recorded.path, path);
      const answer = await requestJson(functions, method, path, body);
      functionsCases.push([`functions-callable-http-and-error-contract/${id}`, compareObservation(recorded, answer, normalize), ledger.COMPARED.answer]);
    }

    // capturePubsubAndSchedules
    const pubsub = `http://${HOST}:${ports.pubsub}`;
    const hub = `http://${HOST}:${ports.hub}`;
    const observe = async (id, base, method, path, body, headers) => {
      const recorded = pubsubFixture.observations.find((observation) => observation.id === id);
      assert.equal(recorded.path, path, id);
      const answer = await requestJson(base, method, path, body, headers);
      pubsubCases.push([`pubsub-schedule-and-function-dispatch/${id}`, compareObservation(recorded, answer, normalize), ledger.COMPARED.answer]);
      return answer;
    };
    const topics = await observe('list-function-topics', pubsub, 'GET', `/v1/projects/${project}/topics`);
    const names = (topics.body?.topics ?? []).map((topic) => topic.name).sort();
    const scheduleTopic = names.find((name) => name.includes('firebase-schedule-scheduledTick'));
    const customTopic = names.find((name) => name.endsWith('/topics/phase4-topic'));
    assert.ok(scheduleTopic && customTopic, JSON.stringify(names));
    await observe('publish-custom-topic', pubsub, 'POST', `/v1/${customTopic}:publish`, { messages: [{ data: Buffer.from('topic 火🔥').toString('base64'), attributes: { oracle: 'phase4' } }] });
    await observe('publish-schedule-topic', pubsub, 'POST', `/v1/${scheduleTopic}:publish`, { messages: [{ data: Buffer.from('{}').toString('base64') }] });
    await waitForEvents(eventsPath, 1);
    await delay(250);
    const afterTopics = await readEvents(eventsPath);
    // SCHEDULE_TOPIC_DELIVERY: Firenook delivers the schedule topic's
    // publish to the scheduled function; the official emulator recorded no
    // delivery (`schedulePubsubDeliverySupported: false`).
    const scheduleTopicDeliveries = afterTopics.filter((event) => event.kind === 'schedule');
    assert.equal(scheduleTopicDeliveries.length, 1, 'SCHEDULE_TOPIC_DELIVERY no longer happens: drop it from the findings');
    // The delivery is the schedule event delivered before the direct
    // invocation: it is left out, once, from what is compared below.
    const withoutTopicSchedule = (events) => {
      const index = events.findIndex((event) => event.kind === 'schedule');
      return index < 0 ? events : [...events.slice(0, index), ...events.slice(index + 1)];
    };
    const direct = `/functions/projects/${project}/triggers/us-central1-scheduledTick-0`;
    await observe('invoke-schedule-cloudevent-directly', functions, 'POST', direct, {
      specversion: '1.0', id: 'phase4-schedule-oracle', source: `//pubsub.googleapis.com/projects/${project}/topics/firebase-schedule-scheduledTick`,
      type: 'google.cloud.pubsub.topic.v1.messagePublished', time: '2026-01-02T03:04:05.000Z', data: {},
    }, { 'content-type': 'application/cloudevents+json; charset=UTF-8' });
    await waitForEvents(eventsPath, afterTopics.length + 1);
    const beforeDisable = await readEvents(eventsPath);
    await observe('disable-background-triggers', hub, 'PUT', '/functions/disableBackgroundTriggers', {});
    await observe('publish-while-disabled', pubsub, 'POST', `/v1/${customTopic}:publish`, { messages: [{ data: Buffer.from('disabled').toString('base64') }] });
    await delay(750);
    const afterDisabled = await readEvents(eventsPath);
    await observe('enable-background-triggers', hub, 'PUT', '/functions/enableBackgroundTriggers', {});
    await observe('publish-after-reenable', pubsub, 'POST', `/v1/${customTopic}:publish`, { messages: [{ data: Buffer.from('reenabled 火').toString('base64') }] });
    await waitForEvents(eventsPath, beforeDisable.length + 1);
    const delivered = await readEvents(eventsPath);
    // What the functions saw, as recorded: the topic publish only (the
    // schedule topic's publish reaches no function), the direct schedule
    // invocation, nothing while disabled, the publish after re-enabling.
    const invariants = pubsubFixture.invariants;
    const kinds = (events) => withoutTopicSchedule(events).map((event) => event.kind).sort();
    assert.deepEqual(kinds(afterTopics), invariants.pubsubPublishedEventKinds);
    assert.deepEqual(kinds(beforeDisable), invariants.initialDeliveredEventKinds);
    assert.equal(afterDisabled.length - beforeDisable.length, invariants.disabledPublishAddedEvents);
    assert.equal(delivered.length - afterDisabled.length, invariants.reenabledPublishAddedEvents);
    // Event ids are generated per run (the recorded ones are UUIDs).
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
    const eventView = (events) => normalize(events).map((event) => ({ ...event, ...(typeof event.id === 'string' && uuid.test(event.id) ? { id: '<event-id>' } : {}) }));
    assert.deepEqual(eventView(withoutTopicSchedule(delivered)), eventView(pubsubFixture.deliveredEvents), 'the events the functions saw');

    // captureHub
    const auth = `http://${HOST}:${ports.auth}`;
    const hubCase = async (id, answer) => {
      const recorded = hubFixture.observations.find((observation) => observation.id === id);
      suiteCases.push([`hub-locator-export-and-background-controls/${id}`, compareObservation(recorded, answer, normalize), ledger.COMPARED.answer]);
    };
    await hubCase('hub-locator', await requestJson(hub, 'GET', '/'));
    await hubCase('hub-emulator-map', await requestJson(hub, 'GET', '/emulators'));
    await hubCase('create-export-user', await requestJson(auth, 'POST', `/identitytoolkit.googleapis.com/v1/projects/${project}/accounts`,
      { localId: 'phase4-hub-export-user', email: 'phase4-hub-export@example.com', displayName: 'Hub 火🔥', emailVerified: true }, { authorization: 'Bearer owner' }));
    const exported = await requestJson(hub, 'POST', '/_admin/export', { path: exportPath, initiatedBy: 'phase4-oracle', targets: ['auth'] });
    await hubCase('hub-auth-export', exported);
    await hubCase('hub-export-origin-blocked', await requestJson(hub, 'POST', '/_admin/export', { path: `${exportPath}-blocked`, targets: ['auth'] }, { origin: 'https://example.invalid' }));
    // The export the hub wrote: the recorded files and their contents
    // (account times are this run's, as the capture replaced them).
    const files = (await inventory(exportPath, normalize)).map((entry) => (entry.json ? { ...entry, json: exportedTimes(entry.json) } : entry));
    const recordedFiles = hubFixture.exportInventory.map(({ path, json }) => (json === undefined ? { path } : { path, json }));
    const exportFound = differences(recordedFiles, files, 'export');
    const exportIndex = suiteCases.findIndex(([id]) => id.endsWith('/hub-auth-export'));
    suiteCases[exportIndex][1].push(...exportFound);
    assert.equal(await exists(`${exportPath}-blocked`), false, 'a refused export writes nothing');

    // captureUiAndLogging
    const ui = `http://${HOST}:${ports.ui}`;
    const uiCase = (id, answer) => {
      const recorded = uiFixture.observations.find((observation) => observation.id === id);
      suiteCases.push([`ui-config-logging-and-websocket/${id}`, compareObservation(recorded, answer, normalize), ledger.COMPARED.answer]);
    };
    uiCase('ui-api-config', await requestJson(ui, 'GET', '/api/config'));
    const index = await fetch(`${ui}/`, { redirect: 'manual' });
    const html = await index.text();
    uiCase('ui-index-html', { status: index.status, headers: index.headers, body: { location: index.headers.get('location'), containsRootElement: html.includes('id="root"') } });
    // The logging feed replays its history on connect; the recorded three
    // messages are looked for in it, in their order.
    const messages = [];
    const socket = new WebSocket(`ws://${HOST}:${ports.logging}`);
    socket.addEventListener('message', (event) => { try { messages.push(JSON.parse(String(event.data))); } catch { /* JSON only */ } });
    await once(socket, 'open');
    await delay(1_000);
    socket.close();
    let from = 0;
    uiFixture.websocketMessages.forEach((recorded, index) => {
      const view = (message) => ({ ...normalize(message), timestamp: '<generated-timestamp>' });
      const found = messages.slice(from).findIndex((message) => JSON.stringify(view(message)) === JSON.stringify(recorded));
      const id = `ui-config-logging-and-websocket/logging-websocket/${index + 1}`;
      const worded = messages.map(view).find((message) => message.level === recorded.level && message.message !== recorded.message && message.message.endsWith(recorded.message));
      if (found < 0 && worded) suiteCases.push([id, [`worded ${JSON.stringify(worded.message)} where ${JSON.stringify(recorded.message)}`], ledger.COMPARED.answer]);
      else if (found < 0) suiteCases.push([id, [`not in the feed's ${messages.length} messages: ${recorded.level} ${recorded.message}`], ledger.COMPARED.answer]);
      else {
        from += found + 1;
        suiteCases.push([id, [], ledger.COMPARED.answer]);
      }
    });

    // The first stop (the run in which the origin guard refused an export),
    // then the same suite again on the same ports, then a second stop.
    const firstStop = await stopSuite(suite, ports, locator);
    suite = undefined;
    suiteCases.push(['suite-startup-readiness-shutdown-and-restart/first-stop', differences(lifecycleFixture.firstStop, firstStop), ledger.COMPARED.behaviour]);
    suite = await startSuite(start);
    const restart = await readiness(suite, ports, project);
    suiteCases.push(['suite-startup-readiness-shutdown-and-restart/restart', differences({ statuses: lifecycleFixture.restartReadiness.statuses, backendCount: lifecycleFixture.restartReadiness.backendCount, functionTriggerCount: lifecycleFixture.restartReadiness.functionTriggerCount }, restart), ledger.COMPARED.behaviour]);
    suiteCases.push(['suite-startup-readiness-shutdown-and-restart/restart-hub-readiness', compareObservation(lifecycleFixture.restartHub, await requestJson(hub, 'GET', '/'), normalize), ledger.COMPARED.answer]);
    const secondStop = await stopSuite(suite, ports, locator);
    suite = undefined;
    suiteCases.push(['suite-startup-readiness-shutdown-and-restart/second-stop', differences(lifecycleFixture.secondStop, secondStop), ledger.COMPARED.behaviour]);
  } finally {
    await forceStop(suite);
    if (process.env.SUITE_REPLAY_REPORT) console.log(JSON.stringify({ suiteCases, functionsCases, pubsubCases }, null, 1));
    await rm(tmp, { recursive: true, force: true });
  }
  settle(SUITE, suiteCases, { differs: SUITE_DIFFERS, bugs: SUITE_BUGS });
  settle(FUNCTIONS_SET, functionsCases, { differs: FUNCTIONS_DIFFERS, bugs: FUNCTIONS_BUGS });
  settle(PUBSUB_SET, pubsubCases, { bugs: PUBSUB_BUGS });
  assert.equal(suiteCases.length, 15);
  // The header difference HEADER_ONLY names is still what it says.
  assert.ok([...suiteCases, ...pubsubCases].some(([, found]) => found.some((difference) => HEADER_ONLY[0].test(difference))), 'HEADER_ONLY no longer observed');
});

/** A Functions project of the given codebases: `{ name: source }`. */
async function functionsProject(projectDir, codebases, extra = {}) {
  for (const [codebase, source] of Object.entries(codebases)) {
    const directory = join(projectDir, codebase);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `synthetic-${codebase}`, main: 'index.js', engines: { node: '24' } }));
    await linkSdk(directory);
    await writeFile(join(directory, 'index.js'), source);
  }
  await writeFile(join(projectDir, 'firebase.json'), JSON.stringify({
    functions: Object.keys(codebases).map((codebase) => ({ source: codebase, codebase })),
    ...extra,
  }));
}

// ------------------------- developer-tools-functions-lifecycle-v1 shutdown

test('the Functions emulator stops cleanly on SIGINT after one HTTP invocation', { timeout: 300_000, skip: functionsRoot ? false : 'FIREBASE_FUNCTIONS_7_2_ROOT is not set' }, async () => {
  const fixture = await readFixture('developer-tools-functions-lifecycle-v1/fixture.json');
  const project = fixture.exchange.path.split('/')[1];
  const tmp = await mkdtemp('/tmp/fnlc-');
  const projectDir = await mkdtemp(join(tmp, 'project-'));
  const ports = await reservePorts(['functions', 'hub', 'eventarc', 'tasks']);
  let suite;
  try {
    await functionsProject(projectDir, { synthetic: fixture.source });
    suite = await startSuite({ binary: await engine(), projectDir, project, only: 'functions', ports, tmp, ui: false });
    const response = await requestJson(`http://${HOST}:${ports.functions}`, 'GET', fixture.exchange.path);
    assert.equal(response.status, fixture.exchange.status);
    assert.deepEqual(response.body, fixture.exchange.body);
    ledger.checked('developer-tools-functions-lifecycle-v1', 'invoke', ledger.COMPARED.answer);
    // SIGINT after the invocation, as the capture stopped the CLI. The
    // recorded 34 ms is the host's and is not compared; the exit is.
    const stop = await stopSuite(suite, ports, join(tmp, `hub-${project}.json`));
    suite = undefined;
    assert.deepEqual([stop.exitCode, stop.signalCode], fixture.exit, 'the recorded exit');
    assert.ok(stop.portsClosed, 'every port closed');
    ledger.checked('developer-tools-functions-lifecycle-v1', 'shutdown', ledger.COMPARED.behaviour);
  } finally {
    await forceStop(suite);
    await rm(tmp, { recursive: true, force: true });
  }
});

// --------------------- firebase-suite-v1 functions-startup-discovery

/**
 * `prior-adapter-double-discovery` recorded the official host when the
 * adapter Firenook once wrapped it in called discovery itself before the
 * host's own `connect()`. Firenook's runtime discovers once at start-up
 * (DESIGN.md, Functions readiness: "the single discovery owned by
 * connect(), not a second execution of user code").
 */
const DOUBLE_DISCOVERY = 'Firenook discovers a codebase once at start-up (DESIGN.md: the single discovery owned by connect(), not a second execution of user code); the recorded mode is the prior adapter calling discovery a second time';

test('Functions discovery runs once at start-up and again after a source change', { timeout: 300_000, skip: functionsRoot ? false : 'FIREBASE_FUNCTIONS_7_2_ROOT is not set' }, async () => {
  const fixture = await readFixture('firebase-suite-v1/functions-startup-discovery/fixture.json');
  const project = fixture.projectId;
  const tmp = await mkdtemp('/tmp/fnsd-');
  const projectDir = await mkdtemp(join(tmp, 'project-'));
  const ports = await reservePorts(['functions', 'hub', 'eventarc', 'tasks']);
  const discoveries = join(projectDir, 'discoveries.log');
  // The capture's source; the first line counts each load the SDK's
  // discovery makes (it runs with FUNCTIONS_CONTROL_API=true), as the
  // capture counted the host's discoverTriggers calls.
  const source = (version) => `if(process.env.FUNCTIONS_CONTROL_API==='true')require('node:fs').appendFileSync(${JSON.stringify(discoveries)},'discovery\\n');\nconst {onRequest}=require('firebase-functions/v2/https');\nexports.alpha=onRequest((req,res)=>res.json({version:${version},unicode:'火🔥'}));\n${version === 2 ? 'exports.beta=onRequest((req,res)=>res.json({added:true}));\n' : ''}`;
  const count = async () => (await readFile(discoveries, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  let suite;
  try {
    await functionsProject(projectDir, { oracle: source(1) });
    suite = await startSuite({ binary: await engine(), projectDir, project, only: 'functions', ports, tmp, ui: false });
    const functions = `http://${HOST}:${ports.functions}`;
    const startupCalls = await count();
    const initial = await requestJson(functions, 'GET', `/${project}/us-central1/alpha`);
    assert.equal(initial.status, 200);
    await delay(1_200);
    await writeFile(join(projectDir, 'oracle/index.js'), source(2));
    const ids = async () => ((await requestJson(functions, 'GET', '/backends')).body.backends ?? []).flatMap((backend) => backend.functionTriggers.map((trigger) => trigger.id)).sort();
    assert.ok(await waitFor(async () => (await ids()).includes('us-central1-beta'), 30_000), 'the source watcher rediscovered');
    const added = await requestJson(functions, 'GET', `/${project}/us-central1/beta`);
    assert.deepEqual([added.status, added.body], [200, { added: true }]);
    const observed = { startupCalls, initial: initial.body, afterReloadIds: await ids(), sourceWatcherRediscovered: (await count()) > startupCalls };
    // One start serves both recorded modes: they differ only in the call
    // the prior adapter made before the host's own, which has no Firenook
    // counterpart.
    for (const recorded of fixture.observations) {
      const expected = { startupCalls: recorded.startupCalls, initial: recorded.initial, afterReloadIds: recorded.afterReloadIds, sourceWatcherRediscovered: recorded.sourceWatcherRediscovered };
      const found = differences(expected, observed);
      const id = `functions-startup-discovery/${recorded.mode}`;
      if (recorded.mode === 'prior-adapter-double-discovery') {
        assert.deepEqual(found, ['.startupCalls: 1 where 2'], id);
        ledger.differs(FUNCTIONS_SET, id, ledger.COMPARED.behaviour, DOUBLE_DISCOVERY);
      } else {
        assert.deepEqual(found, [], id);
        ledger.checked(FUNCTIONS_SET, id, ledger.COMPARED.behaviour);
      }
    }
  } finally {
    await forceStop(suite);
    await rm(tmp, { recursive: true, force: true });
  }
});

// ----------------------------------------------------- functions-readiness-v1

const READINESS = 'functions-readiness-v1';

/**
 * `missing-auxiliary` started the official host with no Eventarc or Tasks
 * peer, so their two handlers were recorded `ignored`. Firenook always runs
 * both with Functions (DESIGN.md, Service selection: "Eventarc and Tasks
 * follow Functions"), so the same project registers all four.
 */
const MISSING_PEERS = 'Eventarc and Tasks always run with Functions (DESIGN.md, Service selection), so the task and event handlers are registered where the official host without those peers ignored them; the inventory matches';

/** The engine's READY receipt: what it admitted and ignored (DESIGN.md, Functions readiness). */
function receipt(log) {
  const line = log.split('\n').find((text) => text.startsWith('FIRENOOK_FUNCTIONS_HOST_READY '));
  assert.ok(line, 'a READY receipt');
  return JSON.parse(line.slice('FIRENOOK_FUNCTIONS_HOST_READY '.length));
}

/**
 * The recorded predefined backends were built by hand and given to the
 * official host (the capture's `predefinedTriggers`, the http codebase's
 * directory and an empty env). The same resources as a local extension
 * instance, the input Firenook reads, have the instance's directory, its
 * spec and auto parameters, and functions named `ext-<instance>-<resource>`,
 * as an installed instance's are; the rest is compared.
 */
function predefinedView(inventory, instance) {
  return inventory.backends.map((backend) => ({
    extensionInstanceId: backend.extensionInstanceId,
    functionTriggers: backend.functionTriggers.map((trigger) => ({ ...trigger, name: trigger.name.replace(`ext-${instance}-`, '') })),
  }));
}

test('Functions start-up: inventory and registrations for every recorded mode', { timeout: 300_000, skip: functionsRoot ? false : 'FIREBASE_FUNCTIONS_7_2_ROOT is not set' }, async () => {
  const fixture = await readFixture('functions-readiness-v1/fixture.json');
  const project = fixture.projectId;
  const binary = await engine();
  for (const recorded of fixture.observations) {
    const { mode } = recorded;
    const tmp = await mkdtemp('/tmp/fnrd-');
    const projectDir = await mkdtemp(join(tmp, 'workspace-'));
    const ports = await reservePorts(['functions', 'hub', 'eventarc', 'tasks']);
    let suite;
    try {
      const { http, auxiliary, broken } = fixture.sources;
      const predefined = { 'predefined-backend': 'synthetic-extension', 'unsupported-predefined': 'synthetic-unsupported-extension' }[mode];
      if (mode === 'healthy' || mode === 'missing-auxiliary') await functionsProject(projectDir, { http, auxiliary });
      else if (mode === 'failed-codebase') await functionsProject(projectDir, { http, broken });
      else if (mode === 'colliding-backends') {
        await functionsProject(projectDir, { http });
        await writeFile(join(projectDir, 'firebase.json'), JSON.stringify({ functions: [{ source: 'http', codebase: 'http' }, { source: 'http', codebase: 'collision' }] }));
      } else {
        // The recorded resources: an HTTPS one, and for the unsupported mode
        // one whose only trigger is a task queue.
        const resource = (name, trigger) => `  - name: ${name}\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: us-central1\n      runtime: nodejs20\n      ${trigger}: {}\n`;
        const resources = resource('alpha', 'httpsTrigger') + (mode === 'unsupported-predefined' ? resource('full', 'taskQueueTrigger') : '');
        const extension = join(projectDir, 'extensions-local', predefined);
        await mkdir(join(extension, 'functions'), { recursive: true });
        await writeFile(join(extension, 'extension.yaml'), `name: ${predefined}\nversion: 0.0.1\nspecVersion: v1beta\nresources:\n${resources}`);
        await writeFile(join(extension, 'POSTINSTALL.md'), '# Synthetic\n');
        await writeFile(join(extension, 'functions/package.json'), JSON.stringify({ name: predefined, main: 'index.js', engines: { node: '24' } }));
        await linkSdk(join(extension, 'functions'));
        await writeFile(join(extension, 'functions/index.js'), http);
        // The instance's parameter file; it has no parameters.
        await mkdir(join(projectDir, 'extensions'), { recursive: true });
        await writeFile(join(projectDir, 'extensions', `${predefined}.env`), '');
        await writeFile(join(projectDir, 'firebase.json'), JSON.stringify({ extensions: { [predefined]: `./extensions-local/${predefined}` } }));
      }
      suite = await startSuite({ binary, projectDir, project, only: 'functions', ports, tmp, ui: false, mayExit: true });
      assert.equal(suite.refused, undefined, `${mode}: the official host started (connectError ${recorded.connectError}); Firenook did not:\n${suite.log}`);
      const backends = await requestJson(`http://${HOST}:${ports.functions}`, 'GET', '/backends');
      assert.equal(backends.status, recorded.status, mode);
      // The capture replaced its workspace directory with <workspace>.
      let inventory = JSON.stringify(backends.body);
      for (const path of new Set([await realpath(projectDir), projectDir])) inventory = inventory.replaceAll(path, '<workspace>');
      inventory = JSON.parse(inventory);
      // The official records: every discovered handler, `ignored` where the
      // host could not register it. Firenook's READY receipt counts the
      // same: what it listed, and what of that it ignored.
      const counts = receipt(suite.log);
      const records = { listed: counts.inventoryCount, ignored: counts.ignoredCount };
      const expectedRecords = { listed: recorded.triggerRecords.length, ignored: recorded.triggerRecords.filter((record) => record.ignored).length };
      const id = `startup/${mode}`;
      if (predefined) {
        assert.deepEqual(predefinedView(inventory, predefined), predefinedView(recorded.inventory, predefined), `${mode}: the predefined backend`);
        assert.deepEqual(records, expectedRecords, `${mode}: records`);
        ledger.checked(READINESS, id, ledger.COMPARED.behaviour);
      } else if (mode === 'missing-auxiliary') {
        assert.deepEqual(differences(recorded.inventory, inventory), [], `${mode}: inventory`);
        assert.deepEqual(records, { listed: expectedRecords.listed, ignored: 0 }, `${mode}: every handler registered`);
        assert.equal(expectedRecords.ignored, 2);
        ledger.differs(READINESS, id, ledger.COMPARED.answer, MISSING_PEERS);
      } else {
        assert.deepEqual(differences(recorded.inventory, inventory), [], `${mode}: inventory`);
        assert.deepEqual(records, expectedRecords, `${mode}: records`);
        ledger.checked(READINESS, id, ledger.COMPARED.answer);
      }
      if (mode === 'healthy') {
        // The registrations the recorded host sent its Eventarc and Tasks
        // peers, sent as recorded to Firenook's.
        for (const { name, fixture: exchanges } of fixture.auxiliary) {
          const [exchange] = exchanges.exchanges;
          const port = name === 'eventarc' ? ports.eventarc : ports.tasks;
          const response = await fetch(`http://${HOST}:${port}${exchange.request.uri}`, {
            method: exchange.request.method,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(exchange.request.bodyBase64, 'base64'),
          });
          const body = await response.text();
          assert.equal(response.status, exchange.response.status, name);
          assert.deepEqual(JSON.parse(body), JSON.parse(Buffer.from(exchange.response.bodyBase64, 'base64').toString('utf8')), name);
          ledger.checked(READINESS, `auxiliary/${name}/1`, ledger.COMPARED.answer);
        }
      }
    } finally {
      await forceStop(suite);
      await rm(tmp, { recursive: true, force: true });
    }
  }
});
