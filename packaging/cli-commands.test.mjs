// The CLI commands that never start the engine: emulators:export,
// firestore:delete, functions:invoke and the MCP server against a fake
// hub/emulator set, .firebaserc edits, init.
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
import { EMULATED_SERVICE_ACCOUNT, invokeFunction, matchParams, runInvoke, substituteParams } from '../packages/cli/src/invoke.mjs';
import { PROTOCOL_VERSIONS, TOOLS, createMcpServer, validateArguments } from '../packages/cli/src/mcp.mjs';
import { decodeFields, decodeValue, encodeFields, encodeValue } from '../packages/cli/src/firestore-values.mjs';

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

// Function definitions in the official /backends shape (firebase-tools
// emulatedFunctionsFromEndpoints), one of each trigger kind the shell drives.
const definition = (name, platform, extra, region = 'us-central1') => ({entryPoint:name, platform, region, name, id:`${region}-${name}`, codebase:'default',
  availableMemoryMb:256, labels:{}, timeoutSeconds:60, secretEnvironmentVariables:[], ...extra});
const DEFINITIONS = [
  definition('onUserDoc', 'gcfv1', {eventTrigger:{eventType:'providers/cloud.firestore/eventTypes/document.write', resource:'projects/demo-fixture/databases/(default)/documents/users/{uid}', service:'firestore.googleapis.com'}}),
  definition('onUserDoc', 'gcfv1', {eventTrigger:{eventType:'providers/cloud.firestore/eventTypes/document.write', resource:'projects/demo-fixture/databases/(default)/documents/users/{uid}', service:'firestore.googleapis.com'}}, 'europe-west1'),
  definition('onUserCreated', 'gcfv2', {eventTrigger:{eventType:'google.cloud.firestore.document.v1.created', eventFilters:{database:'(default)', namespace:'(default)'}, eventFilterPathPatterns:{document:'users/{uid}'}}}),
  definition('onPostDeleted', 'gcfv2', {eventTrigger:{eventType:'google.cloud.firestore.document.v1.deleted.withAuthContext', eventFilters:{database:'(default)', namespace:'(default)'}, eventFilterPathPatterns:{document:'users/{uid}/posts/{postId}'}}}),
  definition('onUpload', 'gcfv2', {eventTrigger:{eventType:'google.cloud.storage.object.v1.finalized', resource:'demo-fixture.appspot.com', eventFilters:{bucket:'demo-fixture.appspot.com'}}}),
  definition('onUploadV1', 'gcfv1', {eventTrigger:{eventType:'google.storage.object.finalize', resource:'projects/_/buckets/demo-fixture.appspot.com', service:'storage.googleapis.com'}}),
  definition('onOrder', 'gcfv2', {eventTrigger:{eventType:'google.cloud.pubsub.topic.v1.messagePublished', resource:'orders', eventFilters:{topic:'orders'}}}),
  definition('onOrderV1', 'gcfv1', {eventTrigger:{eventType:'google.pubsub.topic.publish', resource:'projects/demo-fixture/topics/orders-v1', service:'pubsub.googleapis.com'}}),
  definition('onSignup', 'gcfv1', {eventTrigger:{eventType:'providers/firebase.auth/eventTypes/user.create', resource:'projects/demo-fixture', service:'firebaseauth.googleapis.com'}}),
  definition('nightly', 'gcfv2', {eventTrigger:{eventType:'pubsub', resource:''}, schedule:{schedule:'every 24 hours'}}),
  definition('nightlyV1', 'gcfv1', {eventTrigger:{eventType:'pubsub', resource:''}, schedule:{schedule:'every 24 hours'}}),
  definition('onOrderPlaced', 'gcfv2', {eventTrigger:{eventType:'com.example.order.placed', channel:'projects/demo-fixture/locations/us-central1/channels/firebase', eventFilters:{}, eventFilterPathPatterns:{}}}),
  definition('processTask', 'gcfv2', {httpsTrigger:{}, taskQueueTrigger:{retryConfig:{}, rateLimits:{}}}),
  definition('helloWorld', 'gcfv2', {httpsTrigger:{}}),
  definition('addMessage', 'gcfv2', {httpsTrigger:{}, labels:{'deployment-callable':'true'}}),
  definition('beforeCreate', 'gcfv2', {blockingTrigger:{eventType:'providers/cloud.auth/eventTypes/user.beforeCreate', options:{}}}),
  definition('onRtdb', 'gcfv2', {eventTrigger:{eventType:'google.firebase.database.ref.v1.written', eventFilters:{instance:'demo-fixture-default-rtdb'}, eventFilterPathPatterns:{ref:'x/{id}'}}}),
];
// The trigger keys the running suite would hold: generation 3 for every
// background function (a stale generation 2 too), the channel suffix for the
// Eventarc custom event, the plain id for HTTPS functions.
const TRIGGER_KEYS = DEFINITIONS.flatMap(def => {
  if (!def.eventTrigger) return [def.id];
  const keys = [`${def.id}-2`, `${def.id}-3`];
  return def.eventTrigger.channel ? keys.map(key => `${key}-${def.eventTrigger.channel}`) : keys;
});
const USERS = [{localId:'alice', email:'alice@example.test', emailVerified:true, displayName:'Alice', customAttributes:'{"admin":true}', createdAt:'1700000000000', lastLoginAt:'1700000001000', providerUserInfo:[{providerId:'password', rawId:'alice@example.test', email:'alice@example.test'}]},
  {localId:'bob', phoneNumber:'+15555550100', disabled:true}];
const DOCUMENT = {name:'projects/demo-fixture/databases/(default)/documents/users/alice', fields:{name:{stringValue:'Alice'}, age:{integerValue:'41'}, score:{doubleValue:1.5},
  admin:{booleanValue:true}, nothing:{nullValue:'NULL_VALUE'}, joined:{timestampValue:'2026-01-02T03:04:05.678Z'}, tags:{arrayValue:{values:[{stringValue:'a'}, {integerValue:'2'}]}},
  address:{mapValue:{fields:{city:{stringValue:'Springfield'}}}}, friend:{referenceValue:'projects/demo-fixture/databases/(default)/documents/users/bob'},
  where:{geoPointValue:{latitude:1.5, longitude:-2.5}}, blob:{bytesValue:'aGk='}}, createTime:'2026-01-01T00:00:00Z', updateTime:'2026-01-02T00:00:00Z'};

// One HTTP server plays the hub and every emulator of the suite.
const fake = {requests:[], running:{}, exportStatus:200, deleted:3, publishStatus:200};
let locatorDir;
before(async () => {
  fake.deadPort = await unusedPort();
  fake.server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      const parsed = body ? JSON.parse(body) : undefined;
      fake.requests.push({method:request.method, url:request.url, path, query:Object.fromEntries(url.searchParams), headers:request.headers, body:parsed});
      const reply = (status, value) => { response.writeHead(status, {'content-type':'application/json'}); response.end(JSON.stringify(value)); };
      const text = (status, value) => { response.writeHead(status, {'content-type':'text/html; charset=utf-8'}); response.end(value); };
      if (request.method === 'GET' && path === '/') return reply(200, {version:'15.22.0', origins:[fake.origin], pid:process.pid, host:'127.0.0.1', port:fake.port});
      if (request.method === 'GET' && path === '/emulators') return reply(200, fake.running);
      if (request.method === 'POST' && path === '/_admin/export') return reply(fake.exportStatus, fake.exportStatus === 200 ? {message:'OK'} : {message:'synthetic export failure'});
      if (request.method === 'DELETE' && path.startsWith('/emulator/v1/')) return reply(200, path.endsWith('/documents') ? {} : {deleted:fake.deleted});
      // Functions: /backends, the trigger route (an unknown key lists the valid ones), HTTPS routes.
      if (request.method === 'GET' && path === '/backends') return reply(200, {backends:[{directory:'/functions', env:{}, functionTriggers:DEFINITIONS}]});
      if (request.method === 'POST' && path.startsWith('/functions/projects/demo-fixture/triggers/')) {
        const key = decodeURIComponent(path.slice('/functions/projects/demo-fixture/triggers/'.length));
        if (!TRIGGER_KEYS.includes(key)) return text(404, `Function ${key} does not exist, valid functions are: ${TRIGGER_KEYS.join(', ')}`);
        return reply(200, {status:'acknowledged'});
      }
      if (path.startsWith('/demo-fixture/')) return reply(200, {result:{echo:request.method}});
      // Pub/Sub publish, Cloud Tasks enqueue and statistics.
      if (request.method === 'POST' && /^\/v1\/projects\/demo-fixture\/topics\/[^/]+:publish$/.test(path)) return fake.publishStatus === 200 ? reply(200, {messageIds:['42']}) : text(404, 'Topic not found');
      if (request.method === 'POST' && /^\/projects\/demo-fixture\/locations\/[^/]+\/queues\/[^/]+\/tasks$/.test(path)) return reply(200, {task:{...parsed.task, name:`${path.slice(1)}/1`}});
      if (request.method === 'GET' && path === '/queueStats') return reply(200, {'queue:demo-fixture-us-central1-processTask':{numberOfTasks:1, tasksRunning:0}});
      // Firestore REST.
      if (request.method === 'GET' && path === '/v1/projects/demo-fixture/databases/(default)/documents/users/alice') return reply(200, DOCUMENT);
      if (request.method === 'GET' && path.startsWith('/v1/projects/demo-fixture/databases/')) return reply(404, {error:{code:404, message:'Document not found', status:'NOT_FOUND'}});
      if (request.method === 'PATCH' && path.startsWith('/v1/projects/demo-fixture/databases/')) return reply(200, {name:`projects/demo-fixture/databases/(default)/documents/${path.split('/documents/')[1]}`, fields:parsed.fields, createTime:'2026-01-01T00:00:00Z', updateTime:'2026-01-03T00:00:00Z'});
      if (request.method === 'POST' && path.endsWith(':runQuery')) return reply(200, [{document:DOCUMENT, readTime:'2026-01-03T00:00:00Z'}, {readTime:'2026-01-03T00:00:00Z', done:true}]);
      if (request.method === 'POST' && path.endsWith(':listCollectionIds')) return reply(200, {collectionIds:['posts', 'settings']});
      // Auth.
      if (request.method === 'GET' && path === '/identitytoolkit.googleapis.com/v1/projects/demo-fixture/accounts:batchGet') return reply(200, {users:USERS});
      if (request.method === 'POST' && path === '/identitytoolkit.googleapis.com/v1/projects/demo-fixture/accounts:lookup') return reply(200, {users:USERS.filter(user => parsed.localId?.includes(user.localId) || parsed.email?.includes(user.email))});
      if (request.method === 'POST' && path === '/identitytoolkit.googleapis.com/v1/projects/demo-fixture/accounts') return reply(200, {kind:'identitytoolkit#SignupNewUserResponse', localId:parsed.localId ?? 'generated', email:parsed.email});
      if (request.method === 'POST' && path === '/identitytoolkit.googleapis.com/v1/projects/demo-fixture/accounts:delete') return reply(200, {kind:'identitytoolkit#DeleteAccountResponse'});
      if (request.method === 'GET' && path === '/emulator/v1/projects/demo-fixture/oobCodes') return reply(200, {oobCodes:[{email:'alice@example.test', oobCode:'code-1', oobLink:`${fake.origin}/emulator/action?mode=verifyEmail&oobCode=code-1`, requestType:'VERIFY_EMAIL'}]});
      if (request.method === 'GET' && path === '/emulator/v1/projects/demo-fixture/verificationCodes') return reply(200, {verificationCodes:[{phoneNumber:'+15555550100', sessionInfo:'s', code:'123456'}]});
      // Storage.
      if (request.method === 'GET' && path === '/v0/b/demo-fixture.appspot.com/o') return reply(200, {prefixes:['uploads/2026/'], items:[{name:'uploads/a.png', bucket:'demo-fixture.appspot.com'}]});
      if (request.method === 'GET' && path === '/v0/b/demo-fixture.appspot.com/o/uploads%2Fa.png') return reply(200, {name:'uploads/a.png', bucket:'demo-fixture.appspot.com', contentType:'image/png', size:'12', downloadTokens:'t'});
      if (request.method === 'GET' && path.startsWith('/v0/b/')) return reply(404, {error:{code:404, message:'Not Found.'}});
      reply(404, {message:'unexpected route'});
    });
  });
  fake.server.listen(0, '127.0.0.1');
  await once(fake.server, 'listening');
  fake.port = fake.server.address().port;
  fake.origin = `http://127.0.0.1:${fake.port}`;
  fake.running = {firestore:{name:'firestore', host:'127.0.0.1', port:fake.port}, auth:{name:'auth', host:'127.0.0.1', port:fake.port}};
  fake.base = fake.running;
  fake.full = Object.fromEntries(['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks', 'eventarc', 'hub'].map(name => [name, {name, host:'127.0.0.1', port:fake.port}]));
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

// --- functions:invoke ---------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// The requests since `mark`, in order.
const since = mark => fake.requests.slice(mark);
const withSuite = async (running, body) => { fake.running = running; try { return await body(); } finally { fake.running = fake.base; } };
// A background delivery: the probe that lists the keys, then the event.
function delivery(requests) {
  const posts = requests.filter(request => request.path.startsWith('/functions/projects/demo-fixture/triggers/'));
  assert.equal(posts.length, 2, 'one probe, one delivery');
  assert.match(posts[0].path, /\/triggers\/fireside-probe-[0-9a-f-]+$/);
  assert.deepEqual(posts[0].body, {});
  return {key:decodeURIComponent(posts[1].path.slice('/functions/projects/demo-fixture/triggers/'.length)), body:posts[1].body, headers:posts[1].headers};
}
// FunctionsEmulatorShell.createLegacyEvent: the fields every first-generation
// event carries; returns the rest for the per-service assertions.
function legacy(body, eventType, resource) {
  const {eventId, timestamp, auth, ...rest} = body;
  assert.match(eventId, UUID);
  assert.match(timestamp, ISO);
  assert.equal(rest.eventType, eventType);
  assert.equal(rest.resource, resource);
  assert.deepEqual(auth, {admin:false}, 'the shell sends {admin: false} without --auth (variable is undefined)');
  delete rest.eventType; delete rest.resource;
  return rest;
}
// FunctionsEmulatorShell.createCloudEvent: the structured CloudEvent fields.
function cloud(body, type, source) {
  const {specversion, datacontenttype, id, time, ...rest} = body;
  assert.equal(specversion, '1.0');
  assert.equal(datacontenttype, 'application/json');
  assert.match(id, UUID);
  assert.match(time, ISO);
  assert.equal(rest.type, type);
  assert.equal(rest.source, source);
  delete rest.type; delete rest.source;
  return rest;
}
// LocalFunction.makeFirestoreValue: fields plus one creation/update time.
function firestoreValue(value, fields, name) {
  assert.deepEqual(Object.keys(value).sort(), ['createTime', 'fields', 'name', 'updateTime']);
  assert.deepEqual(value.fields, fields);
  assert.match(value.createTime, ISO);
  assert.equal(value.updateTime, value.createTime);
  assert.equal(value.name, name);
}

test('functions:invoke without --event-data calls the HTTPS route through the hub-listed Functions port', async () => {
  const {dir} = project();
  await withSuite(fake.full, async () => {
    const mark = fake.requests.length;
    const output = log();
    assert.equal(await invokeFunction('addMessage', {...options, data:'{"text":"hi"}'}, dir, output), 0);
    const request = since(mark).find(item => item.path === '/demo-fixture/us-central1/addMessage');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, {data:{text:'hi'}});
    assert.deepEqual(output.out, [`200 OK ${fake.origin}/demo-fixture/us-central1/addMessage`, '{"result":{"echo":"POST"}}']);
    await invokeFunction('helloWorld', {...options, method:'get', region:'europe-west1'}, dir, log());
    const plain = fake.requests[fake.requests.length - 1];
    assert.equal(plain.method, 'GET');
    assert.equal(plain.path, '/demo-fixture/europe-west1/helloWorld');
    assert.equal(plain.body, undefined);
    await assert.rejects(invokeFunction('addMessage', {...options, data:'{nope'}, dir, log()), /--data must be JSON/);
  });
  // No hub and nothing on the configured port: the plain call reports the route it tried.
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({functions:{source:'functions'}, emulators:{functions:{port:fake.deadPort}, hub:{port:await unusedPort()}}}));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-nohub'}}));
  await assert.rejects(invokeFunction('helloWorld', options, dir, log()), new RegExp(`no Functions emulator answered at http://127\\.0\\.0\\.1:${fake.deadPort}/demo-nohub/us-central1/helloWorld`));
});
test('functions:invoke --event-data resolves the trigger key from the route listing and refuses non-background functions', async () => {
  const {dir} = project();
  await withSuite(fake.full, async () => {
    const mark = fake.requests.length;
    const result = await runInvoke('onUserCreated', {...options, 'event-data':'{"name":"Bob"}', params:'{"uid":"bob"}'}, dir);
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'functions');
    assert.equal(result.key, 'us-central1-onUserCreated-3', 'the newest generation wins over the stale key');
    assert.ok(result.keys.includes('us-central1-helloWorld'));
    const {key, headers} = delivery(since(mark));
    assert.equal(key, 'us-central1-onUserCreated-3');
    assert.equal(headers['content-type'], 'application/json', 'sendRequest posts JSON');
    await assert.rejects(runInvoke('onUserDoc', {...options, 'event-data':'{}', resource:'users/a'}, dir), /deployed in several regions; pass --region: onUserDoc \(us-central1, firestore\), onUserDoc \(europe-west1, firestore\)/);
    await assert.rejects(runInvoke('nope', {...options, 'event-data':'{}'}, dir), /No function nope is loaded; the running suite has: onUserDoc \(us-central1, firestore\)/);
    await assert.rejects(runInvoke('addMessage', {...options, 'event-data':'{}'}, dir), /addMessage is an HTTPS callable function; call it with --data/);
    await assert.rejects(runInvoke('helloWorld', {...options, 'event-data':'{}'}, dir), /helloWorld is an HTTPS function; call it with --data/);
    await assert.rejects(runInvoke('beforeCreate', {...options, 'event-data':'{}'}, dir), /Auth blocking function/);
    await assert.rejects(runInvoke('onRtdb', {...options, 'event-data':'{}'}, dir), /Realtime Database, which Fireside does not emulate/);
    await assert.rejects(runInvoke('onUserCreated', {...options, 'event-data':'{nope'}, dir), /--event-data must be JSON/);
    await assert.rejects(runInvoke('onUserCreated', {...options, 'event-data':'{}', params:'[1]'}, dir), /--params must be a JSON object/);
  });
  await withSuite({...fake.full, functions:undefined}, () => assert.rejects(runInvoke('onUserCreated', {...options, 'event-data':'{}'}, dir), /did not start Functions/));
});
test('Firestore events carry the shell envelopes: legacy for gcfv1, structured CloudEvent for gcfv2', async () => {
  const {dir} = project();
  const name = 'projects/demo-fixture/databases/(default)/documents/users/alice';
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    await runInvoke('onUserDoc', {...options, region:'us-central1', 'event-data':'{"before":{"n":1},"after":{"n":2,"tags":["a",true,null,1.5],"nested":{"k":"v"}}}', resource:'users/alice'}, dir);
    let {key, body} = delivery(since(mark));
    assert.equal(key, 'us-central1-onUserDoc-3');
    let rest = legacy(body, 'providers/cloud.firestore/eventTypes/document.write', name);
    assert.deepEqual(rest.params, {uid:'alice'}, 'wildcards are read back from --resource');
    assert.deepEqual(Object.keys(rest.data), ['value', 'oldValue']);
    firestoreValue(rest.data.value, {n:{integerValue:2}, tags:{arrayValue:{values:[{stringValue:'a'}, {booleanValue:true}, {nullValue:'NULL_VALUE'}, {doubleValue:1.5}]}}, nested:{mapValue:{fields:{k:{stringValue:'v'}}}}}, name);
    firestoreValue(rest.data.oldValue, {n:{integerValue:1}}, name);
    // --params substitutes the pattern; --auth is passed as the shell's {admin, variable}.
    mark = fake.requests.length;
    await runInvoke('onUserDoc', {...options, region:'us-central1', 'event-data':'{"after":{"n":3}}', params:'{"uid":"carol"}', auth:'{"uid":"carol","token":{"email":"c@example.test"}}'}, dir);
    ({body} = delivery(since(mark)));
    assert.equal(body.resource, 'projects/demo-fixture/databases/(default)/documents/users/carol');
    assert.deepEqual(body.auth, {admin:false, variable:{uid:'carol', token:{email:'c@example.test'}}});
    assert.deepEqual(body.data.oldValue, {});
    // gcfv2 created: source, document and the SDK's project/database/namespace attributes.
    mark = fake.requests.length;
    await runInvoke('onUserCreated', {...options, 'event-data':'{"name":"Bob"}', resource:'/users/bob/'}, dir);
    ({key, body} = delivery(since(mark)));
    assert.equal(key, 'us-central1-onUserCreated-3');
    rest = cloud(body, 'google.cloud.firestore.document.v1.created', 'projects/_/databases/(default)');
    assert.deepEqual(Object.keys(rest).sort(), ['data', 'database', 'document', 'namespace', 'project']);
    assert.equal(rest.document, 'users/bob');
    assert.equal(rest.project, 'demo-fixture');
    assert.equal(rest.database, '(default)');
    assert.equal(rest.namespace, '(default)');
    assert.deepEqual(rest.data.oldValue, {});
    firestoreValue(rest.data.value, {name:{stringValue:'Bob'}}, 'projects/demo-fixture/databases/(default)/documents/users/bob');
    // A plain document (no before/after) is the created/deleted document; withAuthContext adds the official attributes.
    mark = fake.requests.length;
    await runInvoke('onPostDeleted', {...options, 'event-data':'{"title":"t"}', resource:'users/bob/posts/p1'}, dir);
    ({body} = delivery(since(mark)));
    rest = cloud(body, 'google.cloud.firestore.document.v1.deleted.withAuthContext', 'projects/_/databases/(default)');
    assert.equal(rest.document, 'users/bob/posts/p1');
    assert.equal(rest.authtype, 'unknown');
    assert.equal(rest.authid, 'fake-auth-id@gmail.com');
    assert.deepEqual(rest.data.value, {});
    firestoreValue(rest.data.oldValue, {title:{stringValue:'t'}}, 'projects/demo-fixture/databases/(default)/documents/users/bob/posts/p1');
    // Without --resource or --params the shell substitutes wildcard names with a digit.
    mark = fake.requests.length;
    const result = await runInvoke('onUserCreated', {...options, 'event-data':'{}'}, dir);
    assert.match(result.envelope.document, /^users\/uid[1-9]$/);
    await assert.rejects(runInvoke('onUserCreated', {...options, 'event-data':'{}', resource:'users'}, dir), /not a document path/);
    await assert.rejects(runInvoke('onUserCreated', {...options, 'event-data':'"text"', resource:'users/x'}, dir), /Firestore data must be key-value pairs/);
  });
});
test('Storage, Auth and schedule events carry the shell envelopes with the official resource names', async () => {
  const {dir} = project();
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    await runInvoke('onUpload', {...options, 'event-data':'{"name":"uploads/a.png","contentType":"image/png","size":12}'}, dir);
    let {key, body} = delivery(since(mark));
    assert.equal(key, 'us-central1-onUpload-3');
    let rest = cloud(body, 'google.cloud.storage.object.v1.finalized', 'projects/_/buckets/demo-fixture.appspot.com');
    assert.deepEqual(Object.keys(rest), ['data']);
    const object = rest.data;
    assert.equal(object.kind, 'storage#object');
    assert.equal(object.bucket, 'demo-fixture.appspot.com');
    assert.equal(object.name, 'uploads/a.png');
    assert.equal(object.contentType, 'image/png');
    assert.equal(object.size, '12', 'sizes are strings as in the official metadata');
    assert.equal(object.metageneration, '1');
    assert.match(object.generation, /^\d+$/);
    assert.equal(object.id, `demo-fixture.appspot.com/uploads/a.png/${object.generation}`);
    assert.match(object.timeCreated, ISO);
    assert.equal(object.updated, object.timeCreated);
    assert.equal(object.storageClass, 'STANDARD');
    assert.equal(object.selfLink, `${fake.origin}/storage/v1/b/demo-fixture.appspot.com/o/uploads%2Fa.png`);
    assert.equal(object.mediaLink, `${fake.origin}/download/storage/v1/b/demo-fixture.appspot.com/o/uploads%2Fa.png?generation=${object.generation}&alt=media`);
    mark = fake.requests.length;
    await runInvoke('onUploadV1', {...options, 'event-data':'{"name":"b.txt","bucket":"other-bucket"}'}, dir);
    ({key, body} = delivery(since(mark)));
    assert.equal(key, 'us-central1-onUploadV1-3');
    rest = legacy(body, 'google.storage.object.finalize', 'projects/_/buckets/other-bucket/objects/b.txt');
    assert.equal(rest.data.bucket, 'other-bucket');
    assert.equal(rest.data.contentType, 'application/octet-stream');
    assert.equal(rest.params, undefined);
    await assert.rejects(runInvoke('onUpload', {...options, 'event-data':'{}'}, dir), /Storage events need the object in --event-data/);
    // Auth user.create: a UserRecord with defaulted uid and metadata.
    mark = fake.requests.length;
    await runInvoke('onSignup', {...options, 'event-data':'{"email":"new@example.test"}'}, dir);
    ({key, body} = delivery(since(mark)));
    assert.equal(key, 'us-central1-onSignup-3');
    rest = legacy(body, 'providers/firebase.auth/eventTypes/user.create', 'projects/demo-fixture');
    assert.match(rest.data.uid, UUID);
    assert.equal(rest.data.email, 'new@example.test');
    assert.match(rest.data.metadata.creationTime, ISO);
    assert.equal(rest.data.metadata.lastSignInTime, rest.data.metadata.creationTime);
    mark = fake.requests.length;
    await runInvoke('onSignup', {...options, 'event-data':'{"uid":"u1","metadata":{"creationTime":"2026-01-01T00:00:00.000Z"}}', resource:'projects/other'}, dir);
    ({body} = delivery(since(mark)));
    assert.equal(body.resource, 'projects/other');
    assert.equal(body.data.uid, 'u1');
    assert.equal(body.data.metadata.creationTime, '2026-01-01T00:00:00.000Z');
    // Schedules: an empty CloudEvent with Cloud Scheduler's headers for gcfv2, a legacy pubsub event for gcfv1.
    mark = fake.requests.length;
    await runInvoke('nightly', {...options, 'event-data':'{}'}, dir);
    let sent = delivery(since(mark));
    assert.equal(sent.key, 'us-central1-nightly-3');
    rest = cloud(sent.body, 'pubsub', '');
    assert.deepEqual(rest, {data:{}});
    assert.equal(sent.headers['x-cloudscheduler-jobname'], 'firebase-schedule-nightly-us-central1');
    assert.match(sent.headers['x-cloudscheduler-scheduletime'], ISO);
    mark = fake.requests.length;
    await runInvoke('nightlyV1', {...options, 'event-data':'{}'}, dir);
    sent = delivery(since(mark));
    assert.equal(sent.key, 'us-central1-nightlyV1-3');
    rest = legacy(sent.body, 'pubsub', 'projects/demo-fixture/topics/firebase-schedule-nightlyV1');
    assert.deepEqual(rest, {data:{}});
    assert.equal(sent.headers['x-cloudscheduler-jobname'], undefined);
  });
});
test('Pub/Sub events publish through the broker when it runs, otherwise carry the shell envelopes', async () => {
  const {dir} = project();
  const encoded = Buffer.from('{"id":7}').toString('base64');
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    const result = await runInvoke('onOrder', {...options, 'event-data':'{"data":{"id":7},"attributes":{"k":"v"},"orderingKey":"o"}'}, dir);
    assert.equal(result.transport, 'pubsub');
    assert.equal(result.topic, 'orders');
    const publish = since(mark).find(request => request.path.endsWith(':publish'));
    assert.equal(publish.path, '/v1/projects/demo-fixture/topics/orders:publish');
    assert.deepEqual(publish.body, {messages:[{data:encoded, attributes:{k:'v'}, orderingKey:'o'}]});
    assert.ok(!since(mark).some(request => request.path.includes('/triggers/')), 'the broker delivers; no direct trigger post');
    mark = fake.requests.length;
    await runInvoke('onOrderV1', {...options, 'event-data':'{"data":"plain text"}'}, dir);
    assert.deepEqual(since(mark).find(request => request.path.endsWith(':publish')).body, {messages:[{data:Buffer.from('plain text').toString('base64')}]}, 'string data is sent verbatim');
    // The broker does not know the topic: fall back to the direct envelope.
    fake.publishStatus = 404;
    try {
      mark = fake.requests.length;
      const direct = await runInvoke('onOrder', {...options, 'event-data':'{"data":{"id":7},"attributes":{"k":"v"}}'}, dir);
      assert.equal(direct.transport, 'functions');
      const {key, body} = delivery(since(mark));
      assert.equal(key, 'us-central1-onOrder-3');
      const rest = cloud(body, 'google.cloud.pubsub.topic.v1.messagePublished', 'orders');
      assert.deepEqual(Object.keys(rest), ['data']);
      assert.deepEqual(Object.keys(rest.data), ['message']);
      const {messageId, ...message} = rest.data.message;
      assert.match(messageId, UUID);
      assert.deepEqual(message, {data:encoded, attributes:{k:'v'}});
    } finally { fake.publishStatus = 200; }
    await assert.rejects(runInvoke('onOrder', {...options, 'event-data':'{}'}, dir), /needs data or at least one attribute/);
    await assert.rejects(runInvoke('onOrder', {...options, 'event-data':'{"data":1,"attributes":{"n":1}}'}, dir), /attributes must be a map of strings/);
  });
  // Without a Pub/Sub emulator the first-generation event goes straight to the trigger route.
  await withSuite({...fake.full, pubsub:undefined}, async () => {
    const mark = fake.requests.length;
    const result = await runInvoke('onOrderV1', {...options, 'event-data':'{"data":{"id":7},"attributes":{"k":"v"}}'}, dir);
    assert.equal(result.transport, 'functions');
    const {key, body} = delivery(since(mark));
    assert.equal(key, 'us-central1-onOrderV1-3');
    const rest = legacy(body, 'google.pubsub.topic.publish', 'projects/demo-fixture/topics/orders-v1');
    assert.deepEqual(rest, {data:{data:encoded, attributes:{k:'v'}}});
  });
});
test('Eventarc custom events use the channel key; task queue functions are enqueued through the Tasks emulator', async () => {
  const {dir} = project();
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    await runInvoke('onOrderPlaced', {...options, 'event-data':'{"orderId":"o1"}'}, dir);
    let {key, body} = delivery(since(mark));
    assert.equal(key, 'us-central1-onOrderPlaced-3-projects/demo-fixture/locations/us-central1/channels/firebase');
    assert.deepEqual(cloud(body, 'com.example.order.placed', ''), {data:{orderId:'o1'}});
    mark = fake.requests.length;
    await runInvoke('onOrderPlaced', {...options, 'event-data':'{}', 'event-type':'com.example.order.cancelled'}, dir);
    ({body} = delivery(since(mark)));
    assert.equal(body.type, 'com.example.order.cancelled');
    // Task queue: the Admin SDK's enqueue payload against the Tasks emulator.
    mark = fake.requests.length;
    const result = await runInvoke('processTask', {...options, 'event-data':'{"job":1}'}, dir);
    assert.equal(result.transport, 'tasks');
    assert.equal(result.ok, true);
    const enqueue = since(mark).find(request => request.path.includes('/queues/'));
    assert.equal(enqueue.method, 'POST');
    assert.equal(enqueue.path, '/projects/demo-fixture/locations/us-central1/queues/processTask/tasks');
    assert.equal(enqueue.headers.authorization, 'Bearer owner');
    assert.deepEqual(enqueue.body, {task:{httpRequest:{url:'', oidcToken:{serviceAccountEmail:EMULATED_SERVICE_ACCOUNT}, body:Buffer.from('{"data":{"job":1}}').toString('base64'), headers:{'Content-Type':'application/json'}}}});
    assert.ok(!since(mark).some(request => request.path.includes('/triggers/')));
    const output = log();
    assert.equal(await invokeFunction('processTask', {...options, 'event-data':'{"job":2}'}, dir, output), 0);
    assert.match(output.err[0], /taskQueue event for processTask \(us-central1, gcfv2\) via the Cloud Tasks emulator/);
    assert.equal(output.out[0], `200 OK ${fake.origin}/projects/demo-fixture/locations/us-central1/queues/processTask/tasks`);
    const printed = log();
    await invokeFunction('onOrderPlaced', {...options, 'event-data':'{}', json:true}, dir, printed);
    const report = JSON.parse(printed.out[0]);
    assert.equal(report.kind, 'eventarc');
    assert.equal(report.envelope.type, 'com.example.order.placed');
    assert.deepEqual(report.body, {status:'acknowledged'});
  });
  await withSuite({...fake.full, tasks:undefined}, () => assert.rejects(runInvoke('processTask', {...options, 'event-data':'{}'}, dir), /did not start Cloud Tasks/));
});
test('path helpers and the Firestore value codec follow the shell encoder and round-trip the sentinels', () => {
  assert.deepEqual(matchParams('users/{uid}/posts/{postId}', 'users/a/posts/b'), {uid:'a', postId:'b'});
  assert.deepEqual(matchParams('users/{uid}/{rest=**}', 'users/a/b/c'), {uid:'a', rest:'b/c'});
  assert.deepEqual(matchParams(undefined, 'users/a'), {});
  assert.equal(substituteParams('users/{uid}/posts/{postId}', {uid:'a', postId:'b'}), 'users/a/posts/b');
  assert.match(substituteParams('users/{uid}', {}), /^users\/uid[1-9]$/);
  assert.deepEqual(encodeFields({s:'x', b:false, i:3, d:2.5, n:null, a:[1, 'two'], m:{k:1}, t:{$timestamp:'2026-01-01T00:00:00Z'}, r:{$ref:'users/bob'}, g:{$geo:{latitude:1, longitude:2}}, y:{$bytes:'aGk='}, u:undefined}, {project:'demo-fixture'}),
    {s:{stringValue:'x'}, b:{booleanValue:false}, i:{integerValue:3}, d:{doubleValue:2.5}, n:{nullValue:'NULL_VALUE'}, a:{arrayValue:{values:[{integerValue:1}, {stringValue:'two'}]}}, m:{mapValue:{fields:{k:{integerValue:1}}}},
      t:{timestampValue:'2026-01-01T00:00:00.000Z'}, r:{referenceValue:'projects/demo-fixture/databases/(default)/documents/users/bob'}, g:{geoPointValue:{latitude:1, longitude:2}}, y:{bytesValue:'aGk='}});
  assert.deepEqual(encodeValue(new Date('2026-02-03T04:05:06Z')), {timestampValue:'2026-02-03T04:05:06.000Z'});
  assert.throws(() => encodeFields('nope'), /key-value pairs/);
  assert.throws(() => encodeValue({$ref:'users/bob'}), /needs a project/);
  assert.throws(() => encodeValue({$timestamp:'yesterday'}), /RFC 3339/);
  assert.throws(() => encodeValue(Number.POSITIVE_INFINITY), /Cannot encode/);
  const decoded = decodeFields(DOCUMENT.fields);
  assert.deepEqual(decoded, {name:'Alice', age:41, score:1.5, admin:true, nothing:null, joined:{$timestamp:'2026-01-02T03:04:05.678Z'}, tags:['a', 2], address:{city:'Springfield'},
    friend:{$ref:'users/bob'}, where:{$geo:{latitude:1.5, longitude:-2.5}}, blob:{$bytes:'aGk='}});
  assert.deepEqual(encodeFields(decoded, {project:'demo-fixture'}).friend, DOCUMENT.fields.friend, 'a read document writes back with its types');
  assert.equal(decodeValue({integerValue:'9007199254740993'}), '9007199254740993', 'unsafe integers stay strings');
  assert.equal(decodeValue({doubleValue:'NaN'}), NaN);
});

// --- fireside mcp -------------------------------------------------------------
const rpc = (id, method, params) => ({jsonrpc:'2.0', id, method, ...(params === undefined ? {} : {params})});
const quiet = {log() {}, error() {}};
const text = response => JSON.parse(response.result.content[0].text);
test('the MCP server negotiates the protocol, lists its tools and validates calls without a running suite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-mcp-'));
  const server = createMcpServer({...options, project:'demo-fixture'}, dir, quiet);
  const init = await server.handle(rpc(1, 'initialize', {protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'test', version:'0'}}));
  assert.equal(init.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
  assert.deepEqual(init.result.capabilities, {tools:{}});
  assert.equal(init.result.serverInfo.name, 'fireside');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.equal((await server.handle(rpc(2, 'initialize', {protocolVersion:'1999-01-01'}))).result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown version gets the latest');
  assert.equal(await server.handle({jsonrpc:'2.0', method:'notifications/initialized'}), undefined, 'notifications get no response');
  assert.deepEqual(await server.handle(rpc(3, 'ping')), {jsonrpc:'2.0', id:3, result:{}});
  const list = await server.handle(rpc(4, 'tools/list'));
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['fireside_status', 'firestore_get', 'firestore_query', 'firestore_set', 'firestore_delete', 'firestore_list_collections',
    'auth_list_users', 'auth_get_user', 'auth_create_user', 'auth_delete_user', 'auth_oob_codes', 'auth_verification_codes', 'storage_list', 'storage_get_metadata',
    'functions_list', 'functions_invoke', 'pubsub_publish', 'tasks_stats', 'emulators_export']);
  for (const tool of list.result.tools) {
    assert.ok(tool.description.length > 20 && !tool.description.includes('\n'), `${tool.name} has a one-line description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  assert.equal(TOOLS.length, list.result.tools.length);
  const only = createMcpServer({...options, project:'demo-fixture', only:'auth,tasks'}, dir, quiet);
  assert.deepEqual((await only.handle(rpc(5, 'tools/list'))).result.tools.map(tool => tool.name), ['fireside_status', 'auth_list_users', 'auth_get_user', 'auth_create_user', 'auth_delete_user', 'auth_oob_codes', 'auth_verification_codes', 'tasks_stats', 'emulators_export']);
  assert.throws(() => createMcpServer({...options, only:'wat'}, dir), /wat is not a tool group/);
  assert.equal((await server.handle(rpc(6, 'resources/list'))).error.code, -32601);
  assert.equal((await server.handle(rpc(7, 'tools/call', {name:'nope'}))).error.code, -32602);
  assert.equal((await server.handle(rpc(8, 'tools/call', {name:'firestore_get', arguments:{}}))).error.message, 'Invalid arguments for firestore_get: missing required argument path');
  assert.equal((await server.handle(rpc(9, 'tools/call', {name:'firestore_get', arguments:{path:1}}))).error.message, 'Invalid arguments for firestore_get: path must be a string');
  assert.equal((await server.handle(rpc(10, 'tools/call', {name:'firestore_query', arguments:{collection:'users', where:[{field:'a', op:'~', value:1}]}}))).error.message, 'Invalid arguments for firestore_query: where[0]: op must be one of ==, !=, <, <=, >, >=, array-contains, array-contains-any, in, not-in');
  assert.equal((await server.handle(rpc(11, 'tools/call', {name:'auth_list_users', arguments:{maxResults:0}}))).error.code, -32602);
  assert.equal((await server.handle({jsonrpc:'1.0', id:12, method:'ping'})).error.code, -32600);
  assert.equal(validateArguments({type:'object', properties:{}, required:[]}, {extra:1}), 'unknown argument extra');
  // A suite that is not running is a tool error, not a protocol error.
  const absent = createMcpServer({...options, project:'demo-absent'}, dir, quiet);
  const status = await absent.handle(rpc(13, 'tools/call', {name:'fireside_status', arguments:{}}));
  assert.equal(status.result.isError, undefined);
  assert.equal(text(status).running, false);
  assert.match(text(status).error, /Did not find a running emulator hub for project demo-absent/);
  const get = await absent.handle(rpc(14, 'tools/call', {name:'firestore_get', arguments:{path:'users/alice'}}));
  assert.equal(get.result.isError, true);
  assert.match(text(get).error, /Did not find a running emulator hub for project demo-absent/);
  // No project at all.
  const none = createMcpServer(options, dir, quiet);
  assert.match(text(await none.handle(rpc(15, 'tools/call', {name:'fireside_status', arguments:{}}))).error, /No firebase\.json/);
});
test('MCP tools reach the emulators through the hub listing with the owner token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-mcp-tools-'));
  const server = createMcpServer({...options, project:'demo-fixture'}, dir, quiet);
  const callTool = async (name, args) => { const response = await server.handle(rpc(1, 'tools/call', {name, arguments:args})); assert.equal(response.result.isError, undefined, response.result.content[0].text); return text(response); };
  await withSuite(fake.full, async () => {
    const status = await callTool('fireside_status', {});
    assert.equal(status.running, true);
    assert.equal(status.hub.origin, fake.origin);
    assert.deepEqual(Object.keys(status.emulators), Object.keys(fake.full));
    assert.equal(status.locator.contents.origins[0], fake.origin);
    let mark = fake.requests.length;
    const alice = await callTool('firestore_get', {path:'/users/alice'});
    assert.equal(since(mark)[since(mark).length - 1].headers.authorization, 'Bearer owner');
    assert.equal(alice.exists, true);
    assert.equal(alice.path, 'users/alice');
    assert.deepEqual(alice.data.friend, {$ref:'users/bob'});
    assert.equal(alice.data.age, 41);
    assert.deepEqual(await callTool('firestore_get', {path:'users/nobody', database:'other'}), {path:'users/nobody', exists:false});
    mark = fake.requests.length;
    const query = await callTool('firestore_query', {collection:'users/alice/posts', where:[{field:'age', op:'>=', value:18}, {field:'tag', op:'in', value:['a']}], orderBy:[{field:'age', direction:'desc'}], limit:5});
    const run = since(mark).find(request => request.path.endsWith(':runQuery'));
    assert.equal(run.path, '/v1/projects/demo-fixture/databases/(default)/documents/users/alice:runQuery');
    assert.deepEqual(run.body, {structuredQuery:{from:[{collectionId:'posts'}], limit:5, where:{compositeFilter:{op:'AND', filters:[{fieldFilter:{field:{fieldPath:'age'}, op:'GREATER_THAN_OR_EQUAL', value:{integerValue:18}}}, {fieldFilter:{field:{fieldPath:'tag'}, op:'IN', value:{arrayValue:{values:[{stringValue:'a'}]}}}}]}}, orderBy:[{field:{fieldPath:'age'}, direction:'DESCENDING'}]}});
    assert.equal(query.count, 1);
    assert.equal(query.documents[0].data.name, 'Alice');
    mark = fake.requests.length;
    await callTool('firestore_query', {collection:'users', where:[{field:'name', op:'==', value:'Alice'}]});
    assert.deepEqual(since(mark).find(request => request.path.endsWith(':runQuery')).body.structuredQuery.where, {fieldFilter:{field:{fieldPath:'name'}, op:'EQUAL', value:{stringValue:'Alice'}}});
    mark = fake.requests.length;
    const set = await callTool('firestore_set', {path:'users/carol', data:{name:'Carol', 'first name':'C'}, merge:true});
    const patch = since(mark).find(request => request.method === 'PATCH');
    assert.equal(patch.path, '/v1/projects/demo-fixture/databases/(default)/documents/users/carol');
    assert.match(patch.url, /\?updateMask\.fieldPaths=name&updateMask\.fieldPaths=%60first%20name%60$/);
    assert.deepEqual(patch.body, {fields:{name:{stringValue:'Carol'}, 'first name':{stringValue:'C'}}});
    assert.deepEqual(set.data, {name:'Carol', 'first name':'C'});
    mark = fake.requests.length;
    await callTool('firestore_set', {path:'users/carol', data:{name:'Carol'}});
    assert.equal(since(mark).find(request => request.method === 'PATCH').url, '/v1/projects/demo-fixture/databases/(default)/documents/users/carol', 'no mask replaces the document');
    mark = fake.requests.length;
    assert.deepEqual(await callTool('firestore_delete', {path:'users/carol', recursive:true}), {path:'users/carol', mode:'recursive', deleted:3});
    assert.equal(since(mark).find(request => request.method === 'DELETE').url, '/emulator/v1/projects/demo-fixture/databases/(default)/documents/users/carol?mode=recursive');
    mark = fake.requests.length;
    assert.deepEqual(await callTool('firestore_list_collections', {}), {path:null, collectionIds:['posts', 'settings']});
    assert.equal(since(mark).find(request => request.path.endsWith(':listCollectionIds')).path, '/v1/projects/demo-fixture/databases/(default)/documents:listCollectionIds');
    await callTool('firestore_list_collections', {path:'users/alice'});
    assert.equal(fake.requests[fake.requests.length - 1].path, '/v1/projects/demo-fixture/databases/(default)/documents/users/alice:listCollectionIds');
    // Auth.
    mark = fake.requests.length;
    const users = await callTool('auth_list_users', {maxResults:2});
    const batch = since(mark).find(request => request.path.endsWith(':batchGet'));
    assert.equal(batch.method, 'GET');
    assert.deepEqual(batch.query, {maxResults:'2'});
    assert.equal(batch.headers.authorization, 'Bearer owner');
    assert.equal(users.count, 2);
    assert.deepEqual(users.users[0], {uid:'alice', email:'alice@example.test', emailVerified:true, phoneNumber:null, displayName:'Alice', photoUrl:null, disabled:false, customClaims:{admin:true}, tenantId:null,
      providers:[{providerId:'password', rawId:'alice@example.test', email:'alice@example.test', displayName:null}], mfa:[], createdAt:'2023-11-14T22:13:20.000Z', lastLoginAt:'2023-11-14T22:13:21.000Z'});
    assert.equal(users.users[1].disabled, true);
    mark = fake.requests.length;
    assert.equal((await callTool('auth_get_user', {email:'alice@example.test'})).user.uid, 'alice');
    assert.deepEqual(since(mark).find(request => request.path.endsWith(':lookup')).body, {email:['alice@example.test']});
    assert.deepEqual(await callTool('auth_get_user', {uid:'zed'}), {found:false});
    mark = fake.requests.length;
    const created = await callTool('auth_create_user', {uid:'dan', email:'dan@example.test', password:'synthetic-pass', emailVerified:true});
    const signup = since(mark).find(request => request.path.endsWith('/accounts'));
    assert.equal(signup.method, 'POST');
    assert.deepEqual(signup.body, {localId:'dan', email:'dan@example.test', password:'synthetic-pass', emailVerified:true});
    assert.equal(created.uid, 'dan');
    mark = fake.requests.length;
    assert.deepEqual(await callTool('auth_delete_user', {uid:'dan'}), {uid:'dan', deleted:true});
    assert.deepEqual(since(mark).find(request => request.path.endsWith(':delete')).body, {localId:'dan'});
    assert.equal((await callTool('auth_oob_codes', {})).oobCodes[0].oobCode, 'code-1');
    assert.equal((await callTool('auth_verification_codes', {})).verificationCodes[0].code, '123456');
    // Storage.
    mark = fake.requests.length;
    const listed = await callTool('storage_list', {prefix:'uploads'});
    const listing = since(mark).find(request => request.path === '/v0/b/demo-fixture.appspot.com/o');
    assert.deepEqual(listing.query, {prefix:'uploads/', delimiter:'/', maxResults:'100'});
    assert.equal(listing.headers.authorization, 'Bearer owner');
    assert.deepEqual(listed.prefixes, ['uploads/2026/']);
    assert.equal(listed.items[0].name, 'uploads/a.png');
    assert.equal((await callTool('storage_get_metadata', {path:'uploads/a.png'})).contentType, 'image/png');
    assert.deepEqual(await callTool('storage_get_metadata', {bucket:'demo-fixture.appspot.com', path:'missing.txt'}), {bucket:'demo-fixture.appspot.com', path:'missing.txt', exists:false});
    // Functions.
    const functions = await callTool('functions_list', {});
    assert.equal(functions.count, DEFINITIONS.length);
    const byName = Object.fromEntries(functions.functions.map(item => [`${item.name}@${item.region}`, item]));
    assert.deepEqual(byName['addMessage@us-central1'], {name:'addMessage', region:'us-central1', platform:'gcfv2', entryPoint:'addMessage', codebase:'default', kind:'callable', url:`${fake.origin}/demo-fixture/us-central1/addMessage`});
    assert.equal(byName['onUserDoc@europe-west1'].kind, 'firestore');
    assert.equal(byName['nightly@us-central1'].schedule, 'every 24 hours');
    assert.equal(byName['onOrderPlaced@us-central1'].channel, 'projects/demo-fixture/locations/us-central1/channels/firebase');
    assert.equal(byName['processTask@us-central1'].kind, 'taskQueue');
    mark = fake.requests.length;
    const invoked = await callTool('functions_invoke', {name:'onUserCreated', eventData:{name:'Eve'}, resource:'users/eve'});
    assert.equal(invoked.transport, 'functions');
    assert.equal(invoked.key, 'us-central1-onUserCreated-3');
    assert.equal(delivery(since(mark)).body.document, 'users/eve');
    assert.deepEqual((await callTool('functions_invoke', {name:'addMessage', data:{text:'hi'}})).body, {result:{echo:'POST'}});
    const refused = await server.handle(rpc(2, 'tools/call', {name:'functions_invoke', arguments:{name:'helloWorld', eventData:{}}}));
    assert.equal(refused.result.isError, true);
    assert.match(text(refused).error, /HTTPS function/);
    // Pub/Sub, Tasks, export.
    mark = fake.requests.length;
    const published = await callTool('pubsub_publish', {topic:'projects/demo-fixture/topics/orders', data:{id:1}, attributes:{k:'v'}});
    assert.deepEqual(published.messageIds, ['42']);
    assert.deepEqual(since(mark).find(request => request.path.endsWith(':publish')).body, {messages:[{data:Buffer.from('{"id":1}').toString('base64'), attributes:{k:'v'}}]});
    assert.deepEqual(await callTool('tasks_stats', {}), {'queue:demo-fixture-us-central1-processTask':{numberOfTasks:1, tasksRunning:0}});
    const destination = join(dir, '..', `fireside-export-${process.pid}-mcp`);
    const exported = await callTool('emulators_export', {path:destination});
    assert.deepEqual(exported.targets, ['firestore', 'auth', 'storage']);
    assert.equal(exported.ok, true);
    rmSync(destination, {recursive:true, force:true});
  });
  await withSuite({firestore:fake.base.firestore}, async () => {
    const missing = await server.handle(rpc(3, 'tools/call', {name:'auth_list_users', arguments:{}}));
    assert.equal(missing.result.isError, true);
    assert.match(text(missing).error, /did not start Auth/);
  });
});
test('fireside mcp over stdio writes only JSON-RPC lines to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-mcp-stdio-'));
  fake.running = fake.full;
  try {
    const child = spawn(process.execPath, [cli, 'mcp', '--project', 'demo-fixture', '--only', 'firestore,functions'], {cwd:dir, env:{...process.env, FIRESIDE_LOCATOR_DIR:locatorDir}});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = [rpc(1, 'initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'test', version:'0'}}), {jsonrpc:'2.0', method:'notifications/initialized'},
      rpc(2, 'tools/list'), rpc(3, 'tools/call', {name:'fireside_status', arguments:{}}), rpc(4, 'tools/call', {name:'firestore_get', arguments:{path:'users/alice'}}), 'not json', rpc(5, 'ping')];
    child.stdin.end(`${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    const [status] = await once(child, 'close');
    assert.equal(status, 0, stderr);
    const responses = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(responses.every(response => response.jsonrpc === '2.0' && ('result' in response || 'error' in response)), 'every stdout line is a JSON-RPC response');
    const byId = Object.fromEntries(responses.map(response => [response.id, response]));
    assert.equal(byId[1].result.protocolVersion, '2025-06-18');
    assert.equal(byId[2].result.tools.length, 9, 'status, five Firestore tools, two Functions tools and export');
    assert.equal(text(byId[3]).running, true);
    assert.equal(text(byId[4]).data.name, 'Alice');
    assert.deepEqual(byId[5].result, {});
    assert.deepEqual(byId.null, {jsonrpc:'2.0', id:null, error:{code:-32700, message:'Parse error'}});
    assert.equal(responses.length, 6);
    assert.match(stderr, /fireside mcp .* tools over stdio for project demo-fixture; local emulators only/);
  } finally { fake.running = fake.base; }
});
