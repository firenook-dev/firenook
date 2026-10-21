// init's screen in a terminal and what it stands on: the keys and fields of
// the form, the set-up after it (package managers, the pin, installs, the
// first build), and --build, which compiles a codebase before the engine
// loads it and again on every save.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { choiceField, createForm, formRows, keys, press, textField } from '../packages/cli/src/form.mjs';
import { buildLine, startBuild } from '../packages/cli/src/build.mjs';
import { childEnvironment, enclosingPackage, nextSteps, packageManager, packageName, pinPlan, setUpSteps } from '../packages/cli/src/setup.mjs';
import { initInTerminal } from '../packages/cli/src/init-screen.mjs';
import { EVENT_PREFIX, runInteractive } from '../packages/cli/src/session.mjs';
import { capabilities, createInk, createLayout } from '../packages/cli/src/terminal.mjs';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;.*?\x1b\\/g;
const plain = text => text.replace(ANSI, '');
const flat = text => text.replace(/[│╭╮╰╯├┤─]/g, ' ').replace(/\s+/g, ' ');
const shows = (shown, expected) => assert.ok(flat(shown).includes(flat(expected)), `${expected} in:\n${shown}`);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const tick = ms => new Promise(done => setTimeout(done, ms));
const folder = (prefix = 'firenook-init-screen-') => mkdtempSync(join(tmpdir(), prefix));

test('the keys a terminal sends are named, and a paste arrives whole', () => {
  assert.deepEqual(keys('\x1b[A\x1b[B\x1bOC\x1b[D'), [{name: 'up'}, {name: 'down'}, {name: 'right'}, {name: 'left'}]);
  assert.deepEqual(keys('ab\r'), [{name: 'text', text: 'ab'}, {name: 'enter'}]);
  assert.deepEqual(keys(' \t\x1b[Z\x7f\x03'), [{name: 'space'}, {name: 'tab'}, {name: 'backtab'}, {name: 'backspace'}, {name: 'ctrl-c'}]);
  assert.deepEqual(keys('\x1b'), [{name: 'escape'}]);
  assert.deepEqual(keys('\x1b[200~my\nshop\x1b[201~'), [{name: 'text', text: 'my shop'}]);
  assert.deepEqual(keys('\x1b[15~x'), [{name: 'text', text: 'x'}], 'a key the form has no use for is skipped whole');
});

test('a form moves between fields, edits text, picks one and toggles several, and checks before it submits', () => {
  const name = textField({id: 'name', label: 'Project ID', value: 'demo-a', filter: text => text.toLowerCase().replace(/\s/g, '-'),
    check: field => (field.value ? undefined : 'needs a name')});
  const language = choiceField({id: 'language', label: 'Functions', options: [{id: 'ts', label: 'TypeScript'}, {id: 'js', label: 'JavaScript'}], value: 'ts'});
  const services = choiceField({id: 'services', label: 'Emulators', many: true, options: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}], value: ['a', 'b']});
  const form = createForm([name, language, services], {check: () => (services.value.size ? undefined : {field: 'services', text: 'choose one'})});
  const type = (...pressed) => pressed.map(key => press(form, key)).at(-1);
  type({name: 'text', text: 'B C'});
  assert.equal(name.value, 'demo-ab-c');
  type({name: 'left'}, {name: 'backspace'}, {name: 'home'}, {name: 'delete'});
  assert.equal(name.value, 'emo-abc');
  type({name: 'ctrl-w'});
  assert.equal(name.value, 'emo-abc', 'nothing before the cursor to take');
  type({name: 'end'}, {name: 'ctrl-w'});
  assert.equal(name.value, 'emo-');
  type({name: 'down'}, {name: 'right'});
  assert.equal(language.value, 'js', 'one choice follows the cursor');
  type({name: 'down'}, {name: 'space'}, {name: 'right'}, {name: 'space'});
  assert.deepEqual([...services.value], []);
  assert.equal(type({name: 'enter'}), undefined);
  assert.equal(form.focus, 2);
  assert.equal(form.problem, 'choose one');
  type({name: 'space'});
  type({name: 'up'}, {name: 'up'}, {name: 'ctrl-u'});
  assert.equal(name.value, '');
  assert.equal(type({name: 'enter'}), undefined);
  assert.equal(form.problem, 'needs a name');
  type({name: 'text', text: 'demo-b'});
  assert.equal(type({name: 'enter'}), 'submit');
  assert.equal(type({name: 'escape'}), 'cancel');

  const ink = createInk(capabilities({env: {}, platform: 'darwin'}));
  const t = createLayout(ink, {columns: () => 90, rows: () => 30});
  const shown = plain(formRows(form, t).join('\n'));
  assert.match(shown, /Project ID +› demo-b/);
  assert.match(shown, /Functions +○ TypeScript {3}● JavaScript/);
  assert.match(shown, /Emulators +○ A {3}◉ B/);
  const still = plain(formRows(form, t, {still: true}).join('\n'));
  assert.match(still, /Functions +JavaScript/);
  assert.match(still, /Emulators +B$/m);
  assert.ok(!still.includes('›'), 'an answered form has no pointer');
});

test('the package manager comes from the lockfile, then from what ran the command, then npm', () => {
  const dir = folder();
  assert.equal(packageManager(dir, {}).name, 'npm');
  assert.equal(packageManager(dir, {npm_config_user_agent: 'pnpm/9.12.0 npm/? node/v24.20.0 darwin arm64'}).name, 'pnpm');
  assert.equal(packageManager(dir, {npm_config_user_agent: 'bun/1.3.14 npm/? node/v24.3.0 darwin arm64'}).run('emulators'), 'bun run emulators');
  writeFileSync(join(dir, 'yarn.lock'), '');
  assert.equal(packageManager(dir, {npm_config_user_agent: 'pnpm/9.12.0'}).name, 'yarn', 'the lockfile wins');
  assert.equal(packageManager(dir, {}).run('emulators'), 'yarn emulators');
  assert.equal(packageName('My Shop (2)'), 'my-shop-2');
  // npx's own settings never reach an install it starts.
  assert.deepEqual(Object.keys(childEnvironment({PATH: '/bin', npm_config_prefix: '/x', npm_lifecycle_event: 'npx', NPM_CONFIG_REGISTRY: 'https://r'})).sort(),
    ['NPM_CONFIG_REGISTRY', 'PATH', 'npm_config_audit', 'npm_config_fund', 'npm_config_update_notifier']);
});

test('pinning writes Firenook exactly and a start script, keeps what a package.json already has, and knows an enclosing package', () => {
  const dir = folder();
  const fresh = pinPlan(dir, {version: '0.2.0-next.9', build: true});
  assert.equal(fresh.exists, false);
  assert.deepEqual(JSON.parse(fresh.content), {name: packageName(dir.split(/[\\/]/).at(-1)), private: true,
    scripts: {emulators: 'firenook emulators:start --keep-data --build'}, devDependencies: {firenook: '0.2.0-next.9'}});
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'shop', scripts: {emulators: 'my own', test: 'x'}, devDependencies: {firenook: '0.2.0-next.7'}}));
  const kept = pinPlan(dir, {version: '0.2.0-next.9'});
  assert.deepEqual(JSON.parse(kept.content), {name: 'shop', scripts: {emulators: 'my own', test: 'x'}, devDependencies: {firenook: '0.2.0-next.7'}});
  assert.deepEqual(kept.kept, ['your emulators script', 'firenook 0.2.0-next.7']);
  assert.equal(kept.changed, true, 'formatting is the only change');
  writeFileSync(join(dir, 'package.json'), '{oops');
  assert.throws(() => pinPlan(dir, {version: '1.0.0'}), /package\.json is not valid JSON/);
  const outer = folder();
  writeFileSync(join(outer, 'package.json'), '{}');
  mkdirSync(join(outer, 'apps', 'backend'), {recursive: true});
  assert.equal(enclosingPackage(join(outer, 'apps', 'backend'), '/nowhere'), join(outer, 'package.json'));
  assert.equal(enclosingPackage(join(outer, 'apps', 'backend'), outer), undefined, 'the home folder is the end of the search');
});

// A package manager that answers from a script: each call's exit code, and
// the lines it prints.
function installer(answers) {
  const calls = [];
  const spawner = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: undefined});
    const call = {command, args, cwd: options.cwd, env: options.env};
    calls.push(call);
    const answer = answers.find(item => item.match(call)) ?? {code: 0, lines: []};
    setTimeout(() => {
      for (const line of answer.lines ?? []) child.stdout.write(`${line}\n`);
      child.exitCode = answer.code;
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', answer.code, null), 2);
    }, answer.after ?? 5);
    return child;
  };
  return {spawner, calls};
}
const everything = (overrides = {}) => ({project: 'demo-shop', language: 'typescript', emulators: new Set(['firestore', 'ui']), agents: [], install: true, pin: true, ...overrides});

test('the set-up pins and installs side by side, builds after the packages, and says what is left when one fails', async () => {
  const dir = folder();
  mkdirSync(join(dir, 'functions'));
  const {spawner, calls} = installer([{match: call => call.args.join(' ') === 'run build', code: 0, lines: ['> functions@ build', '> tsc']},
    {match: call => call.cwd.endsWith('functions'), code: 0, lines: ['added 241 packages in 7s']}]);
  const work = setUpSteps(everything(), dir, {version: '0.2.0-next.9', env: {npm_config_user_agent: 'npm/11.6.2 node/v24.20.0'}, platform: 'darwin', spawner});
  const seen = [];
  const {ok, steps} = await work.run(step => { if (step) seen.push(`${step.id}:${step.state}`); });
  assert.equal(ok, true);
  assert.deepEqual(steps.map(step => [step.id, step.state]), [['firenook', 'done'], ['packages', 'done'], ['build', 'done']]);
  assert.equal(steps.find(step => step.id === 'packages').detail, 'npm install in functions/, 241 packages');
  assert.ok(seen.indexOf('build:running') > seen.indexOf('packages:done'), 'the build waits for the packages');
  assert.deepEqual(calls.map(call => [call.command, ...call.args].join(' ')), ['npm install', 'npm install', 'npm run build']);
  assert.equal(readJson(join(dir, 'package.json')).devDependencies.firenook, '0.2.0-next.9');
  assert.ok(!('npm_config_user_agent' in calls[0].env), 'the installs see the project\'s settings, not npx\'s');
  assert.deepEqual(nextSteps(everything(), steps, {manager: work.manager, node: '24.20.0'}).map(step => step.command), ['npm run emulators']);

  // A failed install: its last lines are kept, the build does not run, and
  // the next steps finish the rest.
  const failing = folder();
  mkdirSync(join(failing, 'functions'));
  const broken = installer([{match: call => call.cwd.endsWith('functions'), code: 1, lines: ['npm error code E404', 'npm error 404 Not Found']}]);
  const second = setUpSteps(everything(), failing, {version: '0.2.0-next.9', env: {}, platform: 'darwin', spawner: broken.spawner});
  const result = await second.run();
  assert.equal(result.ok, false);
  const packages = result.steps.find(step => step.id === 'packages');
  assert.equal(packages.state, 'failed');
  assert.equal(packages.detail, 'npm install failed (exit code 1)');
  assert.deepEqual(packages.tail, ['npm error code E404', 'npm error 404 Not Found']);
  assert.equal(result.steps.find(step => step.id === 'build').state, 'skipped');
  assert.deepEqual(nextSteps(everything(), result.steps, {manager: second.manager, node: '26.9.0', platform: 'darwin'}).map(step => step.command),
    ['nvm use 24', 'cd functions && npm install && cd ..', 'npm run emulators']);
  // Without the install, the pin is written and the commands say the rest.
  const unpinned = setUpSteps(everything({install: false}), folder(), {version: '1.0.0', env: {}, platform: 'darwin', spawner: () => assert.fail('nothing runs')});
  const quiet = await unpinned.run();
  assert.deepEqual(nextSteps(everything({install: false}), quiet.steps, {manager: unpinned.manager, node: '24.20.0', platform: 'darwin'}).map(step => step.command),
    ['cd functions && npm install && cd ..', 'npm install', 'npm run emulators']);
  assert.deepEqual(nextSteps(everything({install: false, pin: false, language: 'javascript'}), [], {manager: unpinned.manager, node: '24.20.0', platform: 'darwin'}).map(step => step.command),
    ['cd functions && npm install && cd ..', 'npx firenook emulators:start --keep-data']);
});

test('a build\'s lines are read as TypeScript writes them, in watch mode and once', async () => {
  assert.deepEqual(buildLine('\x1b[2J\x1b[3J\x1b[H10:10:02 PM - Starting compilation in watch mode...'), {kind: 'compiling'});
  assert.deepEqual(buildLine('10:10:06 PM - File change detected. Starting incremental compilation...'), {kind: 'compiling'});
  assert.deepEqual(buildLine('10:10:06 PM - Found 1 error. Watching for file changes.'), {kind: 'compiled', count: 1});
  assert.deepEqual(buildLine("src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."),
    {kind: 'error', file: 'src/index.ts', line: 1, column: 14, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'."});
  assert.deepEqual(buildLine('Found 2 errors in the same file, starting at: src/index.ts:3'), {kind: 'quiet'});
  assert.deepEqual(buildLine('> functions@1.0.0 build:watch'), {kind: 'quiet'});
  assert.deepEqual(buildLine('esbuild: something broke, error here'), {kind: 'text', text: 'esbuild: something broke, error here', error: true});

  const directory = folder();
  const watch = installer([{match: () => true, code: 0, after: 400, lines: []}]);
  const events = [];
  // A watch that prints its first compile, then a broken save.
  const spawner = (...args) => {
    const child = watch.spawner(...args);
    setTimeout(() => {
      for (const line of ['> functions@ build:watch', '> tsc --watch', '10:00:00 PM - Starting compilation in watch mode...', '10:00:01 PM - Found 0 errors. Watching for file changes.',
        '10:00:05 PM - File change detected. Starting incremental compilation...', 'src/index.ts(3,7): error TS2304: Cannot find name \'x\'.', '10:00:05 PM - Found 1 error. Watching for file changes.']) child.stdout.write(`${line}\n`);
    }, 1);
    return child;
  };
  const build = startBuild({directory, script: 'build:watch', watch: true, shown: 'functions'}, {env: {}, platform: 'darwin', spawner, onEvent: event => events.push(event)});
  assert.equal(build.command, 'npm run build:watch');
  assert.deepEqual(await build.first, {errors: [], count: 0});
  await build.done;
  await tick(10);
  assert.deepEqual(events.map(event => event.type), ['compiling', 'compiled', 'compiling', 'compiled', 'ended']);
  assert.equal(events[3].errors[0].message, "Cannot find name 'x'.");
  // Once: the errors come with the exit.
  const once = installer([{match: () => true, code: 2, lines: ['src/a.ts(1,1): error TS1005: \';\' expected.', 'Found 1 error in src/a.ts:1']}]);
  const result = await startBuild({directory, script: 'build', watch: false, shown: 'functions'}, {env: {}, platform: 'darwin', spawner: once.spawner}).first;
  assert.equal(result.code, 2);
  assert.equal(result.errors[0].code, 'TS1005');
});

// ── The screen ───────────────────────────────────────────────────────────

function terminal(columns = 100, rows = 44) {
  const chunks = [];
  const out = new Writable({write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); }});
  Object.assign(out, {isTTY: true, columns, rows});
  const input = new EventEmitter();
  Object.assign(input, {isTTY: true, isRaw: false, setRawMode(on) { this.isRaw = on; }, resume() {}, pause() {}});
  const typing = async (...pressed) => { for (const key of pressed) { input.emit('data', Buffer.from(key)); await tick(15); } };
  return {out, input, typing, text: () => plain(chunks.join(''))};
}
const screenEnv = {COLORTERM: 'truecolor'};
const quietPorts = {probe: async () => false, holder: () => undefined};
const until = async (check, limit = 4000) => { for (let waited = 0; waited < limit && !check(); waited += 20) await tick(20); };

test('in a terminal, Enter takes every choice, the set-up runs on the card, and a yes starts the emulators', async () => {
  const dir = folder();
  const {out, input, typing, text} = terminal();
  const {spawner, calls} = installer([{match: () => true, code: 0, lines: ['added 3 packages in 1s']}]);
  const started = [];
  const running = initInTerminal({config: undefined}, {cwd: dir, out, input, env: screenEnv, platform: 'darwin', version: '9.9.9-next.1', home: '/nowhere', spawner,
    node: '24.20.0', ...quietPorts, start: async (options, typed) => { started.push({options, typed}); return 0; }});
  await until(() => text().includes('esc cancel'));
  assert.equal(input.isRaw, true);
  for (const expected of ['firenook  9.9.9-next.1', 'a new project in', 'New project', 'Project ID', 'Firestore 8080', 'TypeScript', 'Install packages', 'Pin Firenook',
    'demo- keeps it on this machine']) shows(text(), expected);
  await typing('\r');
  await until(() => text().includes('Start the emulators now?'));
  for (const expected of ['Set-up', 'Files', 'Firenook', 'Packages', 'npm install in functions/, 3 packages', 'Build', 'tsc, into functions/lib']) shows(text(), expected);
  await typing('y');
  assert.equal(await running, 0);
  assert.deepEqual(started.map(({typed}) => typed), [['--keep-data', '--build']]);
  assert.equal(started[0].options['keep-data'], true);
  assert.equal(input.isRaw, false, 'the terminal is handed on as it was found');
  assert.deepEqual(calls.map(call => [call.command, ...call.args].join(' ')), ['npm install', 'npm install', 'npm run build']);
  assert.equal(readJson(join(dir, 'firebase.json')).functions.predeploy[0], 'npm --prefix "$RESOURCE_DIR" run build');
  assert.ok(existsSync(join(dir, 'functions/src/index.ts')));
});

test('in a terminal, changed choices are what is written, No prints the next steps, and Esc writes nothing', async () => {
  const dir = folder();
  const {out, input, typing, text} = terminal();
  const {spawner} = installer([]);
  const running = initInTerminal({}, {cwd: dir, out, input, env: screenEnv, platform: 'darwin', version: '9.9.9-next.1', home: '/nowhere', spawner, node: '24.20.0', ...quietPorts,
    start: () => assert.fail('No starts nothing')});
  await until(() => text().includes('esc cancel'));
  // The id, Storage off, JavaScript, no install.
  await typing('\x15', 'demo shop', '\x1b[B', '\x1b[C', '\x1b[C', ' ', '\x1b[B', '\x1b[C', '\x1b[B', '\x1b[B', ' ', '\r');
  await until(() => text().includes('Next'));
  assert.equal(await running, 0);
  const config = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(Object.keys(config), ['firestore', 'functions', 'emulators'], 'Storage was turned off');
  assert.equal(config.functions.predeploy, undefined, 'JavaScript needs no build');
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects: {default: 'demo-shop'}});
  assert.ok(existsSync(join(dir, 'functions/index.js')));
  assert.ok(!existsSync(join(dir, 'functions/node_modules')) && readJson(join(dir, 'package.json')).devDependencies.firenook === '9.9.9-next.1');
  for (const expected of ['cd functions && npm install && cd ..', 'npm install', 'npm run emulators', 'Connect']) shows(text(), expected);

  const empty = folder();
  const second = terminal();
  const cancelled = initInTerminal({}, {cwd: empty, out: second.out, input: second.input, env: screenEnv, platform: 'darwin', version: '9.9.9-next.1', home: '/nowhere',
    spawner: () => assert.fail('nothing runs'), node: '24.20.0', ...quietPorts});
  await until(() => second.text().includes('esc cancel'));
  await second.typing('\x1b');
  assert.equal(await cancelled, 130);
  shows(second.text(), 'Cancelled: nothing was written.');
  assert.deepEqual(readdirSync(empty), []);
});

test('in a terminal on another Node, a taken port is named, and the set-up ends with how to switch', async () => {
  const dir = folder();
  const {out, input, typing, text} = terminal();
  const running = initInTerminal({'no-install': true}, {cwd: dir, out, input, env: screenEnv, platform: 'darwin', version: '9.9.9-next.1', home: '/nowhere',
    spawner: () => assert.fail('no install was asked for'), node: '26.9.0', probe: async port => port === 8080,
    holder: port => (port === 8080 ? {pid: 4242, program: 'java', command: 'java -jar cloud-firestore-emulator.jar'} : undefined), start: () => assert.fail('no start on Node 26')});
  await until(() => text().includes('esc cancel'));
  shows(text(), 'Node 26.9.0: the emulators need Node 24');
  await typing('\x1b[B');
  await until(() => text().includes('held by'));
  shows(text(), 'Firestore 8080 is held by an official Firebase emulator (PID 4242)');
  await typing('\r');
  assert.equal(await running, 0);
  for (const expected of ['nvm use 24', 'the emulators need Node 24, and this is 26.9.0', 'npm install', 'npm run emulators']) shows(text(), expected);
});

test('in a terminal, a folder with a firebase.json is shown what init --adopt adds, and a yes adds it', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({firestore: {rules: 'firestore.rules'}, emulators: {firestore: {port: 8080}}}));
  const {out, input, typing, text} = terminal();
  const running = initInTerminal({}, {cwd: dir, out, input, env: screenEnv, platform: 'darwin', version: '9.9.9-next.1', home: '/nowhere', node: '24.20.0', ...quietPorts});
  await until(() => text().includes('Add these'));
  for (const expected of ['This folder has a firebase.json', 'set .firebaserc projects.default', 'write Firestore rules (official init template): firestore.rules']) shows(text(), expected);
  await typing('y');
  assert.equal(await running, 0);
  for (const expected of ['Added', '.firebaserc', 'npx firenook emulators:start']) shows(text(), expected);
  assert.ok(existsSync(join(dir, 'firestore.rules')) && existsSync(join(dir, '.firebaserc')));
});

// ── --build on the start screen ──────────────────────────────────────────

test('--build compiles before the engine starts, says each compile\'s errors in the log, and stops with it', async () => {
  const {out, input, typing, text} = terminal();
  const spawned = [];
  let buildOut;
  let buildDone;
  const spawner = (command, args) => {
    const child = new EventEmitter();
    Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null});
    spawned.push(command);
    if (command !== '/fake/firenook') {
      buildOut = child.stdout;
      buildDone = () => { child.exitCode = 0; child.stdout.end(); child.stderr.end(); setTimeout(() => child.emit('close', 0, null), 2); };
      setTimeout(() => {
        child.stdout.write('10:00:00 PM - Starting compilation in watch mode...\n');
        child.stdout.write('10:00:01 PM - Found 0 errors. Watching for file changes.\n');
      }, 20);
      return child;
    }
    const send = event => child.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
    let stopped;
    const stopping = new Promise(done => { stopped = done; });
    child.kill = signal => { stopped(signal); return true; };
    (async () => {
      send({type: 'step', id: 'functions', state: 'done', ms: 40, figures: [[1, 'functions']]});
      send({type: 'ready', ms: 90, console: 'http://127.0.0.1:4000/console', ports: {functions: 5001, hub: 4400}});
      await stopping;
      Object.assign(child, {exitCode: 0});
      buildDone?.();
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', 0, null), 5);
    })();
    return child;
  };
  const launch = {binary: '/fake/firenook', env: {}, cwd: '.', services: ['functions'], builds: [{codebase: 'default', directory: '/fake/functions', shown: 'functions', script: 'build:watch', watch: true}],
    args: ['suite', '--state-dir', '/tmp/firenook-build-state', '--host', '127.0.0.1', '--ui-port', '4000', '--functions-port', '5001', '--hub-port', '4400']};
  const running = runInteractive(launch, {version: '9.9.9-next.1', projectId: 'demo-build', demo: true, out, input, env: {...screenEnv, FIRENOOK_NO_UPDATE_CHECK: '1'}, platform: 'darwin', spawner});
  await until(() => text().includes('All emulators ready'));
  assert.deepEqual(spawned, ['npm', '/fake/firenook'], 'the build first, then the engine');
  shows(text(), 'Build');
  shows(text(), 'functions · build:watch');
  buildOut.write('10:00:05 PM - File change detected. Starting incremental compilation...\n');
  buildOut.write("src/index.ts(3,7): error TS2304: Cannot find name 'x'.\n");
  buildOut.write('10:00:05 PM - Found 1 error. Watching for file changes.\n');
  await until(() => text().includes("Cannot find name 'x'."));
  for (const expected of ['build', '1 error · functions', "src/index.ts:3:7 Cannot find name 'x'.", 'build errors']) shows(text(), expected);
  buildOut.write('10:00:09 PM - File change detected. Starting incremental compilation...\n');
  buildOut.write('10:00:09 PM - Found 0 errors. Watching for file changes.\n');
  await until(() => text().includes('no errors · functions'));
  await typing('q');
  assert.equal(await running, 0);
  assert.ok(!text().includes('ended'), 'a build Firenook stops is no news');
});
