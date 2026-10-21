import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { capabilities, createInk, interactive, width, wrap } from '../packages/cli/src/terminal.mjs';
import { EVENT_PREFIX, expectedOpening, functionName, holderName, loadError, runInteractive, shortPath, structured } from '../packages/cli/src/session.mjs';
import { cacheFile, channelOf, installCommand, newer, pendingUpdate, refreshUpdates, updatesOff } from '../packages/cli/src/updates.mjs';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;.*?\x1b\\/g;
const plain = text => text.replace(ANSI, '');
// The words on screen, wherever a card's borders and line breaks cut them.
const flat = text => text.replace(/[│╭╮╰╯├┤─]/g, ' ').replace(/\s+/g, ' ');
const shows = (shown, expected) => assert.ok(flat(shown).includes(flat(expected)), `${expected} in:\n${shown}`);

test('the terminal UI draws only for emulators:start in a terminal', () => {
  const tty = {isTTY: true};
  assert.equal(interactive({stdout: tty, stdin: tty, env: {}}), true);
  assert.equal(interactive({stdout: {}, stdin: tty, env: {}}), false, 'a pipe');
  assert.equal(interactive({stdout: tty, stdin: {}, env: {}}), false, 'no keyboard');
  assert.equal(interactive({stdout: tty, stdin: tty, env: {CI: 'true'}}), false);
  assert.equal(interactive({stdout: tty, stdin: tty, env: {TERM: 'dumb'}}), false);
  assert.equal(interactive({stdout: tty, stdin: tty, env: {FIRENOOK_PLAIN: '1'}}), false);
  assert.equal(interactive({stdout: tty, stdin: tty, env: {FIRENOOK_PLAIN: '0'}}), true);
  assert.equal(interactive({stdout: tty, stdin: tty, env: {}, plain: true}), false, '--plain');
  assert.equal(interactive({stdout: tty, stdin: tty, env: {}, mode: 'exec'}), false, 'the test command shares the terminal');
});

test('colours, symbols and links follow the terminal', () => {
  assert.deepEqual(capabilities({env: {COLORTERM: 'truecolor'}, platform: 'darwin'}),
    {colour: true, truecolour: true, palette256: false, ascii: false, hyperlinks: true});
  assert.equal(capabilities({env: {NO_COLOR: ''}, platform: 'darwin'}).colour, false);
  assert.equal(capabilities({env: {TERM: 'xterm-256color'}, platform: 'linux'}).palette256, true);
  assert.equal(capabilities({env: {}, platform: 'win32'}).ascii, true, 'the old console');
  assert.equal(capabilities({env: {WT_SESSION: '1'}, platform: 'win32'}).ascii, false, 'Windows Terminal');
  assert.equal(capabilities({env: {TERM: 'linux'}, platform: 'linux'}).hyperlinks, false);
});

test('lines are measured as the terminal lays them out, and never outgrow their room', () => {
  const ink = createInk(capabilities({env: {COLORTERM: 'truecolor'}, platform: 'darwin'}));
  assert.equal(width(ink.bold(ink.green('ready'))), 5);
  assert.equal(width(ink.link('http://127.0.0.1:4000/console')), 29);
  assert.equal(width('中文'), 4);
  const cut = ink.fit(`${ink.dim('a long label')} that goes on`, 10);
  assert.equal(width(cut), 10);
  assert.ok(plain(cut).endsWith('…'));
  assert.ok(cut.endsWith('\x1b[0m\x1b]8;;\x1b\\'), 'a cut line closes its styles and links');
  assert.deepEqual(wrap('order charged for the whole basket', 14), ['order charged', 'for the whole', 'basket']);
  assert.deepEqual(wrap('one\ntwo', 10), ['one', 'two']);
});

test('a function line keeps its logger level, message and fields', () => {
  assert.deepEqual(structured('{"severity":"WARNING","message":"low stock","sku":"A1"}'), {level: 'warn', text: 'low stock', fields: {sku: 'A1'}});
  assert.deepEqual(structured('{"severity":"INFO","message":"done","logging.googleapis.com/labels":{}}'), {level: 'info', text: 'done', fields: undefined});
  assert.deepEqual(structured('plain words', 'error'), {level: 'error', text: 'plain words'});
  assert.deepEqual(structured('{not json'), {level: 'info', text: '{not json'});
  assert.equal(functionName('us-central1-onOrderCreated', 'default'), 'onOrderCreated');
  assert.equal(functionName('us-central1-ext-firestore-stripe-payments-createCustomer', 'firestore-stripe-payments'), 'createCustomer');
  assert.equal(functionName('europe-west1-api'), 'api');
});

test('a load error says where it is and shows the code frame once', () => {
  const error = loadError({message: "SyntaxError: Unexpected token '}'",
    detail: "./functions/src/orders.js:42\n  }}\n  ^\n\nSyntaxError: Unexpected token '}'\n    at wrapSafe (node:internal/modules/cjs/loader:1469:18)"});
  assert.deepEqual(error, {message: "SyntaxError: Unexpected token '}'", where: 'functions/src/orders.js:42', frame: ['  }}', '  ^']});
  assert.deepEqual(loadError({message: 'Error: boom', detail: null}), {message: 'Error: boom', where: undefined, frame: []});
  // The runtime's first line is general; the error Node names is the one shown.
  assert.deepEqual(loadError({message: 'Functions codebase could not be analyzed successfully. It may have a syntax or runtime error',
    detail: "./functions/index.js:17\n  }}\n  ^\n\nSyntaxError: Unexpected token '}'\n    at wrapSafe (node:internal/modules/cjs/loader:1469:18)"}),
  {message: "SyntaxError: Unexpected token '}'", where: 'functions/index.js:17', frame: ['  }}', '  ^']});
});

test('the banner knows how the data starts before the engine says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-terminal-'));
  const state = join(dir, 'state');
  mkdirSync(join(state, 'firestore'), {recursive: true});
  writeFileSync(join(state, 'firestore/firenook.redb'), '');
  const args = ['suite', '--state-dir', state, '--resume-state', '--import', join(dir, 'seed')];
  assert.equal(expectedOpening(args).kind, 'import', 'no receipt yet: the seed is imported');
  // A seed with no export in it is skipped, as the official CLI skips it.
  mkdirSync(join(dir, 'seed'));
  assert.equal(expectedOpening(args).kind, 'fresh', 'nothing to import: a fresh start');
  writeFileSync(join(dir, 'seed', 'firebase-export-metadata.json'), '{}');
  assert.equal(expectedOpening(args).kind, 'import');
  writeFileSync(join(state, 'native-state.json'), JSON.stringify({complete: true}));
  const resumed = expectedOpening(args);
  assert.equal(resumed.kind, 'resume');
  assert.ok(resumed.savedAtMs > 0);
  assert.deepEqual(expectedOpening(['suite', '--state-dir', state]), {kind: 'fresh'});
  assert.equal(shortPath(join(dir, 'state'), dir), 'state');
  assert.equal(holderName('java -jar cloud-firestore-emulator-v1.19.jar'), 'an official Firebase emulator');
  assert.equal(holderName('/usr/bin/python3 server.py'), undefined);
});

test('the update check follows the channel, compares versions and names the package manager', async () => {
  assert.equal(channelOf('0.2.0-next.3'), 'next');
  assert.equal(channelOf('1.0.0'), 'latest');
  assert.equal(newer('0.2.0-next.4', '0.2.0-next.3'), true);
  assert.equal(newer('0.2.0-next.10', '0.2.0-next.9'), true);
  assert.equal(newer('0.2.0', '0.2.0-next.9'), true);
  assert.equal(newer('0.2.0-next.3', '0.2.0-next.3'), false);
  assert.equal(newer('0.1.9', '0.2.0-next.1'), false);
  const project = mkdtempSync(join(tmpdir(), 'firenook-pm-'));
  assert.equal(installCommand(project, 'next'), 'npm i -D firenook@next');
  writeFileSync(join(project, 'bun.lock'), '');
  assert.equal(installCommand(project, 'next'), 'bun add -d firenook@next');
  assert.equal(updatesOff({CI: '1'}), true);
  assert.equal(updatesOff({FIRENOOK_NO_UPDATE_CHECK: '1'}), true);
  assert.equal(updatesOff({}), false);

  const env = {XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'firenook-cache-'))};
  let asked = 0;
  const fetcher = async () => { asked += 1; return {ok: true, json: async () => ({latest: '0.2.0-next.1', next: '0.2.0-next.9'})}; };
  assert.equal(pendingUpdate('0.2.0-next.3', project, {env}), undefined, 'nothing known yet');
  await refreshUpdates({env, fetcher, now: 1_000});
  assert.deepEqual(JSON.parse(readFileSync(cacheFile(env), 'utf8')).tags, {latest: '0.2.0-next.1', next: '0.2.0-next.9'});
  await refreshUpdates({env, fetcher, now: 2_000});
  assert.equal(asked, 1, 'at most once a day');
  await refreshUpdates({env, fetcher, now: 1_000 + 25 * 3600_000});
  assert.equal(asked, 2);
  assert.deepEqual(pendingUpdate('0.2.0-next.3', project, {env}), {version: '0.2.0-next.9', tag: 'next', command: 'bun add -d firenook@next'});
  assert.equal(pendingUpdate('0.2.0-next.9', project, {env}), undefined);
  assert.equal(pendingUpdate('0.2.0-next.3', project, {env: {...env, NO_UPDATE_NOTIFIER: '1'}}), undefined);
  assert.equal(await refreshUpdates({env: {...env, CI: 'true'}, fetcher, now: 10 * 24 * 3600_000}), undefined);
  assert.equal(asked, 2);
});

// ── The session against a scripted engine ──────────────────────────────

function screen(columns = 100, rows = 40) {
  const chunks = [];
  const out = new Writable({write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); }});
  Object.assign(out, {isTTY: true, columns, rows});
  return {out, text: () => plain(chunks.join(''))};
}
function keyboard() {
  const input = new EventEmitter();
  Object.assign(input, {isTTY: true, isRaw: false, setRawMode(on) { this.isRaw = on; }, resume() {}, pause() {}});
  return input;
}
function engine(play) {
  const spawned = [];
  const spawner = (binary, args) => {
    const child = new EventEmitter();
    Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null});
    let stopped;
    const stopping = new Promise(done => { stopped = done; });
    child.kill = signal => { stopped(signal); return true; };
    spawned.push({binary, args});
    const send = event => child.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
    (async () => {
      // A number is an exit code; {signal} ends the engine by that signal.
      const ended = await play({send, say: line => child.stderr.write(`${line}\n`), stopping});
      const [code, signal] = typeof ended === 'object' ? [null, ended.signal] : [ended, null];
      Object.assign(child, {exitCode: code, signalCode: signal});
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', code, signal), 5);
    })();
    return child;
  };
  return {spawner, spawned};
}
const launch = (args = []) => ({binary: '/fake/firenook', env: {}, cwd: '.', services: ['firestore', 'auth', 'functions'],
  args: ['suite', '--state-dir', '/tmp/firenook-terminal-state', '--host', '127.0.0.1', '--ui-port', '4000', '--firestore-port', '8080', '--auth-port', '9099', '--functions-port', '5001', '--hub-port', '4400', ...args]});
const env = {COLORTERM: 'truecolor', FIRENOOK_NO_UPDATE_CHECK: '1'};
const tick = ms => new Promise(done => setTimeout(done, ms));

test('a start draws the card, the ready summary and each call, and q stops it keeping the data', async () => {
  const {out, text} = screen();
  const input = keyboard();
  const {spawner, spawned} = engine(async ({send, say, stopping}) => {
    say('a line the start-up card stands in for');
    send({type: 'step', id: 'firestore', state: 'running', verb: 'starting'});
    send({type: 'step', id: 'firestore', state: 'done', ms: 12, figures: [[3, 'documents']]});
    send({type: 'step', id: 'auth', state: 'done', ms: 4, figures: [[1, 'users']]});
    send({type: 'codebase', codebase: {id: 'default', kind: 'user', state: 'ready', loads: 1, functionCount: 2, servingPrevious: false}});
    send({type: 'step', id: 'functions', state: 'done', ms: 300, figures: [[2, 'functions']]});
    send({type: 'ready', ms: 420, console: 'http://127.0.0.1:4000/console', ports: {firestore: 8080, auth: 9099, functions: 5001, hub: 4400}, functions: 2, warnings: ['a start-up warning']});
    await tick(30);
    const call = {id: 'n-1', functionId: 'us-central1-onOrderCreated', codebase: 'default', kind: 'firestore', summary: 'orders/A1 created', durationMs: 42, outcomeClass: 'succeeded'};
    send({type: 'call', state: 'started', call});
    send({type: 'log', level: 'info', source: 'functions', execution: 'n-1', message: '{"severity":"INFO","message":"order charged","orderId":"A1"}'});
    send({type: 'call', state: 'finished', call});
    say('an engine line with no event');
    await stopping;
    send({type: 'stopping'});
    send({type: 'stopped', outcome: {}});
    return 0;
  });
  const running = runInteractive(launch(), {version: '9.9.9-next.1', projectId: 'demo-terminal', demo: true, out, input, env, platform: 'darwin', spawner});
  for (let i = 0; i < 100 && !text().includes('order charged'); i += 1) await tick(20);
  assert.equal(input.isRaw, true, 'the keys are read raw');
  input.emit('data', Buffer.from('w'));
  await tick(30);
  input.emit('data', Buffer.from('q'));
  assert.equal(await running, 0);
  assert.equal(input.isRaw, false, 'the terminal is given back');
  assert.ok(spawned[0].args.includes('--terminal-events'));
  const shown = text();
  for (const expected of ['firenook  9.9.9-next.1', 'demo-terminal', 'Start-up', 'Firestore', '3 documents', '2 functions', 'All emulators ready',
    'http://127.0.0.1:4000/console', 'Firestore 8080', 'a start-up warning', 'onOrderCreated', 'orders/A1 created', 'order charged', 'orderId A1',
    'an engine line with no event', 'stopped', 'everything is kept in']) shows(shown, expected);
  assert.ok(!shown.includes('a line the start-up card stands in for'), 'start-up lines show only when the start fails');
  assert.ok(!shown.includes(EVENT_PREFIX), 'no event line reaches the screen');
});

test('a taken port says who holds it, how to free it and what became of the data, and exits 1', async () => {
  const {out, text} = screen();
  const {spawner} = engine(async ({send}) => {
    send({type: 'step', id: 'firestore', state: 'done', ms: 12, figures: [[3, 'documents']]});
    send({type: 'failed', kind: 'port', message: 'cannot bind auth at 127.0.0.1:9099: Address already in use (os error 48)', service: 'auth', host: '127.0.0.1', port: 9099, error: 'Address already in use (os error 48)'});
    return 1;
  });
  const holder = () => ({pid: 4412, program: 'java', command: 'java -jar cloud-firestore-emulator.jar'});
  const code = await runInteractive(launch(), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner, holder});
  assert.equal(code, 1);
  const shown = text();
  for (const expected of ['Firenook could not start', 'port 9099 is taken', 'port 9099 for Auth is held by java (PID 4412): an official Firebase emulator',
    'kill 4412', 'or give Auth a free port in firebase.json', '"emulators": { "auth": { "port":', 'Data', 'not started']) shows(shown, expected);
});

test('a start whose functions do not load still runs, and says so', async () => {
  const {out, text} = screen(110, 50);
  const input = keyboard();
  const {spawner} = engine(async ({send, stopping}) => {
    send({type: 'codebase', codebase: {id: 'default', kind: 'user', state: 'failed', loads: 1, functionCount: 0, servingPrevious: false, directory: 'functions',
      error: {message: "SyntaxError: Unexpected token '}'", detail: "./functions/index.js:3\n  }}\n  ^\n"}}});
    send({type: 'step', id: 'functions', state: 'done', ms: 30, figures: [[0, 'functions']]});
    send({type: 'ready', ms: 100, console: 'http://127.0.0.1:4000/console', ports: {}, functions: 0, warnings: []});
    await stopping;
    send({type: 'stopped', outcome: {}});
    return 0;
  });
  const running = runInteractive(launch(), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input, env, platform: 'darwin', spawner});
  for (let i = 0; i < 100 && !text().includes('except your functions'); i += 1) await tick(20);
  input.emit('data', Buffer.from('\x03'));
  assert.equal(await running, 0);
  const shown = text();
  for (const expected of ['Your functions did not load', 'functions/index.js:3', '}}', 'except your functions', 'functions not loaded']) shows(shown, expected);
});

test('a service that fails after readiness stops the session with a card that says so', async () => {
  const {out, text} = screen();
  const {spawner} = engine(async ({send}) => {
    send({type: 'step', id: 'firestore', state: 'done', ms: 5, figures: [[0, 'documents']]});
    send({type: 'ready', ms: 50, console: null, ports: {firestore: 8080}, functions: 0, warnings: []});
    await tick(40);
    send({type: 'failed', kind: 'other', message: 'the firestore listener failed: connection reset'});
    return 1;
  });
  const code = await runInteractive(launch(), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner});
  assert.equal(code, 1);
  const shown = text();
  for (const expected of ['All emulators ready', 'Firenook stopped', 'the firestore listener failed: connection reset', 'Data']) shows(shown, expected);
  assert.ok(!shown.includes('Firenook could not start'));
});

test('a repair after an unclean stop shows how far it has got, then the start goes on', async () => {
  const {out, text} = screen(110, 40);
  const input = keyboard();
  const {spawner} = engine(async ({send, stopping}) => {
    send({type: 'step', id: 'firestore', state: 'running', verb: 'resuming'});
    send({type: 'step', id: 'firestore', state: 'running', verb: 'repairing', done: 0, total: 1000, unit: 'percent', detail: 'after an unclean stop, 32.6 GB'});
    await tick(450);
    send({type: 'step', id: 'firestore', state: 'running', verb: 'repairing', done: 300, total: 1000, unit: 'percent', detail: 'after an unclean stop, 32.6 GB'});
    await tick(120);
    send({type: 'step', id: 'firestore', state: 'running', verb: 'resuming', done: null, total: null, unit: null, detail: null});
    await tick(60);
    send({type: 'step', id: 'firestore', state: 'done', ms: 900, figures: [[211310, 'documents']]});
    send({type: 'ready', ms: 950, console: 'http://127.0.0.1:4000/console', ports: {firestore: 8080}, functions: 0, warnings: []});
    await stopping;
    send({type: 'stopped', outcome: {}});
    return 0;
  });
  const running = runInteractive(launch(['--resume-state']), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input, env, platform: 'darwin', spawner});
  for (let i = 0; i < 100 && !text().includes('All emulators ready'); i += 1) await tick(20);
  input.emit('data', Buffer.from('q'));
  assert.equal(await running, 0);
  const shown = text();
  for (const expected of ['repairing 30%', 'after an unclean stop, 32.6 GB', '211,310 documents', 'All emulators ready']) shows(shown, expected);
});

test('a seed that changed names its files, and both ways on as commands', async () => {
  const {out, text} = screen(120, 50);
  const {spawner} = engine(async ({send}) => {
    send({type: 'step', id: 'data', state: 'running', verb: 'checking'});
    send({type: 'seed', whole: false, changed: ['firestore_export/output-0'], added: ['notes.json'], removed: [], counts: [4, 1, 0], finder: []});
    send({type: 'step', id: 'data', state: 'failed', ms: 40, message: 'refused'});
    send({type: 'failed', kind: 'state', message: 'native state refused: the seed /tmp/firenook-terminal-seed changed after it was imported: …; existing data preserved.', reason: 'the seed /tmp/firenook-terminal-seed changed after it was imported: …'});
    return 1;
  });
  const code = await runInteractive(launch(['--resume-state', '--import', '/tmp/firenook-terminal-seed']), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner});
  assert.equal(code, 1);
  const shown = text();
  for (const expected of ['Firenook could not start', 'the seed /tmp/firenook-terminal-seed changed after it was imported',
    'firestore_export/output-0 changed', 'and 3 more changed', 'notes.json added', 'to import the changed seed, start with a new --state-dir',
    // Too long for the card: one part a line, as the shell continues one.
    'firenook state:adopt-seed \\ --state-dir /tmp/firenook-terminal-state \\ --import /tmp/firenook-terminal-seed',
    'nothing was deleted']) shows(shown, expected);
});

test('data kept without a seed, and data kept from one, say which way on', async () => {
  const card = async (args, reason) => {
    const {out, text} = screen(120, 50);
    const {spawner} = engine(async ({send}) => {
      send({type: 'failed', kind: 'state', message: `native state refused: ${reason}; existing data preserved.`, reason});
      return 1;
    });
    assert.equal(await runInteractive(launch(args), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner}), 1);
    return text();
  };
  let shown = await card(['--resume-state', '--import', '/tmp/firenook-terminal-seed'], 'this data was started without a seed, so it cannot take the seed /tmp/firenook-terminal-seed: start without --import to keep using it');
  for (const expected of ['cannot take the seed', 'to keep using it, start without --import; to start from the seed, give it a new --state-dir', 'nothing was deleted']) shows(shown, expected);
  assert.ok(!shown.includes('to import the seed again'));
  shown = await card(['--resume-state'], 'it was imported from /tmp/firenook-terminal-seed: pass --import /tmp/firenook-terminal-seed to keep using it');
  for (const expected of ['to keep using it, start with its seed again:', '--import /tmp/firenook-terminal-seed']) shows(shown, expected);
  shown = await card([], 'this is saved data, started without a seed: pass --resume-state to keep using it');
  shows(shown, 'to keep using it, add --keep-data (or --resume-state); a fresh start needs a new --state-dir');
});

test('data an earlier engine saved, whose seed cannot be proven, points to adopting it', async () => {
  const {out, text} = screen(120, 50);
  const {spawner} = engine(async ({send}) => {
    send({type: 'seed', whole: true, changed: [], added: [], removed: [], counts: [0, 0, 0], finder: ['.DS_Store']});
    send({type: 'failed', kind: 'state', message: 'native state refused: the seed changed; existing data preserved.', reason: 'the seed changed'});
    return 1;
  });
  await runInteractive(launch(['--resume-state', '--import', '/tmp/firenook-terminal-seed']), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner});
  const shown = text();
  // Joined the platform's way: backslashes on Windows.
  for (const expected of ['kept one fingerprint for the whole seed', `${join('/tmp/firenook-terminal-seed', '.DS_Store')} (Finder writes this file)`, 'firenook state:adopt-seed']) shows(shown, expected);
});

test('a stop the engine never finished is no stop: the card says so and what the next start does', async () => {
  const {out, text} = screen(150);
  const input = keyboard();
  const {spawner} = engine(async ({send, stopping}) => {
    send({type: 'step', id: 'firestore', state: 'done', ms: 12, figures: [[3, 'documents']]});
    send({type: 'ready', ms: 20, console: 'http://127.0.0.1:4000/console', ports: {firestore: 8080}, functions: 0, warnings: []});
    await stopping;
    send({type: 'stopping'});
    // Killed while saving: no stopped event.
    return {signal: 'SIGKILL'};
  });
  const running = runInteractive(launch(['--resume-state']), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input, env, platform: 'darwin', spawner});
  for (let i = 0; i < 100 && !text().includes('All emulators ready'); i += 1) await tick(20);
  input.emit('data', Buffer.from('q'));
  assert.equal(await running, 1);
  const shown = text();
  for (const expected of ['Firenook did not finish stopping', 'signal SIGKILL', 'the next start checks /tmp/firenook-terminal-state first, and repairs it if it needs to']) shows(shown, expected);
  assert.ok(!flat(shown).includes('everything is kept'), 'a killed engine is never reported as stopped');
});

test('a stop before the emulators are ready closes the data cleanly and says so', async () => {
  const {out, text} = screen(150);
  const input = keyboard();
  const {spawner} = engine(async ({send, stopping}) => {
    send({type: 'step', id: 'firestore', state: 'running', verb: 'resuming'});
    await stopping;
    send({type: 'stopping'});
    await tick(40);
    send({type: 'stopped', outcome: {beforeReady: true}});
    return 0;
  });
  const running = runInteractive(launch(['--resume-state', '--export-on-exit', '/tmp/firenook-terminal-export']), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input, env, platform: 'darwin', spawner});
  await tick(60);
  input.emit('data', Buffer.from('q'));
  assert.equal(await running, 0);
  const shown = text();
  for (const expected of ['closing the data cleanly first', 'stopped', 'the data in /tmp/firenook-terminal-state is as it was', 'before it was ready']) shows(shown, expected);
  assert.ok(!flat(shown).includes('exported to'), 'nothing is exported before the emulators served anything');
});

test('an engine killed while it runs never says nothing was changed', async () => {
  // Saved data, picked up and written to: a kill leaves what was written,
  // and the next start checks the file.
  const kept = async (args, ending) => {
    const {out, text} = screen(150);
    const {spawner} = engine(async ({send}) => {
      send({type: 'opening', kind: args.includes('--resume-state') ? 'resume' : 'fresh'});
      send({type: 'step', id: 'firestore', state: 'done', ms: 12, figures: [[3, 'documents']]});
      send({type: 'ready', ms: 20, console: 'http://127.0.0.1:4000/console', ports: {firestore: 8080}, functions: 0, warnings: []});
      await tick(40);
      if (ending.failed) send({type: 'failed', kind: 'other', message: ending.failed});
      return ending.code ?? {signal: ending.signal};
    });
    assert.equal(await runInteractive(launch(args), {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner}), 1);
    return text();
  };
  let shown = await kept(['--resume-state'], {signal: 'SIGKILL'});
  for (const expected of ['Firenook stopped unexpectedly', 'signal SIGKILL', 'the next start checks /tmp/firenook-terminal-state first, and repairs it if it needs to']) shows(shown, expected);
  assert.ok(!flat(shown).includes('nothing was changed'), 'a killed engine may have been written to');
  // A service that failed under a running suite: its data is kept.
  shown = await kept(['--resume-state'], {failed: 'the firestore listener failed: connection reset', code: 1});
  for (const expected of ['Firenook stopped', 'everything is kept in /tmp/firenook-terminal-state']) shows(shown, expected);
  assert.ok(!flat(shown).includes('nothing was changed'));
  // A run without --state-dir keeps its data in its own run directory.
  const run = launch();
  run.args[run.args.indexOf('--state-dir') + 1] = '/tmp/project/.firenook/runs/session-AbC123/state';
  const {out, text} = screen(150);
  const {spawner} = engine(async ({send}) => {
    send({type: 'ready', ms: 20, console: null, ports: {firestore: 8080}, functions: 0, warnings: []});
    await tick(40);
    return {signal: 'SIGKILL'};
  });
  await runInteractive(run, {version: '9.9.9', projectId: 'demo-terminal', demo: true, out, input: keyboard(), env, platform: 'darwin', spawner, cwd: '/tmp/project'});
  shows(text(), "this run's data stays in .firenook/runs/session-AbC123");
  assert.ok(!flat(text()).includes('nothing of yours was changed'));
});
