// The CLI commands that never start the engine: emulators:export and
// firestore:delete against a fake hub/Firestore, .firebaserc edits, init.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { canonical, loadProject } from '../packages/cli/src/options.mjs';
import { exportEmulators, firestoreDelete, locatorPath } from '../packages/cli/src/hub.mjs';
import { applyTarget, clearTarget, targetApply, targetClear, use } from '../packages/cli/src/rc.mjs';
import { INIT_PORTS, adopt, firestoreRules, scaffold } from '../packages/cli/src/init.mjs';

const cli = fileURLToPath(new URL('../packages/cli/bin/fireside.mjs', import.meta.url));
const options = {'storage-bucket':[], instance:[]};
const log = () => { const out = [], err = []; return {out, err, log:(...a) => out.push(a.join(' ')), error:(...a) => err.push(a.join(' '))}; };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// A port nothing listens on, so the configured-port fallback never reaches a
// real suite on this machine.
async function unusedPort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function project(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-commands-'));
  const config = {firestore:{rules:'firestore.rules'}, storage:{rules:'storage.rules'}, functions:{source:'functions'},
    emulators:{firestore:{}, auth:{}, storage:{}, functions:{}, pubsub:{}, hub:{port:fake.deadPort}}, ...extra};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-fixture'}}));
  return {dir, config};
}

// One HTTP server plays the hub and the Firestore emulator.
const fake = {requests:[], running:{}, exportStatus:200, deleted:3};
let locatorDir;
before(async () => {
  fake.deadPort = await unusedPort();
  fake.server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      fake.requests.push({method:request.method, url:request.url, headers:request.headers, body:body ? JSON.parse(body) : undefined});
      const reply = (status, value) => { response.writeHead(status, {'content-type':'application/json'}); response.end(JSON.stringify(value)); };
      if (request.method === 'GET' && request.url === '/') return reply(200, {version:'15.22.0', origins:[fake.origin], pid:process.pid, host:'127.0.0.1', port:fake.port});
      if (request.method === 'GET' && request.url === '/emulators') return reply(200, fake.running);
      if (request.method === 'POST' && request.url === '/_admin/export') return reply(fake.exportStatus, fake.exportStatus === 200 ? {message:'OK'} : {message:'synthetic export failure'});
      if (request.method === 'DELETE' && request.url.startsWith('/emulator/v1/')) return reply(200, request.url.endsWith('/documents') ? {} : {deleted:fake.deleted});
      reply(404, {message:'unexpected route'});
    });
  });
  fake.server.listen(0, '127.0.0.1');
  await once(fake.server, 'listening');
  fake.port = fake.server.address().port;
  fake.origin = `http://127.0.0.1:${fake.port}`;
  fake.running = {firestore:{name:'firestore', host:'127.0.0.1', port:fake.port}, auth:{name:'auth', host:'127.0.0.1', port:fake.port}};
  locatorDir = mkdtempSync(join(tmpdir(), 'fireside-locator-'));
  process.env.FIRESIDE_LOCATOR_DIR = locatorDir;
  writeFileSync(locatorPath('demo-fixture'), JSON.stringify({version:'15.22.0', origins:[fake.origin], pid:process.pid}));
});
after(async () => {
  await new Promise(resolve => fake.server.close(resolve));
  delete process.env.FIRESIDE_LOCATOR_DIR;
  rmSync(locatorDir, {recursive:true, force:true});
});
const lastRequest = () => fake.requests[fake.requests.length - 1];

test('emulators:export posts the running exportable targets without an Origin header', async () => {
  const {dir} = project();
  const destination = join(dir, '..', `fireside-export-${process.pid}-a`);
  const output = log();
  assert.equal(await exportEmulators(destination, {...options, json:true}, dir, output), 0);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/_admin/export');
  assert.equal(request.headers.origin, undefined);
  assert.deepEqual(request.body, {path:canonical(destination), targets:['firestore', 'auth'], initiatedBy:'fireside emulators:export'});
  assert.deepEqual(JSON.parse(output.out[0]), {path:canonical(destination), targets:['firestore', 'auth'], ok:true});
  assert.ok(existsSync(destination), 'the destination is created before the request');
  assert.match(output.err.join('\n'), /Found running emulator hub for project demo-fixture/);
  // --only narrows the targets; storage is configured but not running here.
  await exportEmulators(destination, {...options, only:'firestore,storage', force:true}, dir, log());
  assert.deepEqual(lastRequest().body.targets, ['firestore']);
  await assert.rejects(exportEmulators(destination, {...options, only:'functions', force:true}, dir, log()), /Nothing to export/);
  rmSync(destination, {recursive:true, force:true});
});
test('emulators:export refuses the project tree and foreign non-empty directories; existing exports are replaced', async () => {
  const {dir} = project();
  for (const target of [dir, join(dir, '..')]) await assert.rejects(exportEmulators(target, options, dir, log()), /must not be the project directory/);
  assert.equal(await exportEmulators(join(dir, 'inside'), options, dir, log()), 0, 'a subdirectory of the project is a valid destination');
  const busy = mkdtempSync(join(tmpdir(), 'fireside-busy-'));
  writeFileSync(join(busy, 'unrelated.txt'), 'keep');
  await assert.rejects(exportEmulators(busy, options, dir, log()), /re-run with --force/);
  assert.equal(await exportEmulators(busy, {...options, force:true}, dir, log()), 0);
  const previous = mkdtempSync(join(tmpdir(), 'fireside-previous-'));
  writeFileSync(join(previous, 'firebase-export-metadata.json'), '{}');
  assert.equal(await exportEmulators(previous, options, dir, log()), 0, 'an earlier export is overwritten without --force');
  writeFileSync(join(busy, 'file'), 'x');
  await assert.rejects(exportEmulators(join(busy, 'file'), options, dir, log()), /not a directory/);
  await assert.rejects(exportEmulators(undefined, options, dir, log()), /requires a destination/);
  rmSync(busy, {recursive:true, force:true}); rmSync(previous, {recursive:true, force:true});
});
test('emulators:export reports hub failures and a missing hub, and works from the locator alone', async () => {
  const {dir} = project();
  const destination = join(dir, '..', `fireside-export-${process.pid}-b`);
  fake.exportStatus = 500;
  await assert.rejects(exportEmulators(destination, options, dir, log()), /Export request failed \(HTTP 500\): synthetic export failure/);
  fake.exportStatus = 200;
  // No firebase.json: the explicit project id and the locator file suffice.
  const bare = mkdtempSync(join(tmpdir(), 'fireside-bare-'));
  assert.equal(await exportEmulators(destination, {...options, project:'demo-fixture'}, bare, log()), 0);
  await assert.rejects(exportEmulators(destination, options, bare, log()), /No firebase\.json/);
  rmSync(destination, {recursive:true, force:true});
  // Another project has no locator and nothing on its hub port.
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-absent'}}));
  await assert.rejects(exportEmulators(destination, options, dir, log()), error => {
    assert.match(error.message, /Did not find a running emulator hub for project demo-absent/);
    assert.match(error.message, new RegExp(`tried http://127\\.0\\.0\\.1:${fake.deadPort}`));
    assert.ok(!error.message.includes('stale locator'), 'no locator, no stale-locator hint');
    return true;
  });
  // A stale locator (its origin is dead) is named so it can be removed.
  writeFileSync(locatorPath('demo-absent'), JSON.stringify({version:'15.22.0', origins:[`http://127.0.0.1:${fake.deadPort}`], pid:1}));
  await assert.rejects(exportEmulators(destination, options, dir, log()), error => {
    assert.ok(error.message.includes(`delete the stale locator ${locatorPath('demo-absent')}`));
    return true;
  });
  rmSync(locatorPath('demo-absent'));
  assert.ok(!existsSync(destination), 'nothing is created before the hub answers');
});
test('firestore:delete sends the official flag contract to the emulator routes', async () => {
  const {dir} = project();
  const output = log();
  assert.equal(await firestoreDelete('/users/alice/', options, ['users/alice'], dir, output), 0);
  let request = lastRequest();
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/emulator/v1/projects/demo-fixture/databases/(default)/documents/users/alice?mode=shallow');
  assert.equal(request.headers.authorization, 'Bearer owner');
  assert.deepEqual(output.out, ['Deleted 3 documents']);
  await firestoreDelete('users/alice', {...options, recursive:true, json:true, database:'other'}, [], dir, output);
  request = lastRequest();
  assert.equal(request.url, '/emulator/v1/projects/demo-fixture/databases/other/documents/users/alice?mode=recursive');
  assert.deepEqual(JSON.parse(output.out[1]), {path:'users/alice', mode:'recursive', deleted:3});
  await assert.rejects(firestoreDelete('users', options, [], dir, log()), /Must pass recursive or shallow option when deleting a collection/);
  await assert.rejects(firestoreDelete('users', {...options, recursive:true}, ['users', '-r'], dir, log()), /without --force\. Re-run: fireside firestore:delete users -r --force/);
  await firestoreDelete('users', {...options, recursive:true, force:true}, [], dir, log());
  assert.equal(lastRequest().url, '/emulator/v1/projects/demo-fixture/databases/(default)/documents/users?mode=recursive');
  await firestoreDelete('users', {...options, shallow:true}, [], dir, log());
  assert.equal(lastRequest().url, '/emulator/v1/projects/demo-fixture/databases/(default)/documents/users?mode=shallow');
  await assert.rejects(firestoreDelete(undefined, options, [], dir, log()), /Must specify a path/);
  await assert.rejects(firestoreDelete('users//x', {...options, shallow:true}, [], dir, log()), /empty segments/);
  await assert.rejects(firestoreDelete(undefined, {...options, 'all-collections':true}, ['--all-collections'], dir, log()), /THE ENTIRE \(default\) database of demo-fixture without --force/);
  await assert.rejects(firestoreDelete('users', {...options, 'all-collections':true, force:true}, [], dir, log()), /takes no path/);
  const whole = log();
  await firestoreDelete(undefined, {...options, 'all-collections':true, force:true, database:'second'}, [], dir, whole);
  assert.equal(lastRequest().url, '/emulator/v1/projects/demo-fixture/databases/second/documents');
  assert.deepEqual(whole.out, ['Deleted the second database']);
  const running = fake.running;
  fake.running = {auth:running.auth};
  await assert.rejects(firestoreDelete('users/alice', options, [], dir, log()), /did not start Firestore/);
  fake.running = running;
});
test('use edits .firebaserc aliases and the active default without touching other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-use-'));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({targets:{'demo-a':{storage:{main:['demo-a.appspot.com']}}}}));
  const rc = () => readJson(join(dir, '.firebaserc'));
  let output = log();
  use(undefined, {...options, add:'demo-a'}, dir, output);
  assert.deepEqual(rc().projects, {default:'demo-a'});
  assert.match(output.out.join('\n'), /Created alias default for demo-a/);
  use(undefined, {...options, add:'demo-b', alias:'staging'}, dir, log());
  assert.deepEqual(rc().projects, {default:'demo-a', staging:'demo-b'});
  output = log();
  use('staging', options, dir, output);
  assert.equal(rc().projects.default, 'demo-b');
  assert.match(output.out.join('\n'), /Now using alias staging \(demo-b\)/);
  output = log();
  use('my-real-app', options, dir, output);
  assert.equal(rc().projects.default, 'my-real-app');
  assert.match(output.out.join('\n'), /recorded as a project id, not an alias/);
  use('demo-c', {...options, alias:'ci'}, dir, log());
  assert.deepEqual(rc().projects, {default:'demo-c', staging:'demo-b', ci:'demo-c'});
  output = log();
  use(undefined, options, dir, output);
  assert.match(output.out.join('\n'), /\* ci \(demo-c\)[\s\S]*Active project: demo-c/);
  use(undefined, {...options, unalias:'staging'}, dir, log());
  assert.deepEqual(rc().projects, {default:'demo-c', ci:'demo-c'});
  use(undefined, {...options, clear:true}, dir, log());
  assert.deepEqual(rc().projects, {ci:'demo-c'});
  assert.deepEqual(rc().targets, {'demo-a':{storage:{main:['demo-a.appspot.com']}}}, 'unrelated keys survive');
  assert.throws(() => use('Bad Id', options, dir, log()), /Invalid project id/);
  assert.throws(() => use(undefined, {...options, add:'demo-x', clear:true}, dir, log()), /one of/);
  assert.throws(() => use(undefined, {...options, alias:'x'}, dir, log()), /--alias needs the project id/);
  output = log();
  use(undefined, {...options, json:true}, dir, output);
  assert.deepEqual(JSON.parse(output.out[0]), {path:join(dir, '.firebaserc'), projects:{ci:'demo-c'}, active:null});
  // A fresh directory gets a new file.
  const fresh = mkdtempSync(join(tmpdir(), 'fireside-use-fresh-'));
  use('demo-new', options, fresh, log());
  assert.deepEqual(readJson(join(fresh, '.firebaserc')), {projects:{default:'demo-new'}});
});
test('target:apply and target:clear mirror the official .firebaserc target semantics', () => {
  const rc = {};
  assert.deepEqual(applyTarget(rc, 'demo-a', 'storage', 'main', ['b.example.test', 'a.example.test']), []);
  assert.deepEqual(rc.targets['demo-a'].storage.main, ['a.example.test', 'b.example.test']);
  assert.deepEqual(applyTarget(rc, 'demo-a', 'storage', 'second', ['b.example.test']), [{resource:'b.example.test', target:'main'}]);
  assert.deepEqual(rc.targets['demo-a'].storage, {main:['a.example.test'], second:['b.example.test']});
  assert.deepEqual(applyTarget(rc, 'demo-a', 'storage', 'second', ['a.example.test']), [{resource:'a.example.test', target:'main'}]);
  assert.deepEqual(rc.targets['demo-a'].storage, {second:['a.example.test', 'b.example.test']}, 'an emptied target disappears');
  assert.equal(clearTarget(rc, 'demo-a', 'storage', 'second'), true);
  assert.equal(clearTarget(rc, 'demo-a', 'storage', 'second'), false);
  const dir = mkdtempSync(join(tmpdir(), 'fireside-target-'));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-a', prod:'demo-p'}}));
  const file = () => readJson(join(dir, '.firebaserc'));
  let output = log();
  targetApply(['storage', 'main', 'demo-a.appspot.com', 'other.example.test'], options, dir, output);
  assert.deepEqual(file().targets, {'demo-a':{storage:{main:['demo-a.appspot.com', 'other.example.test']}}});
  assert.match(output.out.join('\n'), /Applied storage target main to demo-a.appspot.com, other.example.test for demo-a[\s\S]*Updated: main \(demo-a.appspot.com,other.example.test\)/);
  output = log();
  targetApply(['storage', 'second', 'other.example.test'], options, dir, output);
  assert.match(output.out.join('\n'), /Previous target main removed from other.example.test/);
  assert.deepEqual(file().targets['demo-a'].storage, {main:['demo-a.appspot.com'], second:['other.example.test']});
  targetApply(['storage', 'main', 'demo-p.appspot.com'], {...options, project:'prod'}, dir, log());
  assert.deepEqual(file().targets['demo-p'].storage.main, ['demo-p.appspot.com'], '--project resolves aliases for the target key');
  output = log();
  targetClear(['storage', 'second'], options, dir, output);
  assert.match(output.out.join('\n'), /Cleared storage target second/);
  assert.deepEqual(file().targets['demo-a'].storage, {main:['demo-a.appspot.com']});
  output = log();
  targetClear(['storage', 'second'], options, dir, output);
  assert.match(output.out.join('\n'), /No action taken/);
  assert.throws(() => targetApply(['database', 'main', 'x'], options, dir, log()), /not implemented by Fireside/);
  assert.throws(() => targetApply(['hosting', 'main', 'x'], options, dir, log()), /not implemented by Fireside/);
  assert.throws(() => targetApply(['wat', 'main', 'x'], options, dir, log()), /Unrecognized target type wat/);
  assert.throws(() => targetApply(['storage', 'main'], options, dir, log()), /at least one resource/);
  assert.throws(() => targetClear(['storage'], options, dir, log()), /type and a target name/);
  writeFileSync(join(dir, '.firebaserc'), '{}');
  assert.throws(() => targetApply(['storage', 'main', 'x'], options, dir, log()), /Must have an active project/);
});
test('init scaffolds a runnable demo project with the official defaults and never overwrites without --force', () => {
  const root = mkdtempSync(join(tmpdir(), 'fireside-init-'));
  const dir = join(root, 'My App'); mkdirSync(dir);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const output = log();
  assert.equal(scaffold(options, dir, output), 0);
  const config = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(Object.keys(config), ['firestore', 'storage', 'functions', 'emulators']);
  assert.deepEqual(config.storage, {rules:'storage.rules'});
  assert.deepEqual(config.functions, {source:'functions', codebase:'default', ignore:['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local']});
  for (const [name, port] of Object.entries(INIT_PORTS)) assert.equal(config.emulators[name].port, port, name);
  assert.deepEqual(config.emulators.ui, {enabled:true, port:4000});
  assert.equal(config.emulators.singleProjectMode, true);
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects:{default:'demo-my-app'}});
  assert.match(readFileSync(join(dir, 'firestore.rules'), 'utf8'), /configured to expire after 30 days[\s\S]*timestamp\.date\(\d{4}, \d{1,2}, \d{1,2}\)/);
  assert.match(readFileSync(join(dir, 'storage.rules'), 'utf8'), /Craft rules based on data in your Firestore database[\s\S]*allow read, write: if false;/);
  assert.deepEqual(readJson(join(dir, 'firestore.indexes.json')), {indexes:[], fieldOverrides:[]});
  const pkg = readJson(join(dir, 'functions/package.json'));
  assert.deepEqual(pkg.dependencies, {'firebase-admin':'^13.0.0', 'firebase-functions':'^7.0.0'});
  assert.deepEqual(pkg.engines, {node:'24'});
  assert.match(readFileSync(join(dir, 'functions/index.js'), 'utf8'), /exports\.helloWorld = onRequest/);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.fireside/\n*-debug.log\n');
  assert.equal(readFileSync(join(dir, 'functions/.gitignore'), 'utf8'), 'node_modules/\n*.local\n');
  assert.ok(!existsSync(join(dir, 'functions/node_modules')), 'nothing is installed');
  assert.match(output.err.join('\n'), /Next steps:[\s\S]*cd functions && npm install[\s\S]*fireside setup[\s\S]*fireside emulators:start --project demo-my-app/);
  assert.equal(firestoreRules(new Date(Date.UTC(2026, 0, 15, 12))).includes('timestamp.date(2026, 2, 14)'), true);
  assert.throws(() => scaffold(options, dir, log()), /exists; use fireside init --adopt/);
  writeFileSync(join(dir, 'storage.rules'), 'custom');
  scaffold({...options, force:true, project:'demo-forced'}, dir, log());
  assert.equal(readFileSync(join(dir, 'storage.rules'), 'utf8').startsWith("rules_version = '2';"), true, '--force rewrites every scaffold file');
  assert.equal(readJson(join(dir, '.firebaserc')).projects.default, 'demo-forced');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.fireside/\n*-debug.log\n', 'gitignore lines are never duplicated');
  // The scaffold passes the launcher's own checks.
  const project = loadProject(options, dir);
  assert.deepEqual(project.services, ['firestore', 'auth', 'storage', 'functions', 'pubsub']);
  assert.equal(project.minimumFunctions, '1');
  assert.equal(project.ports.logging, 4500);
  // Without Functions, dry runs and JSON plans.
  const lean = mkdtempSync(join(tmpdir(), 'fireside-init-lean-'));
  const plan = log();
  scaffold({...options, 'no-functions':true, 'dry-run':true, json:true}, lean, plan);
  assert.ok(!existsSync(join(lean, 'firebase.json')));
  const parsed = JSON.parse(plan.out[0]);
  assert.equal(parsed.functions, false);
  assert.equal(parsed.applied, false);
  assert.ok(parsed.files.every(file => file.action === 'write' && !file.path.includes('functions')));
  scaffold({...options, 'no-functions':true, project:'demo-lean'}, lean, log());
  const leanConfig = readJson(join(lean, 'firebase.json'));
  assert.equal(leanConfig.functions, undefined);
  assert.deepEqual(Object.keys(leanConfig.emulators), ['auth', 'firestore', 'pubsub', 'storage', 'hub', 'logging', 'ui', 'singleProjectMode']);
  assert.equal(loadProject(options, lean).minimumFunctions, '0');
  assert.throws(() => scaffold({...options, project:'Nope'}, mkdtempSync(join(tmpdir(), 'fireside-init-bad-')), log()), /Invalid project id/);
});
test('init --adopt lists skips, errors and additions, then applies only the additions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-adopt-'));
  const original = {hosting:{public:'public'}, firestore:{rules:'firestore.rules', indexes:'firestore.indexes.json'}, functions:{source:'functions'},
    emulators:{hosting:{port:5000}, firestore:{port:8080}}};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(original, null, 2));
  let output = log();
  assert.equal(adopt({...options, 'dry-run':true}, dir, output), 0);
  const text = output.err.join('\n');
  assert.match(text, /skip\s+Fireside: firebase\.json configures the hosting emulator, which Fireside does not implement; skipping it/);
  assert.match(text, /add\s+add emulators\.functions \{port: 5001\}/);
  assert.match(text, /add\s+set \.firebaserc projects\.default = demo-fireside-adopt-\S+ \(create the file\)/);
  assert.match(text, /add\s+write Firestore rules \(official init template\)/);
  assert.match(text, /add\s+write Firestore indexes/);
  assert.match(text, /Dry run: nothing was written/);
  assert.doesNotMatch(text, /error/);
  assert.ok(!existsSync(join(dir, '.firebaserc')) && !existsSync(join(dir, 'firestore.rules')));
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'), JSON.stringify(original, null, 2));
  output = log();
  assert.equal(adopt({...options, json:true, project:'demo-chosen'}, dir, output), 0);
  const report = JSON.parse(output.out[0]);
  assert.equal(report.project, 'demo-chosen');
  assert.deepEqual(report.services, ['firestore', 'functions']);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1);
  assert.deepEqual(report.additions.map(item => item.target), ['emulators.functions', 'projects.default', join(dir, 'firestore.rules'), join(dir, 'firestore.indexes.json')]);
  assert.equal(report.applied, false);
  assert.ok(!existsSync(join(dir, '.firebaserc')), '--json prints only');
  // Apply.
  output = log();
  assert.equal(adopt({...options, project:'demo-chosen'}, dir, output), 0);
  const updated = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(Object.keys(updated), ['hosting', 'firestore', 'functions', 'emulators'], 'key order is preserved');
  assert.deepEqual(updated.emulators, {hosting:{port:5000}, firestore:{port:8080}, functions:{port:5001}});
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects:{default:'demo-chosen'}});
  assert.match(readFileSync(join(dir, 'firestore.rules'), 'utf8'), /service cloud\.firestore/);
  assert.deepEqual(readJson(join(dir, 'firestore.indexes.json')), {indexes:[], fieldOverrides:[]});
  output = log();
  assert.equal(adopt(options, dir, output), 0);
  assert.match(output.err.join('\n'), /ok\s+nothing to change; services: firestore, functions/);
  // Hard errors block the run and leave every file alone.
  const broken = {...updated, emulators:{...updated.emulators, firestore:{host:'198.51.100.8', port:8080}, wat:{}, auth:{host:'198.51.100.9'}}};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(broken));
  output = log();
  assert.equal(adopt(options, dir, output), 1);
  assert.match(output.err.join('\n'), /error\s+Unsupported configured emulator: wat[\s\S]*error\s+Unsupported host for auth[\s\S]*Fix the errors above/);
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'), JSON.stringify(broken));
  writeFileSync(join(dir, 'firebase.json'), '{not json');
  assert.throws(() => adopt(options, dir, log()), /not valid JSON/);
  assert.throws(() => adopt(options, mkdtempSync(join(tmpdir(), 'fireside-adopt-none-')), log()), /does not exist; run fireside init without --adopt/);
});
// The fake hub lives in this process, so subprocesses that talk to it must
// not block the event loop: spawn asynchronously.
function runCli(args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {cwd, env:{...process.env, FIRESIDE_LOCATOR_DIR:locatorDir}});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return once(child, 'close').then(([status]) => ({status, stdout, stderr}));
}
test('the command line dispatches the new commands without an installed engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-dispatch-'));
  const run = (...args) => runCli(args, dir);
  assert.equal((await run('use', '--add', 'demo-dispatch')).status, 0);
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects:{default:'demo-dispatch'}});
  assert.equal((await run('target:apply', 'storage', 'main', 'demo-dispatch.appspot.com')).status, 0);
  assert.deepEqual(readJson(join(dir, '.firebaserc')).targets, {'demo-dispatch':{storage:{main:['demo-dispatch.appspot.com']}}});
  assert.equal((await run('target:clear', 'storage', 'main')).status, 0);
  const plan = await run('init', '--dry-run', '--json', '--no-functions');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).project, 'demo-dispatch', 'an existing .firebaserc default names the scaffold');
  assert.match((await run('emulators:export')).stderr, /exactly one destination directory/);
  assert.match((await run('emulators:export', 'a', 'b')).stderr, /exactly one destination directory/);
  assert.match((await run('firestore:delete', 'users', '--import', 'x')).stderr, /--import is not an option of fireside firestore:delete/);
  assert.match((await run('use', 'a', 'b')).stderr, /at most one alias/);
  assert.match((await run('init', 'extra')).stderr, /Unexpected argument extra/);
  assert.match((await run('use', '--', 'x')).stderr, /Only emulators:exec accepts a command after --/);
  // export and delete reach the fake hub through the locator file.
  const {dir:configured} = project();
  const destination = join(configured, '..', `fireside-export-${process.pid}-c`);
  const exported = await runCli(['emulators:export', destination, '--json'], configured);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).targets, ['firestore', 'auth']);
  rmSync(destination, {recursive:true, force:true});
  const deleted = await runCli(['firestore:delete', 'users', '-r', '-f', '--json'], configured);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(JSON.parse(deleted.stdout), {path:'users', mode:'recursive', deleted:3});
  const refused = await runCli(['firestore:delete', 'users', '-r'], configured);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Re-run: fireside firestore:delete users -r --force/);
});
