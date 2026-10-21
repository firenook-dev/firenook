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
import { setMember } from '../packages/cli/src/json-text.mjs';
import { buildPlan } from '../packages/cli/src/build.mjs';
import { EMULATED_SERVICE_ACCOUNT, invokeFunction, matchParams, runInvoke, substituteParams } from '../packages/cli/src/invoke.mjs';
import { PROTOCOL_VERSIONS, TOOLS, TOOL_GROUPS, createMcpServer, validateArguments } from '../packages/cli/src/mcp.mjs';
import { manifest } from '../packages/cli/src/binary.mjs';
import { decodeFields, decodeValue, encodeFields, encodeValue } from '../packages/cli/src/firestore-values.mjs';

const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs', import.meta.url));
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
  const dir = mkdtempSync(join(tmpdir(), 'firenook-commands-'));
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

// The engine's Console API (`/console/api/v1` on the UI port), as much of it
// as the MCP tools call. Bulk actions answer a running job that the jobs route
// then reports finished, as the engine's jobs do.
const CONSOLE = {jobs:new Map(), objects:new Map([['demo-fixture.appspot.com/docs/a.txt', {type:'text/plain', bytes:Buffer.from('hello world')}],
  ['demo-fixture.appspot.com/img/p.png', {type:'image/png', bytes:Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5])}]])};
const LOG_LINE = {cursor:'5a62a7b2.48', time:'2026-01-03T00:00:00.000Z', level:'error', service:'functions', source:'functions[us-central1-helloWorld]', function:'us-central1-helloWorld',
  codebase:'default', execution:'eb524d-8', message:'Unhandled error Error: boom\n    at handler (index.js:3:9)', payload:{orderId:'o1'}};
const CALL = {id:'eb524d-8', seq:8, functionId:'us-central1-helloWorld', codebase:'default', kind:'http', origin:'client', cause:{type:'http', method:'POST', path:'/'}, summary:'POST /',
  startedAt:'2026-01-03T00:00:00.000Z', durationMs:204.258833, outcome:'failed', outcomeClass:'failed', status:500, callableStatus:null, cold:true, attempt:1, eventId:null, replayOf:null, logCount:1, error:null};
const EVENT = {id:'ab12cd-1', seq:1, eventId:'e-1', receivedAt:'2026-01-03T00:00:00.000Z', channel:'projects/demo-fixture/locations/us-central1/channels/firebase', eventType:'com.example.order.placed',
  source:'firenook-mcp', subject:null, publisher:null, origin:'console', matched:1, delivered:1, failed:0, pending:0, filtered:0, unheard:0, error:null};
function consoleJob(kind, title, outcome = {}) {
  const id = `job-${CONSOLE.jobs.size + 1}`;
  const finished = {id, kind, section:kind.split('.')[0], title, total:outcome.done ?? 1, done:1, skipped:0, errors:[], errorCount:0, state:'done', startedAt:'2026-01-03T00:00:00Z', finishedAt:'2026-01-03T00:00:01Z', ...outcome};
  CONSOLE.jobs.set(id, finished);
  return {...finished, state:'running', done:0, finishedAt:null, result:undefined};
}
function fakeConsole(request, response, url, body, raw, reply) {
  const path = url.pathname.slice('/console/api/v1'.length);
  const query = Object.fromEntries(url.searchParams);
  const route = `${request.method} ${path}`;
  const fail = (status, code, message, fix) => reply(status, {error:{code, message, ...(fix ? {fix} : {})}});
  if (request.method !== 'GET' && !/json/.test(request.headers['content-type'] ?? '') && !request.headers['x-firenook-console']) return fail(415, 'unsupported-media-type', 'Console API changes are sent as JSON.');
  if (route === 'POST /agents/calls') {
    if (fake.beaconStatus === 'hang') { fake.hanging.push(response); return undefined; }
    response.writeHead(fake.beaconStatus ?? 204); return response.end();
  }
  RULES_ROUTES?.(route, query, body, reply, fail);
  if (response.headersSent) return undefined;
  if (request.method === 'GET' && path.startsWith('/jobs/')) {
    const job = CONSOLE.jobs.get(decodeURIComponent(path.slice('/jobs/'.length)));
    return job ? reply(200, job) : fail(404, 'not-found', 'There is no job.');
  }
  // Auth.
  if (route === 'POST /auth/tokens') {
    if (body.uid !== 'alice') return fail(404, 'not-found', `The Auth emulator has no user ${body.uid} in this project.`);
    return reply(200, {idToken:'header.payload.', expiresAt:'2026-01-03T01:00:00Z', refreshToken:'refresh-1', customToken:'{}', payload:{user_id:'alice', ...(body.claims ?? {admin:true})}, provider:'password', providers:['password']});
  }
  const bulk = /^POST \/auth\/users:(setClaims|removeClaims|disable|enable|revoke)$/.exec(route);
  if (bulk) {
    const missing = body.target.keys.filter(key => key.endsWith('|nobody'));
    const done = body.target.keys.length;
    return reply(202, consoleJob(`auth.${bulk[1]}`, `${bulk[1]} ${done} user${done === 1 ? '' : 's'}`, {done, skipped:bulk[1] === 'enable' ? 1 : 0, errorCount:missing.length, errors:missing.map(key => ({key, message:'USER_NOT_FOUND'}))}));
  }
  if (route === 'GET /auth/tenants') return reply(200, {items:[{tenantId:'acme-1', displayName:'Acme', users:2, allowPasswordSignup:true, enableEmailLinkSignin:false, enableAnonymousUser:false, disableAuth:false, mfaState:'DISABLED', mfaProviders:[]}], total:1, projectUsers:3});
  // Reset.
  if (route === 'POST /suite/clear') {
    if (body.sections.length > 1 && body.confirm !== 'demo-fixture') return fail(400, 'invalid-argument', 'Clearing more than one section needs confirm set to the project id, demo-fixture.', 'Type the project id to confirm, and send the request again.');
    return reply(202, consoleJob('suite.clear', 'Clear', {done:body.sections.length, result:body.sections.map((section, index) => ({section, removed:index + 3}))}));
  }
  // Storage files.
  if (route === 'GET /storage/buckets') return reply(200, {defaultBucket:'demo-fixture.appspot.com', rulesMode:'single', buckets:[{name:'demo-fixture.appspot.com', isDefault:true}], indexReady:true});
  const key = `${query.bucket}/${query.name}`;
  if (route === 'GET /storage/object' || route === 'PUT /storage/object') {
    if (request.method === 'PUT') CONSOLE.objects.set(key, {type:request.headers['content-type'], bytes:raw, metadata:request.headers['x-firenook-metadata']});
    const object = CONSOLE.objects.get(key);
    if (!object) return fail(404, 'not-found', `No object ${query.name} in gs://${query.bucket}.`);
    return reply(200, {bucket:query.bucket, name:query.name, size:object.bytes.length, contentType:object.type, customMetadata:{}, downloadTokens:['t-1'], md5Hash:'x', generation:'2', metageneration:'1', updated:'2026-01-03T00:00:00Z'});
  }
  if (route === 'GET /storage/object/media') {
    const object = CONSOLE.objects.get(key);
    if (!object) return fail(404, 'not-found', 'No object.');
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    const bytes = range ? object.bytes.subarray(Number(range[1]), Number(range[2]) + 1) : object.bytes;
    response.writeHead(range ? 206 : 200, {'content-type':object.type});
    return response.end(bytes);
  }
  if (route === 'DELETE /storage/object') {
    if (!CONSOLE.objects.delete(`${body.bucket}/${body.name}`)) return fail(404, 'not-found', `No object ${body.name} in gs://${body.bucket}.`);
    response.writeHead(204); return response.end();
  }
  const relocate = /^POST \/storage\/objects:(copy|move|delete)$/.exec(route);
  if (relocate) {
    const [source] = body.target.keys;
    if (relocate[1] === 'delete') return reply(202, consoleJob('storage.delete', `Delete ${source}`, {done:2}));
    const from = CONSOLE.objects.get(`${body.bucket}/${source}`);
    const to = `${body.destination.bucket}/${body.renameTo}`;
    if (!from) return reply(202, consoleJob(`storage.${relocate[1]}`, `Copy ${source}`, {done:1, skipped:1}));
    if (CONSOLE.objects.has(to) && body.onConflict === 'fail') return reply(202, consoleJob(`storage.${relocate[1]}`, `Copy ${source}`, {errorCount:1, errors:[{key:body.renameTo, message:`${body.renameTo} already exists.`}]}));
    CONSOLE.objects.set(to, from);
    if (relocate[1] === 'move') CONSOLE.objects.delete(`${body.bucket}/${source}`);
    return reply(202, consoleJob(`storage.${relocate[1]}`, `Copy ${source}`));
  }
  // Logs and function calls.
  if (route === 'GET /logs/entries') {
    if (/source:/.test(query.q ?? '')) return fail(400, 'invalid-argument', 'Unknown filter "source:".');
    return reply(200, {items:[LOG_LINE], older:'5a62a7b2.40', newer:null, tail:'5a62a7b2.48', anchor:null});
  }
  if (route === 'GET /logs/facets') return reply(200, {kept:51, matched:4, levels:[{value:'debug', count:0}, {value:'info', count:2}, {value:'warn', count:1}, {value:'error', count:1}], services:[{value:'functions', count:4}],
    functions:[{value:'us-central1-helloWorld', count:4}], instances:[], codebases:[{value:'default', count:4}], kinds:[{value:'function.failed', count:1}], internalHidden:3, logged:60, lastReload:null});
  if (route === 'GET /functions') return reply(200, {phase:'running', projectId:'demo-fixture', functions:[{id:'us-central1-helloWorld', name:'helloWorld'}, {id:'europe-west1-helloWorld', name:'helloWorld'}, {id:'us-central1-addMessage', name:'addMessage'}]});
  if (route === 'GET /functions/invocations') return reply(200, {page:{items:[CALL], nextCursor:null, prevCursor:null, total:{count:1, exact:true}, scanned:null}, liveCursor:'1.2'});
  if (route === 'GET /functions/invocations/eb524d-8') return reply(200, {refs:[], detail:{summary:CALL,
    request:{target:'url', method:'POST', path:'/', headers:[{name:'content-type', value:'application/json', sensitive:false}, {name:'authorization', value:null, sensitive:true}], contentType:'application/json', body:{size:13, truncated:false, encoding:'text', text:'{"data":{"a":1}}'}},
    response:{status:500, headers:[], contentType:'text/html', body:{size:21, truncated:false, encoding:'text', text:'Internal Server Error'}, chunks:1, streaming:false, clientGone:false},
    event:null, logs:[{index:0, at:'2026-01-03T00:00:00.100Z', offsetMs:100, level:'error', message:LOG_LINE.message, kind:null, fields:null, afterFinish:false}], logsDropped:0,
    timings:{workerStartMs:null, firstByteMs:204.251, totalMs:204.258833}, replayable:true, notReplayable:null, liveCursor:'1.2'}});
  if (route === 'GET /functions/invocations/gone-1') return fail(404, 'not-found', 'The engine no longer keeps invocation #1; it keeps the newest 2,000.');
  if (route === 'POST /functions/invocations/eb524d-8/replay') {
    const replayed = {...CALL, id:'eb524d-9', origin:'replay', replayOf:'eb524d-8', outcome:'succeeded', status:200, durationMs:1.5};
    response.writeHead(200, {'content-type':'application/x-ndjson'});
    return response.end([{frame:'started', invocation:{...replayed, outcome:null}}, {frame:'head', status:200, headers:[{name:'content-type', value:'application/json'}]},
      {frame:'chunk', text:'{"ok":', encoding:'text'}, {frame:'chunk', text:Buffer.from('true}').toString('base64'), encoding:'base64'}, {frame:'finished', invocation:replayed}].map(line => JSON.stringify(line)).join('\n') + '\n');
  }
  // Eventarc, Extensions.
  if (route === 'POST /eventarc/channel/publish') return reply(200, {event:EVENT});
  if (route === 'GET /eventarc/events') return reply(200, {page:{items:[EVENT], nextCursor:null, prevCursor:null, total:{count:1, exact:true}, scanned:null}, liveCursor:'x'});
  if (route === 'GET /eventarc/events/ab12cd-1' || route === 'GET /eventarc/events/ab12cd-2') return reply(200, {deliveries:[], detail:{summary:{...EVENT, id:path.split('/').pop()}, attributes:{type:EVENT.eventType}, datacontenttype:'application/json', time:null, data:{orderId:'o1'}, dataSize:16, dataTruncated:false, raw:'',
    deliveries:[{triggerKey:'k', functionId:'us-central1-onOrderPlaced', matched:true, mismatches:[], invocationId:'eb524d-12', outcome:'succeeded', durationMs:0.762291}], replayOf:path.endsWith('-2') ? 'ab12cd-1' : null}});
  if (route === 'POST /eventarc/events/ab12cd-1/replay') return reply(200, {event:{...EVENT, id:'ab12cd-2', origin:'replay'}});
  if (route === 'GET /extensions/instances') return reply(200, {phase:'running', offline:false, dropped:[], emulatedApis:[], instances:[{instanceId:'resize', written:'resize', kind:'registry', reference:'firebase/storage-resize-images', version:'0.2.0', displayName:'Resize Images', state:'running', error:null, functionCount:2, warnings:[]}]});
  if (route === 'POST /extensions/instances/resize/reload') return reply(200, {summary:{instanceId:'resize', kind:'registry', state:'running', functionCount:2, warnings:[]}, functions:[{functionId:'ext-resize-generateResizedImage', kind:'storage', status:'receiving'}]});
  if (route === 'POST /extensions/instances/nope/reload') return fail(404, 'not-found', 'There is no extension instance nope.');
  // Pub/Sub, Tasks, schedules.
  const subscription = {name:'projects/demo-fixture/subscriptions/orders-sub', topic:'projects/demo-fixture/topics/orders', delivery:'pull', managed:'no', filter:null, deadLetterTopic:null, counters:{backlog:2, outstanding:0, oldestUnackedAt:'2026-01-03T00:00:00Z'}};
  if (route === 'GET /pubsub/topics') return reply(200, {items:[{name:'projects/demo-fixture/topics/orders', kind:'user', counters:{published:5, lastPublishedAt:'2026-01-03T00:00:00Z'}, subscriptions:[subscription], functions:[{functionId:'us-central1-onOrder'}]}],
    nextCursor:null, prevCursor:null, total:{count:1, exact:true}, scanned:null, project:'demo-fixture', otherProjects:[], detached:[{...subscription, name:'projects/demo-fixture/subscriptions/old', topic:null}], revision:1});
  if (route === 'GET /pubsub/backlog') {
    if (query.subscription !== subscription.name) return fail(404, 'not-found', 'Subscription does not exist');
    return reply(200, {items:[{key:'k1', id:'41', state:'available', place:1, attempts:0, publishTime:'2026-01-03T00:00:00Z', size:300, data:{encoding:'text', text:'x'.repeat(256), truncated:true}, attributes:{k:'v'}, orderingKey:null},
      {key:'k2', id:'42', state:'outstanding', place:null, attempts:1, publishTime:'2026-01-03T00:00:01Z', size:8, data:{encoding:'json', text:'{"id":2}', truncated:false}, attributes:{}, orderingKey:null}], nextCursor:null, prevCursor:null, total:{count:2, exact:true}, scanned:null});
  }
  if (route === 'GET /pubsub/subscription') return reply(200, {subscription:{summary:subscription}, deadLetteredInHistory:0});
  if (route === 'GET /pubsub/message') return reply(200, {topic:query.topic, id:query.id, dataBase64:Buffer.from('y'.repeat(300)).toString('base64'), dataText:'y'.repeat(300), dataJson:false, attributes:{}});
  const queue = {key:'queue:demo-fixture-us-central1-processTask', project:'demo-fixture', location:'us-central1', id:'processTask', function:{functionId:'us-central1-processTask', name:'processTask'}, paused:false, counters:{pending:1, running:0}};
  if (route === 'GET /tasks/queues') return reply(200, {items:[queue], nextCursor:null, prevCursor:null, total:{count:1, exact:true}, scanned:null, project:'demo-fixture', projects:['demo-fixture'], rejectedRegistrations:[], refused:[], revision:1});
  if (route === 'GET /tasks/tasks') return reply(200, {items:[{key:'t1', id:'1', name:'projects/demo-fixture/locations/us-central1/queues/processTask/tasks/123', shortName:'123', state:'pending', attempt:0, executionCount:0,
    scheduleTime:null, dueAt:null, lastError:null, url:'http://x/processTask', body:{json:true, text:'{"data":{"id":1}}', truncated:false, size:17}}], nextCursor:null, prevCursor:null, total:{count:1, exact:true}, scanned:null});
  if (route === 'POST /tasks/task/run') return body.id === '1' ? reply(200, {started:true, message:'The task is sent on the next tick.'}) : fail(404, 'not-found', 'No task of processTask has this id.');
  const schedule = {functionId:'us-central1-nightly', functionName:'nightly', region:'us-central1', expression:'every 24 hours', timeZone:null, automatic:true, paused:false, nextRunAt:'2026-01-04T00:00:00Z', runs:1, lastRuns:[], problem:null};
  if (route === 'GET /pubsub/schedules') return reply(200, {items:[schedule, {...schedule, functionId:'us-central1-nightlyV1', functionName:'nightlyV1'}], nextCursor:null, prevCursor:null, total:{count:2, exact:true}, scanned:null});
  if (route === 'POST /pubsub/schedule/run') return reply(200, {at:'2026-01-03T00:00:00Z', trigger:'console', messageId:'7', skipped:null, delivery:{mark:'queued', invocation:null, status:null, durationMs:null, error:null, skippedReason:null}});
  fail(404, 'not-found', `unknown console API route: /api/v1${path}`);
}
let RULES_ROUTES;

// One HTTP server plays the hub and every emulator of the suite.
const fake = {requests:[], beacons:[], hanging:[], running:{}, exportStatus:200, deleted:3, publishStatus:200};
let locatorDir;
before(async () => {
  fake.deadPort = await unusedPort();
  fake.server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => { chunks.push(chunk); });
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      const raw = Buffer.concat(chunks);
      const parsed = raw.length && /json/.test(request.headers['content-type'] ?? 'json') ? JSON.parse(raw.toString('utf8')) : undefined;
      // The MCP call beacon lands after the tool answered; it is kept apart so
      // order-based assertions on fake.requests stay deterministic.
      (path === '/console/api/v1/agents/calls' ? fake.beacons : fake.requests).push({method:request.method, url:request.url, path, query:Object.fromEntries(url.searchParams), headers:request.headers, body:parsed, raw});
      const reply = (status, value) => { response.writeHead(status, {'content-type':'application/json'}); response.end(JSON.stringify(value)); };
      const text = (status, value) => { response.writeHead(status, {'content-type':'text/html; charset=utf-8'}); response.end(value); };
      if (path.startsWith('/console/api/v1/')) return fakeConsole(request, response, url, parsed, raw, reply);
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
      if (request.method === 'POST' && path.endsWith(':runAggregationQuery')) return reply(200, [{readTime:'2026-01-03T00:00:00Z', result:{aggregateFields:{count:{integerValue:'7'}}}}]);
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
  fake.full = Object.fromEntries(['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks', 'eventarc', 'hub', 'ui'].map(name => [name, {name, host:'127.0.0.1', port:fake.port}]));
  locatorDir = mkdtempSync(join(tmpdir(), 'firenook-locator-'));
  process.env.FIRENOOK_LOCATOR_DIR = locatorDir;
  writeFileSync(locatorPath('demo-fixture'), JSON.stringify({version:'15.22.0', origins:[fake.origin], pid:process.pid}));
});
after(async () => {
  await new Promise(resolve => fake.server.close(resolve));
  delete process.env.FIRENOOK_LOCATOR_DIR;
  rmSync(locatorDir, {recursive:true, force:true});
});
const lastRequest = () => fake.requests[fake.requests.length - 1];

test('emulators:export posts the running exportable targets without an Origin header', async () => {
  const {dir} = project();
  const destination = join(dir, '..', `firenook-export-${process.pid}-a`);
  const output = log();
  assert.equal(await exportEmulators(destination, {...options, json:true}, dir, output), 0);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/_admin/export');
  assert.equal(request.headers.origin, undefined);
  assert.deepEqual(request.body, {path:canonical(destination), targets:['firestore', 'auth'], initiatedBy:'firenook emulators:export'});
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
  const busy = mkdtempSync(join(tmpdir(), 'firenook-busy-'));
  writeFileSync(join(busy, 'unrelated.txt'), 'keep');
  await assert.rejects(exportEmulators(busy, options, dir, log()), /re-run with --force/);
  assert.equal(await exportEmulators(busy, {...options, force:true}, dir, log()), 0);
  const previous = mkdtempSync(join(tmpdir(), 'firenook-previous-'));
  writeFileSync(join(previous, 'firebase-export-metadata.json'), '{}');
  assert.equal(await exportEmulators(previous, options, dir, log()), 0, 'an earlier export is overwritten without --force');
  writeFileSync(join(busy, 'file'), 'x');
  await assert.rejects(exportEmulators(join(busy, 'file'), options, dir, log()), /not a directory/);
  await assert.rejects(exportEmulators(undefined, options, dir, log()), /requires a destination/);
  rmSync(busy, {recursive:true, force:true}); rmSync(previous, {recursive:true, force:true});
});
test('emulators:export reports hub failures and a missing hub, and works from the locator alone', async () => {
  const {dir} = project();
  const destination = join(dir, '..', `firenook-export-${process.pid}-b`);
  fake.exportStatus = 500;
  await assert.rejects(exportEmulators(destination, options, dir, log()), /Export request failed \(HTTP 500\): synthetic export failure/);
  fake.exportStatus = 200;
  // No firebase.json: the explicit project id and the locator file suffice.
  const bare = mkdtempSync(join(tmpdir(), 'firenook-bare-'));
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
  await assert.rejects(firestoreDelete('users', {...options, recursive:true}, ['users', '-r'], dir, log()), /without --force\. Re-run: firenook firestore:delete users -r --force/);
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
  const dir = mkdtempSync(join(tmpdir(), 'firenook-use-'));
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
  const fresh = mkdtempSync(join(tmpdir(), 'firenook-use-fresh-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'firenook-target-'));
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
  assert.throws(() => targetApply(['database', 'main', 'x'], options, dir, log()), /not implemented by Firenook/);
  assert.throws(() => targetApply(['hosting', 'main', 'x'], options, dir, log()), /not implemented by Firenook/);
  assert.throws(() => targetApply(['wat', 'main', 'x'], options, dir, log()), /Unrecognized target type wat/);
  assert.throws(() => targetApply(['storage', 'main'], options, dir, log()), /at least one resource/);
  assert.throws(() => targetClear(['storage'], options, dir, log()), /type and a target name/);
  writeFileSync(join(dir, '.firebaserc'), '{}');
  assert.throws(() => targetApply(['storage', 'main', 'x'], options, dir, log()), /Must have an active project/);
});
// No coding agent is detected from the machine running the tests.
const hermetic = {env:{}};
test('init scaffolds a runnable demo project with the official defaults and never overwrites without --force', () => {
  const root = mkdtempSync(join(tmpdir(), 'firenook-init-'));
  const dir = join(root, 'My App'); mkdirSync(dir);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const output = log();
  assert.equal(scaffold({...options, language:'javascript'}, dir, output, hermetic), 0);
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
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.firenook/\n*-debug.log\n');
  assert.equal(readFileSync(join(dir, 'functions/.gitignore'), 'utf8'), 'node_modules/\n*.local\n');
  assert.ok(!existsSync(join(dir, 'functions/node_modules')), 'nothing is installed');
  assert.ok(!existsSync(join(dir, 'package.json')), 'nothing is pinned without --yes');
  assert.match(output.err.join('\n'), /Next steps:\n {2}npm install --prefix functions\n {2}npx firenook emulators:start --keep-data$/);
  assert.equal(firestoreRules(new Date(Date.UTC(2026, 0, 15, 12))).includes('timestamp.date(2026, 2, 14)'), true);
  assert.throws(() => scaffold(options, dir, log(), hermetic), /exists; use firenook init --adopt/);
  // --force writes firebase.json again; the rules, indexes and code there
  // are the developer's, and stay as they are.
  writeFileSync(join(dir, 'firebase.json'), '{"custom":true}\n');
  writeFileSync(join(dir, 'storage.rules'), 'custom storage rules');
  writeFileSync(join(dir, 'firestore.rules'), 'custom firestore rules');
  writeFileSync(join(dir, 'firestore.indexes.json'), '{"indexes":[{"collectionGroup":"orders"}],"fieldOverrides":[]}');
  writeFileSync(join(dir, 'functions/index.js'), '// my functions\n');
  const forced = log();
  scaffold({...options, force:true, project:'demo-forced', language:'javascript'}, dir, forced, hermetic);
  assert.deepEqual(Object.keys(readJson(join(dir, 'firebase.json'))), ['firestore', 'storage', 'functions', 'emulators'], '--force writes firebase.json');
  assert.equal(readFileSync(join(dir, 'storage.rules'), 'utf8'), 'custom storage rules', '--force keeps the Storage rules');
  assert.equal(readFileSync(join(dir, 'firestore.rules'), 'utf8'), 'custom firestore rules', '--force keeps the Firestore rules');
  assert.equal(readJson(join(dir, 'firestore.indexes.json')).indexes.length, 1, '--force keeps the indexes');
  assert.equal(readFileSync(join(dir, 'functions/index.js'), 'utf8'), '// my functions\n', '--force keeps the code');
  assert.match(forced.err.join('\n'), /keep {4}.+[\\/]storage\.rules \(exists\)/);
  assert.equal(readJson(join(dir, '.firebaserc')).projects.default, 'demo-forced');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.firenook/\n*-debug.log\n', 'gitignore lines are never duplicated');
  // The scaffold passes the launcher's own checks.
  const project = loadProject(options, dir);
  assert.deepEqual(project.services, ['firestore', 'auth', 'storage', 'functions', 'pubsub']);
  assert.equal(project.minimumFunctions, '1');
  assert.equal(project.ports.logging, 4500);
  // Without Functions, dry runs and JSON plans.
  const lean = mkdtempSync(join(tmpdir(), 'firenook-init-lean-'));
  const plan = log();
  scaffold({...options, 'no-functions':true, 'dry-run':true, json:true}, lean, plan, hermetic);
  assert.ok(!existsSync(join(lean, 'firebase.json')));
  const parsed = JSON.parse(plan.out[0]);
  assert.equal(parsed.functions, false);
  assert.equal(parsed.language, 'none');
  assert.equal(parsed.applied, false);
  assert.ok(parsed.files.every(file => file.action === 'write' && !file.path.includes('functions')));
  scaffold({...options, 'no-functions':true, project:'demo-lean'}, lean, log(), hermetic);
  const leanConfig = readJson(join(lean, 'firebase.json'));
  assert.equal(leanConfig.functions, undefined);
  assert.deepEqual(Object.keys(leanConfig.emulators), ['auth', 'firestore', 'pubsub', 'storage', 'hub', 'logging', 'ui', 'singleProjectMode']);
  assert.equal(loadProject(options, lean).minimumFunctions, '0');
  assert.throws(() => scaffold({...options, project:'Nope'}, mkdtempSync(join(tmpdir(), 'firenook-init-bad-')), log(), hermetic), /Invalid project id/);
});
test('init writes a TypeScript codebase by default, built before a deploy and by --build before a start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-init-ts-'));
  const output = log();
  assert.equal(scaffold({...options, project:'demo-typed'}, dir, output, hermetic), 0);
  const config = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(config.functions.predeploy, ['npm --prefix "$RESOURCE_DIR" run build'], 'a deploy builds it first, as the official init sets up');
  const pkg = readJson(join(dir, 'functions/package.json'));
  assert.equal(pkg.main, 'lib/index.js');
  assert.deepEqual(pkg.scripts, {build:'tsc', 'build:watch':'tsc --watch', serve:'firenook emulators:start --only functions --build'});
  assert.deepEqual(pkg.devDependencies, {typescript:'^7.0.0'});
  assert.deepEqual(readJson(join(dir, 'functions/tsconfig.json')).compilerOptions, {module:'NodeNext', esModuleInterop:true, moduleResolution:'nodenext',
    noImplicitReturns:true, noUnusedLocals:true, outDir:'lib', rootDir:'src', sourceMap:true, strict:true, target:'es2017'});
  assert.match(readFileSync(join(dir, 'functions/src/index.ts'), 'utf8'), /export const helloWorld = onRequest\(/);
  assert.ok(!existsSync(join(dir, 'functions/index.js')));
  assert.equal(readFileSync(join(dir, 'functions/.gitignore'), 'utf8'), 'node_modules/\nlib/\n*.local\n');
  assert.match(output.err.join('\n'), /npx firenook emulators:start --keep-data --build$/);
  // --build runs the codebase's own scripts: build:watch for a start, build for exec.
  const project = loadProject(options, dir);
  assert.deepEqual(buildPlan(project, 'start').map(({codebase, shown, script, watch}) => ({codebase, shown, script, watch})), [{codebase:'default', shown:'functions', script:'build:watch', watch:true}]);
  assert.equal(buildPlan(project, 'exec')[0].script, 'build');
  writeFileSync(join(dir, 'functions/package.json'), JSON.stringify({scripts:{}}));
  assert.equal(buildPlan(project, 'start')[0].script, undefined, 'a codebase with no build script has nothing to build');
});
test('init --only picks the data services, the console comes along, and a chosen project becomes the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-init-only-'));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-old', staging:'demo-staging'}, targets:{}}));
  assert.equal(scaffold({...options, only:'firestore,auth', project:'demo-chosen'}, dir, log(), hermetic), 0);
  const config = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(Object.keys(config), ['firestore', 'emulators']);
  assert.deepEqual(Object.keys(config.emulators), ['auth', 'firestore', 'hub', 'logging', 'ui', 'singleProjectMode']);
  assert.equal(config.emulators.ui.enabled, true);
  assert.ok(!existsSync(join(dir, 'storage.rules')) && !existsSync(join(dir, 'functions')));
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects:{default:'demo-chosen', staging:'demo-staging'}, targets:{}}, 'the rest of .firebaserc is kept');
  assert.throws(() => scaffold({...options, only:'firestore,hosting'}, mkdtempSync(join(tmpdir(), 'firenook-init-only-')), log(), hermetic), /hosting is not an emulator firenook init sets up/);
  assert.throws(() => scaffold({...options, only:'firestore', language:'typescript'}, mkdtempSync(join(tmpdir(), 'firenook-init-only-')), log(), hermetic), /--language typescript needs functions in --only/);
  assert.throws(() => scaffold({...options, language:'go'}, mkdtempSync(join(tmpdir(), 'firenook-init-only-')), log(), hermetic), /--language takes typescript, javascript, none/);
});
test('init --adopt lists skips, errors and additions, then applies only the additions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-adopt-'));
  const original = {hosting:{public:'public'}, firestore:{rules:'firestore.rules', indexes:'firestore.indexes.json'}, functions:{source:'functions'},
    emulators:{hosting:{port:5000}, firestore:{port:8080}}};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(original, null, 2));
  let output = log();
  assert.equal(adopt({...options, 'dry-run':true}, dir, output, hermetic), 0);
  const text = output.err.join('\n');
  assert.match(text, /skip\s+Firenook: firebase\.json configures the hosting emulator, which Firenook does not implement; skipping it/);
  assert.match(text, /add\s+add emulators\.functions \{port: 5001\}/);
  assert.match(text, /add\s+set \.firebaserc projects\.default = demo-firenook-adopt-\S+ \(create the file\)/);
  assert.match(text, /add\s+write Firestore rules \(official init template\)/);
  assert.match(text, /add\s+write Firestore indexes/);
  assert.match(text, /Dry run: nothing was written/);
  assert.doesNotMatch(text, /error/);
  assert.ok(!existsSync(join(dir, '.firebaserc')) && !existsSync(join(dir, 'firestore.rules')));
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'), JSON.stringify(original, null, 2));
  output = log();
  assert.equal(adopt({...options, json:true, project:'demo-chosen'}, dir, output, hermetic), 0);
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
  assert.equal(adopt({...options, project:'demo-chosen'}, dir, output, hermetic), 0);
  const updated = readJson(join(dir, 'firebase.json'));
  assert.deepEqual(Object.keys(updated), ['hosting', 'firestore', 'functions', 'emulators'], 'key order is preserved');
  assert.deepEqual(updated.emulators, {hosting:{port:5000}, firestore:{port:8080}, functions:{port:5001}});
  assert.deepEqual(readJson(join(dir, '.firebaserc')), {projects:{default:'demo-chosen'}});
  assert.match(readFileSync(join(dir, 'firestore.rules'), 'utf8'), /service cloud\.firestore/);
  assert.deepEqual(readJson(join(dir, 'firestore.indexes.json')), {indexes:[], fieldOverrides:[]});
  output = log();
  assert.equal(adopt(options, dir, output, hermetic), 0);
  assert.match(output.err.join('\n'), /ok\s+nothing to change; services: firestore, functions/);
  // Hard errors block the run and leave every file alone.
  const broken = {...updated, emulators:{...updated.emulators, firestore:{host:'198.51.100.8', port:8080}, wat:{}, auth:{host:'198.51.100.9'}}};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(broken));
  output = log();
  assert.equal(adopt(options, dir, output, hermetic), 1);
  assert.match(output.err.join('\n'), /error\s+Unsupported configured emulator: wat[\s\S]*error\s+Unsupported host for auth[\s\S]*Fix the errors above/);
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'), JSON.stringify(broken));
  writeFileSync(join(dir, 'firebase.json'), '{not json');
  assert.throws(() => adopt(options, dir, log(), hermetic), /not valid JSON/);
  assert.throws(() => adopt(options, mkdtempSync(join(tmpdir(), 'firenook-adopt-none-')), log(), hermetic), /does not exist; run firenook init without --adopt/);
});
test('a JSON member is set as text, everything else as it was written', () => {
  assert.equal(setMember('{}', ['projects', 'default'], 'demo-a'), '{"projects": {"default": "demo-a"}}');
  assert.equal(setMember('{"projects": {"default": ""}}', ['projects', 'default'], 'demo-b'), '{"projects": {"default": "demo-b"}}');
  assert.equal(setMember('{\n  "projects": []\n}\n', ['projects', 'default'], 'demo-c'), '{\n  "projects": {"default": "demo-c"}\n}\n', 'a value that is not an object is replaced');
  assert.equal(setMember('{\n  "a": 1\n}', ['emulators', 'auth'], {port:9099}), '{\n  "a": 1,\n  "emulators": {\n    "auth": {\n      "port": 9099\n    }\n  }\n}');
  assert.equal(setMember('{\n  "a": "x\\"}"\n}', ['b'], 1), '{\n  "a": "x\\"}",\n  "b": 1\n}', 'a brace in a string is text');
});
test('init --adopt writes only what it adds, in the file\'s own layout, and says a warning is one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-adopt-layout-'));
  writeFileSync(join(dir, 'firestore.rules'), 'rules');
  // Tabs, members on one line each and no newline at the end: what is there
  // stays byte for byte, and the additions take the same layout.
  writeFileSync(join(dir, 'firebase.json'), '{\n\t"firestore": {"rules": "firestore.rules"},\n\t"functions": {"source": "functions", "ignore": ["node_modules", ".git"]}\n}');
  writeFileSync(join(dir, '.firebaserc'), '{\n    "projects": {},\n    "targets": {}\n}\n');
  let output = log();
  assert.equal(adopt({...options, project:'demo-shop', host:'0.0.0.0'}, dir, output, hermetic), 0);
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'),
    '{\n\t"firestore": {"rules": "firestore.rules"},\n\t"functions": {"source": "functions", "ignore": ["node_modules", ".git"]},\n\t"emulators": {"firestore": {"port": 8080}, "functions": {"port": 5001}}\n}');
  assert.equal(readFileSync(join(dir, '.firebaserc'), 'utf8'), '{\n    "projects": {\n        "default": "demo-shop"\n    },\n    "targets": {}\n}\n');
  const text = output.err.join('\n');
  assert.match(text, /\n {2}warn {4}Firenook: binding 0\.0\.0\.0/, 'a warning is labelled a warning');
  assert.doesNotMatch(text, /skip/, 'nothing is skipped');
  // The official layout (two spaces, a member a line, CRLF) gets entries in
  // that layout, at the end of the object they belong to.
  const official = '{\r\n  "storage": {\r\n    "rules": "storage.rules"\r\n  },\r\n  "emulators": {\r\n    "storage": {\r\n      "port": 9199\r\n    },\r\n    "ui": {\r\n      "enabled": true\r\n    }\r\n  }\r\n}\r\n';
  writeFileSync(join(dir, 'storage.rules'), 'rules');
  writeFileSync(join(dir, 'firebase.json'), official.replace('"storage": {\r\n    "rules"', '"firestore": {"rules": "firestore.rules"},\r\n  "storage": {\r\n    "rules"'));
  assert.equal(adopt({...options, project:'demo-shop'}, dir, log(), hermetic), 0);
  assert.equal(readFileSync(join(dir, 'firebase.json'), 'utf8'), official
    .replace('"storage": {\r\n    "rules"', '"firestore": {"rules": "firestore.rules"},\r\n  "storage": {\r\n    "rules"')
    .replace('"enabled": true\r\n    }\r\n', '"enabled": true\r\n    },\r\n    "firestore": {\r\n      "port": 8080\r\n    }\r\n'));
  assert.deepEqual(Object.keys(readJson(join(dir, '.firebaserc')).projects), ['default'], 'a default already there is kept');
  // An official service Firenook skips still says so.
  writeFileSync(join(dir, 'firebase.json'), '{"firestore": {"rules": "firestore.rules"}, "emulators": {"firestore": {"port": 8080}, "hosting": {"port": 5000}}}');
  output = log();
  assert.equal(adopt({...options, project:'demo-shop'}, dir, output, hermetic), 0);
  assert.match(output.err.join('\n'), /\n {2}skip {4}Firenook: firebase\.json configures the hosting emulator/);
});
// The fake hub lives in this process, so subprocesses that talk to it must
// not block the event loop: spawn asynchronously.
function runCli(args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {cwd, env:{...process.env, FIRENOOK_LOCATOR_DIR:locatorDir}});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return once(child, 'close').then(([status]) => ({status, stdout, stderr}));
}
test('the command line dispatches the new commands without an installed engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-dispatch-'));
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
  assert.match((await run('firestore:delete', 'users', '--import', 'x')).stderr, /--import is not an option of firenook firestore:delete/);
  assert.match((await run('use', 'a', 'b')).stderr, /at most one alias/);
  assert.match((await run('init', 'extra')).stderr, /Unexpected argument extra/);
  assert.match((await run('use', '--', 'x')).stderr, /Only emulators:exec accepts a command after --/);
  // export and delete reach the fake hub through the locator file.
  const {dir:configured} = project();
  const destination = join(configured, '..', `firenook-export-${process.pid}-c`);
  const exported = await runCli(['emulators:export', destination, '--json'], configured);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).targets, ['firestore', 'auth']);
  rmSync(destination, {recursive:true, force:true});
  const deleted = await runCli(['firestore:delete', 'users', '-r', '-f', '--json'], configured);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(JSON.parse(deleted.stdout), {path:'users', mode:'recursive', deleted:3});
  const refused = await runCli(['firestore:delete', 'users', '-r'], configured);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Re-run: firenook firestore:delete users -r --force/);
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
  assert.match(posts[0].path, /\/triggers\/firenook-probe-[0-9a-f-]+$/);
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
    await assert.rejects(runInvoke('onRtdb', {...options, 'event-data':'{}'}, dir), /Realtime Database, which Firenook does not emulate/);
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
  // A string finer than a millisecond keeps its precision; anything else Date reads is normalised.
  assert.deepEqual(encodeValue({$timestamp:'2026-02-03T04:05:06.123456789Z'}), {timestampValue:'2026-02-03T04:05:06.123456789Z'});
  assert.deepEqual(encodeValue({$timestamp:'2026-02-03T12:05:06.1234+08:00'}), {timestampValue:'2026-02-03T12:05:06.1234+08:00'});
  assert.deepEqual(encodeValue({$timestamp:'2026-02-03T12:05:06.5+08:00'}), {timestampValue:'2026-02-03T04:05:06.500Z'});
  assert.deepEqual(encodeValue({$timestamp:'2026-02-03'}), {timestampValue:'2026-02-03T00:00:00.000Z'});
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

// --- firenook mcp -------------------------------------------------------------
const rpc = (id, method, params) => ({jsonrpc:'2.0', id, method, ...(params === undefined ? {} : {params})});
const quiet = {log() {}, error() {}};
const text = response => JSON.parse(response.result.content[0].text);
test('the MCP server negotiates the protocol, lists its tools and validates calls without a running suite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-mcp-'));
  const server = createMcpServer({...options, project:'demo-fixture'}, dir, quiet);
  const init = await server.handle(rpc(1, 'initialize', {protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'test', version:'0'}}));
  assert.equal(init.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
  assert.deepEqual(init.result.capabilities, {tools:{}});
  assert.equal(init.result.serverInfo.name, 'firenook');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.equal((await server.handle(rpc(2, 'initialize', {protocolVersion:'1999-01-01'}))).result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown version gets the latest');
  assert.equal(await server.handle({jsonrpc:'2.0', method:'notifications/initialized'}), undefined, 'notifications get no response');
  assert.deepEqual(await server.handle(rpc(3, 'ping')), {jsonrpc:'2.0', id:3, result:{}});
  const list = await server.handle(rpc(4, 'tools/list'));
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['firenook_status', 'emulators_export',
    'firestore_get', 'firestore_query', 'firestore_count', 'firestore_set', 'firestore_delete', 'firestore_list_collections',
    'auth_list_users', 'auth_get_user', 'auth_create_user', 'auth_delete_user', 'auth_oob_codes', 'auth_verification_codes',
    'auth_mint_token', 'auth_set_claims', 'auth_remove_claims', 'auth_disable_user', 'auth_enable_user', 'auth_revoke_tokens', 'auth_list_tenants',
    'storage_list', 'storage_get_metadata', 'storage_read', 'storage_upload', 'storage_delete', 'storage_copy', 'storage_move',
    'functions_list', 'functions_invoke', 'functions_list_calls', 'functions_get_call', 'functions_replay_call', 'logs_search', 'logs_facets',
    'rules_get', 'rules_evaluate', 'rules_list_denials', 'pubsub_publish', 'pubsub_list_topics', 'pubsub_list_subscriptions', 'pubsub_peek',
    'tasks_stats', 'tasks_list', 'tasks_run', 'schedules_list', 'schedules_run', 'eventarc_publish', 'eventarc_list_events', 'eventarc_get_event', 'eventarc_replay_event',
    'extensions_list', 'extensions_reload', 'emulators_clear']);
  const strict = (where, schemaObject) => {
    assert.equal(schemaObject.type, 'object', where);
    assert.equal(schemaObject.additionalProperties, false, `${where} is strict`);
    assert.ok(Array.isArray(schemaObject.required), where);
    for (const [name, property] of Object.entries(schemaObject.properties)) {
      assert.ok(property.description || property.items, `${where}.${name} is described`);
      if (property.properties) strict(`${where}.${name}`, property);
      if (property.items?.properties) strict(`${where}.${name}[]`, property.items);
    }
  };
  for (const tool of list.result.tools) {
    assert.ok(tool.description.length > 20 && !tool.description.includes('\n'), `${tool.name} has a one-line description`);
    assert.match(tool.name, /^[a-z]+_[a-z_]+$/);
    strict(tool.name, tool.inputSchema);
  }
  for (const name of ['emulators_clear', 'storage_delete']) assert.match(TOOLS.find(tool => tool.name === name).description, /^DESTRUCTIVE: /);
  assert.equal(TOOLS.length, list.result.tools.length);
  assert.ok(TOOLS.every(tool => tool.group === 'status' || TOOL_GROUPS.includes(tool.group)), 'every tool is in a selectable group');
  const only = createMcpServer({...options, project:'demo-fixture', only:'auth,tasks'}, dir, quiet);
  assert.deepEqual((await only.handle(rpc(5, 'tools/list'))).result.tools.map(tool => tool.name), ['firenook_status', 'emulators_export', 'auth_list_users', 'auth_get_user', 'auth_create_user', 'auth_delete_user', 'auth_oob_codes', 'auth_verification_codes',
    'auth_mint_token', 'auth_set_claims', 'auth_remove_claims', 'auth_disable_user', 'auth_enable_user', 'auth_revoke_tokens', 'auth_list_tenants', 'tasks_stats', 'tasks_list', 'tasks_run']);
  const groups = createMcpServer({...options, project:'demo-fixture', only:'logs,rules,schedules,eventarc,extensions,reset'}, dir, quiet);
  assert.deepEqual((await groups.handle(rpc(5, 'tools/list'))).result.tools.map(tool => tool.name), ['firenook_status', 'emulators_export', 'logs_search', 'logs_facets', 'rules_get', 'rules_evaluate', 'rules_list_denials',
    'schedules_list', 'schedules_run', 'eventarc_publish', 'eventarc_list_events', 'eventarc_get_event', 'eventarc_replay_event', 'extensions_list', 'extensions_reload', 'emulators_clear']);
  assert.throws(() => createMcpServer({...options, only:'wat'}, dir), /wat is not a tool group; --only takes firestore, auth, storage, functions, logs, rules, pubsub, tasks, schedules, eventarc, extensions, reset/);
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
  const status = await absent.handle(rpc(13, 'tools/call', {name:'firenook_status', arguments:{}}));
  assert.equal(status.result.isError, undefined);
  assert.equal(text(status).running, false);
  assert.match(text(status).error, /Did not find a running emulator hub for project demo-absent/);
  const get = await absent.handle(rpc(14, 'tools/call', {name:'firestore_get', arguments:{path:'users/alice'}}));
  assert.equal(get.result.isError, true);
  assert.match(text(get).error, /Did not find a running emulator hub for project demo-absent/);
  assert.equal((await server.handle(rpc(15, 'tools/call', {name:'emulators_clear', arguments:{sections:['wat']}}))).error.message, 'Invalid arguments for emulators_clear: sections[0] must be one of firestore, auth, storage, pubsub, tasks');
  assert.equal((await server.handle(rpc(16, 'tools/call', {name:'rules_evaluate', arguments:{method:'get', path:'a/b', object:{size:'x'}}}))).error.message, 'Invalid arguments for rules_evaluate: object: size must be an integer');
  assert.equal((await server.handle(rpc(17, 'tools/call', {name:'rules_evaluate', arguments:{method:'get', path:'a/b', existing:3}}))).error.message, 'Invalid arguments for rules_evaluate: existing must be an object or null');
  assert.equal((await server.handle(rpc(18, 'tools/call', {name:'storage_read', arguments:{path:'a', maxBytes:2 ** 30}}))).error.message, 'Invalid arguments for storage_read: maxBytes must be at most 1048576');
  // A console tool against no suite is a tool error too.
  const logs = await absent.handle(rpc(19, 'tools/call', {name:'logs_search', arguments:{level:['error']}}));
  assert.equal(logs.result.isError, true);
  assert.match(text(logs).error, /Did not find a running emulator hub for project demo-absent/);
});
test('MCP tools reach the emulators through the hub listing with the owner token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-mcp-tools-'));
  const server = createMcpServer({...options, project:'demo-fixture'}, dir, quiet);
  const callTool = async (name, args) => { const response = await server.handle(rpc(1, 'tools/call', {name, arguments:args})); assert.equal(response.result.isError, undefined, response.result.content[0].text); return text(response); };
  await withSuite(fake.full, async () => {
    const status = await callTool('firenook_status', {});
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
    const destination = join(dir, '..', `firenook-export-${process.pid}-mcp`);
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
// One tool call against a server, failing the test on a tool error unless `expectError`.
const toolCaller = server => async (name, args, expectError = false) => {
  const response = await server.handle(rpc(1, 'tools/call', {name, arguments:args}));
  assert.ok(response.result, `${name}: ${JSON.stringify(response.error)}`);
  assert.equal(Boolean(response.result.isError), expectError, `${name}: ${response.result.content[0].text}`);
  return text(response);
};
const consoleRequest = (mark, route) => since(mark).filter(request => `${request.method} ${request.path}` === `${route.split(' ')[0]} /console/api/v1${route.split(' ')[1]}`).pop();
test('MCP Firestore count and collection-group queries', async () => {
  const callTool = toolCaller(createMcpServer({...options, project:'demo-fixture'}, mkdtempSync(join(tmpdir(), 'firenook-mcp-count-')), quiet));
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    assert.deepEqual(await callTool('firestore_count', {collection:'users', where:[{field:'age', op:'>', value:18}]}), {collection:'users', count:7});
    let request = since(mark).find(item => item.path.endsWith(':runAggregationQuery'));
    assert.equal(request.path, '/v1/projects/demo-fixture/databases/(default)/documents:runAggregationQuery');
    assert.equal(request.headers.authorization, 'Bearer owner');
    assert.deepEqual(request.body, {structuredAggregationQuery:{structuredQuery:{from:[{collectionId:'users'}], where:{fieldFilter:{field:{fieldPath:'age'}, op:'GREATER_THAN', value:{integerValue:18}}}}, aggregations:[{alias:'count', count:{}}]}});
    mark = fake.requests.length;
    assert.deepEqual(await callTool('firestore_count', {collection:'users/alice/posts', collectionGroup:true}), {collection:'users/alice/posts', collectionGroup:true, count:7});
    request = since(mark).find(item => item.path.endsWith(':runAggregationQuery'));
    assert.equal(request.path, '/v1/projects/demo-fixture/databases/(default)/documents/users/alice:runAggregationQuery');
    assert.deepEqual(request.body.structuredAggregationQuery.structuredQuery.from, [{collectionId:'posts', allDescendants:true}]);
    mark = fake.requests.length;
    const group = await callTool('firestore_query', {collection:'posts', collectionGroup:true, limit:3});
    assert.equal(group.collectionGroup, true);
    assert.deepEqual(since(mark).find(item => item.path.endsWith(':runQuery')).body, {structuredQuery:{from:[{collectionId:'posts', allDescendants:true}], limit:3}});
    assert.match((await callTool('firestore_count', {collection:'users/alice'}, true)).error, /users\/alice is a document path; pass a collection path$/);
    assert.match((await callTool('firestore_query', {collection:'users/alice', collectionGroup:true}, true)).error, /users\/alice is a document path; pass a collection path or a collection id$/);
  });
});
test('MCP console tools: logs, function calls, rules, Auth, Storage files, Eventarc, Extensions, Pub/Sub, Tasks and schedules', async () => {
  const callTool = toolCaller(createMcpServer({...options, project:'demo-fixture'}, mkdtempSync(join(tmpdir(), 'firenook-mcp-console-')), quiet));
  RULES_ROUTES = (route, query, body, reply, fail) => {
    const source = "rules_version = '2';\nservice cloud.firestore {\n  match /orders/{id} {\n    allow read: if request.auth.uid == resource.data.owner;\n  }\n}\n";
    if (route === 'GET /firestore/rules') return reply(200, {database:query.database ?? '(default)', source, enforced:true, path:'/p/firestore.rules', hash:'h1', fileSource:source, fileProblems:[]});
    if (route === 'GET /storage/rules') return fail(503, 'unavailable', 'Storage runs without rules here.');
    const allows = uid => [{line:4, from:source.indexOf('request.auth.uid'), to:source.indexOf(';\n  }'), outcome:uid === 'alice' ? 'allow' : 'deny'}];
    if (route === 'POST /firestore/rules/evaluate') {
      const [request] = body.requests;
      if (request.path === 'nowhere/x') return reply(200, {results:[{outcome:'deny', error:null, allows:[], explanation:[], truncated:false, changedKeys:null, queryReason:null}]});
      return reply(200, {results:[{outcome:request.auth?.uid === 'alice' ? 'allow' : 'deny', error:null, allows:allows(request.auth?.uid),
        explanation:[{from:source.indexOf('request.auth.uid'), to:source.indexOf('request.auth.uid') + 16, line:4, value:JSON.stringify(request.auth?.uid ?? null), error:false}], truncated:false, changedKeys:null, queryReason:null}]});
    }
    if (route === 'POST /storage/rules/evaluate') return fail(503, 'unavailable', 'Storage runs without rules here.');
    if (route === 'GET /firestore/rules/decisions/r-1') return reply(200, {requestId:'r-1', recordedOutcome:'deny', rules:source, rulesHash:'h1', result:{outcome:'deny', error:null, allows:allows('bob'), explanation:[], truncated:false}, request:{}});
    if (route === 'GET /logs/entries' && /kind:rules\.denied/.test(query.q)) {
      return reply(200, {items:[{cursor:'c.1', time:'2026-01-03T00:00:00.000Z', level:'warn', service:'firestore', kind:'rules.denied', message:'Rules denied get on orders/o1 for bob', payload:{database:'(default)', method:'get', origin:'app', path:'orders/o1', requestId:'r-1', uid:'bob'}},
        {cursor:'c.2', time:'2026-01-03T00:00:01.000Z', level:'warn', service:'storage', kind:'storage.denied', message:'Rules denied get on secret/x', payload:{bucket:'demo-fixture.appspot.com', decision:'s1', method:'get', path:'secret/x', uid:null}}], older:null, newer:null, tail:'c.2', anchor:null});
    }
  };
  try {
    await withSuite(fake.full, async () => {
      // Logs.
      let mark = fake.requests.length;
      const lines = await callTool('logs_search', {service:['functions'], level:['warn', 'error'], function:'helloWorld', text:'order failed', from:'-15m', limit:5});
      const search = consoleRequest(mark, 'GET /logs/entries');
      assert.deepEqual(search.query, {q:'service:functions level:warn level:error function:us-central1-helloWorld function:europe-west1-helloWorld "order failed"', from:'-15m', limit:'5'});
      assert.equal(search.headers['x-firenook-client'], `firenook-mcp/${manifest.version}`);
      assert.deepEqual(lines, {count:1, older:'5a62a7b2.40', lines:[{cursor:'5a62a7b2.48', time:LOG_LINE.time, level:'error', service:'functions', function:'us-central1-helloWorld', call:'eb524d-8', message:LOG_LINE.message, payload:{orderId:'o1'}}]});
      assert.match((await callTool('logs_search', {q:'source:x'}, true)).error, /HTTP 400: Unknown filter "source:"/);
      const facets = await callTool('logs_facets', {level:['error']});
      assert.deepEqual(facets.levels, {debug:0, info:2, warn:1, error:1});
      assert.deepEqual(facets.kinds, {'function.failed':1});
      // Function calls.
      mark = fake.requests.length;
      const calls = await callTool('functions_list_calls', {function:'us-central1-helloWorld', outcome:'failed', q:'took:>200ms'});
      assert.equal(consoleRequest(mark, 'GET /functions/invocations').query.q, 'function:us-central1-helloWorld outcome:failed took:>200ms');
      assert.deepEqual(calls.calls[0], {id:'eb524d-8', function:'us-central1-helloWorld', kind:'http', origin:'client', summary:'POST /', startedAt:CALL.startedAt, durationMs:204.26, outcome:'failed', status:500, cold:true, logCount:1});
      const detail = await callTool('functions_get_call', {id:'eb524d-8'});
      assert.equal(detail.error, 'Unhandled error Error: boom');
      assert.equal(detail.stack, LOG_LINE.message);
      assert.deepEqual(detail.request, {method:'POST', path:'/', contentType:'application/json', headers:{'content-type':'application/json', authorization:'(hidden)'}, body:{data:{a:1}}, size:13});
      assert.deepEqual(detail.response, {status:500, contentType:'text/html', body:'Internal Server Error', size:21});
      assert.deepEqual(detail.timings, {workerStartMs:null, firstByteMs:204.25, totalMs:204.26});
      assert.match((await callTool('functions_get_call', {id:'gone-1'}, true)).error, /HTTP 404: The engine no longer keeps invocation/);
      mark = fake.requests.length;
      const replay = await callTool('functions_replay_call', {id:'eb524d-8'});
      assert.deepEqual(consoleRequest(mark, 'POST /functions/invocations/eb524d-8/replay').body, {});
      assert.deepEqual({id:replay.id, replayOf:replay.replayOf, outcome:replay.outcome, status:replay.status, contentType:replay.contentType, body:replay.body}, {id:'eb524d-9', replayOf:'eb524d-8', outcome:'succeeded', status:200, contentType:'application/json', body:{ok:true}});
      assert.match((await callTool('functions_replay_call', {id:'gone-1'}, true)).error, /HTTP 404/);
      // Security Rules.
      const rules = await callTool('rules_get', {});
      assert.equal(rules.firestore.enforced, true);
      assert.match(rules.storage.error, /Storage runs without rules here/);
      assert.match((await callTool('rules_get', {service:'storage'}, true)).error, /HTTP 503: Storage runs without rules here/);
      mark = fake.requests.length;
      const denied = await callTool('rules_evaluate', {method:'get', path:'/orders/o1', uid:'bob', claims:{admin:false}});
      assert.deepEqual(consoleRequest(mark, 'POST /firestore/rules/evaluate').body, {requests:[{method:'get', path:'orders/o1', auth:{uid:'bob', token:{admin:false}}}]});
      assert.deepEqual({allowed:denied.allowed, outcome:denied.outcome, decidedBy:denied.decidedBy}, {allowed:false, outcome:'deny',
        decidedBy:[{line:4, condition:'request.auth.uid == resource.data.owner', text:'allow read: if request.auth.uid == resource.data.owner;', outcome:'deny'}]});
      assert.deepEqual(denied.steps, [{line:4, expression:'request.auth.uid', value:'"bob"'}]);
      const allowed = await callTool('rules_evaluate', {method:'create', path:'orders/o2', uid:'alice', data:{owner:'alice', at:{$timestamp:'2026-01-01T00:00:00Z'}}, existing:null, time:'2026-01-02T00:00:00Z'});
      assert.equal(allowed.allowed, true);
      assert.deepEqual(consoleRequest(mark, 'POST /firestore/rules/evaluate') && fake.requests.filter(item => item.path === '/console/api/v1/firestore/rules/evaluate').pop().body.requests[0],
        {method:'create', path:'orders/o2', auth:{uid:'alice', token:{}}, data:{owner:{stringValue:'alice'}, at:{timestampValue:'2026-01-01T00:00:00.000Z'}}, resource:null, time:'2026-01-02T00:00:00Z'});
      mark = fake.requests.length;
      await callTool('rules_evaluate', {method:'list', path:'orders', idToken:'h.p.', where:[{field:'owner', op:'==', value:'alice'}], limit:5, collectionGroup:true});
      assert.deepEqual(consoleRequest(mark, 'POST /firestore/rules/evaluate').body.requests[0], {method:'list', path:'orders', authorization:'Bearer h.p.', group:true,
        query:{where:{fieldFilter:{field:{fieldPath:'owner'}, op:'EQUAL', value:{stringValue:'alice'}}}, limit:5}});
      assert.deepEqual(await callTool('rules_evaluate', {method:'get', path:'nowhere/x'}), {service:'firestore', method:'get', path:'nowhere/x', as:'unauthenticated', allowed:false, outcome:'deny', decidedBy:[],
        reason:'No allow statement matches this request, so it is denied by default.'});
      assert.match((await callTool('rules_evaluate', {method:'get', path:'a/b', claims:{x:1}}, true)).error, /claims need a uid/);
      assert.match((await callTool('rules_evaluate', {service:'storage', method:'get', path:'a', data:{}}, true)).error, /for Storage pass object/);
      assert.match((await callTool('rules_evaluate', {service:'storage', method:'create', path:'a.png', uid:'u', object:{size:3}}, true)).error, /HTTP 503/);
      const denials = await callTool('rules_list_denials', {explain:true});
      assert.equal(denials.count, 2);
      assert.deepEqual(denials.denials[0].decidedBy, [{line:4, condition:'request.auth.uid == resource.data.owner', text:'allow read: if request.auth.uid == resource.data.owner;', outcome:'deny'}]);
      assert.equal(denials.denials[1].service, 'storage');
      assert.match(denials.denials[1].explainError, /HTTP 404/, 'a decision the engine lost is reported per denial');
      mark = fake.requests.length;
      assert.equal((await callTool('rules_list_denials', {service:'firestore', path:'orders', uid:'bob'})).count, 1);
      assert.equal(consoleRequest(mark, 'GET /logs/entries').query.q, 'kind:rules.denied payload.uid:bob');
      // More of Auth.
      mark = fake.requests.length;
      const token = await callTool('auth_mint_token', {uid:'alice', claims:{role:'editor'}});
      assert.deepEqual(consoleRequest(mark, 'POST /auth/tokens').body, {uid:'alice', claims:{role:'editor'}});
      assert.deepEqual({idToken:token.idToken, refreshToken:token.refreshToken, expiresAt:token.expiresAt, claims:token.claims}, {idToken:'header.payload.', refreshToken:'refresh-1', expiresAt:'2026-01-03T01:00:00Z', claims:{user_id:'alice', role:'editor'}});
      assert.match((await callTool('auth_mint_token', {uid:'zed'}, true)).error, /no user zed/);
      mark = fake.requests.length;
      assert.deepEqual(await callTool('auth_set_claims', {uid:'alice', claims:{admin:true}}), {users:['alice'], changed:1, unchanged:0});
      assert.deepEqual(consoleRequest(mark, 'POST /auth/users:setClaims').body, {target:{by:'keys', keys:['|alice']}, claims:{admin:true}, mode:'replace'});
      assert.ok(consoleRequest(mark, `GET /jobs/job-${CONSOLE.jobs.size}`), 'the job is polled until it finished');
      mark = fake.requests.length;
      await callTool('auth_remove_claims', {uids:['alice', 'bob'], tenant:'acme-1', keys:['admin']});
      assert.deepEqual(consoleRequest(mark, 'POST /auth/users:removeClaims').body, {target:{by:'keys', keys:['acme-1|alice', 'acme-1|bob']}, keys:['admin']});
      for (const [tool, action] of [['auth_disable_user', 'disable'], ['auth_revoke_tokens', 'revoke']]) {
        mark = fake.requests.length;
        assert.equal((await callTool(tool, {uid:'bob'})).changed, 1);
        assert.deepEqual(consoleRequest(mark, `POST /auth/users:${action}`).body, {target:{by:'keys', keys:['|bob']}});
      }
      assert.deepEqual(await callTool('auth_enable_user', {uid:'bob'}), {users:['bob'], changed:0, unchanged:1});
      assert.match((await callTool('auth_disable_user', {uid:'nobody'}, true)).error, /nobody: USER_NOT_FOUND/);
      assert.match((await callTool('auth_disable_user', {}, true)).error, /Name the user with uid/);
      assert.deepEqual(await callTool('auth_list_tenants', {limit:10}), {total:1, projectUsers:3, tenants:[{tenantId:'acme-1', displayName:'Acme', users:2, allowPasswordSignup:true, enableEmailLinkSignin:false, enableAnonymousUser:false, disableAuth:false, mfaState:'DISABLED', mfaProviders:[]}]});
      // Storage files.
      const text = await callTool('storage_read', {path:'docs/a.txt'});
      assert.deepEqual({encoding:text.encoding, content:text.content, truncated:text.truncated, size:text.size}, {encoding:'text', content:'hello world', truncated:false, size:11});
      mark = fake.requests.length;
      const binary = await callTool('storage_read', {path:'img/p.png', maxBytes:4});
      assert.equal(consoleRequest(mark, 'GET /storage/object/media').headers.range, 'bytes=0-3');
      assert.deepEqual({encoding:binary.encoding, content:binary.content, returnedBytes:binary.returnedBytes, truncated:binary.truncated}, {encoding:'base64', content:Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), returnedBytes:4, truncated:true});
      assert.match((await callTool('storage_read', {path:'missing'}, true)).error, /HTTP 404: No object missing/);
      mark = fake.requests.length;
      const uploaded = await callTool('storage_upload', {path:'docs/b.bin', base64:Buffer.from([1, 2, 3]).toString('base64'), customMetadata:{k:'v'}, ifNotExists:true});
      const put = consoleRequest(mark, 'PUT /storage/object');
      assert.deepEqual(put.query, {bucket:'demo-fixture.appspot.com', name:'docs/b.bin'});
      assert.deepEqual([...put.raw], [1, 2, 3]);
      assert.equal(put.headers['content-type'], 'application/octet-stream');
      assert.equal(put.headers['x-firenook-console'], '1');
      assert.equal(put.headers.authorization, 'Bearer owner');
      assert.equal(put.headers['if-none-match'], '*');
      assert.deepEqual(JSON.parse(Buffer.from(put.headers['x-firenook-metadata'].slice(4), 'base64url')), {customMetadata:{k:'v'}});
      assert.equal(uploaded.size, 3);
      await callTool('storage_upload', {path:'docs/c.txt', text:'héllo'});
      assert.equal(CONSOLE.objects.get('demo-fixture.appspot.com/docs/c.txt').bytes.toString('utf8'), 'héllo');
      assert.match((await callTool('storage_upload', {path:'x', text:'a', base64:'YQ=='}, true)).error, /exactly one of text or base64/);
      assert.deepEqual(await callTool('storage_copy', {path:'docs/a.txt', to:'archive/a.txt'}), {from:{bucket:'demo-fixture.appspot.com', path:'docs/a.txt'}, to:{bucket:'demo-fixture.appspot.com', path:'archive/a.txt'}, objects:1});
      mark = fake.requests.length;
      assert.match((await callTool('storage_copy', {path:'docs/a.txt', to:'archive/a.txt'}, true)).error, /archive\/a\.txt already exists/);
      assert.deepEqual(consoleRequest(mark, 'POST /storage/objects:copy').body, {bucket:'demo-fixture.appspot.com', target:{by:'keys', keys:['docs/a.txt']}, destination:{bucket:'demo-fixture.appspot.com', prefix:''}, renameTo:'archive/a.txt', onConflict:'fail'});
      await callTool('storage_move', {path:'archive/a.txt', to:'moved/a.txt', toBucket:'other', overwrite:true});
      assert.ok(CONSOLE.objects.has('other/moved/a.txt') && !CONSOLE.objects.has('demo-fixture.appspot.com/archive/a.txt'));
      assert.match((await callTool('storage_move', {path:'nothing.txt', to:'x.txt'}, true)).error, /nothing to move; nothing\.txt does not exist/);
      mark = fake.requests.length;
      assert.deepEqual(await callTool('storage_delete', {path:'docs/c.txt'}), {bucket:'demo-fixture.appspot.com', path:'docs/c.txt', deleted:1});
      assert.deepEqual(consoleRequest(mark, 'DELETE /storage/object').body, {bucket:'demo-fixture.appspot.com', name:'docs/c.txt'});
      assert.deepEqual(await callTool('storage_delete', {path:'docs/'}), {bucket:'demo-fixture.appspot.com', path:'docs/', deleted:2});
      assert.match((await callTool('storage_delete', {path:'docs/c.txt'}, true)).error, /HTTP 404/);
      // Eventarc.
      mark = fake.requests.length;
      const event = await callTool('eventarc_publish', {type:'com.example.order.placed', data:{orderId:'o1'}, attributes:{region:'eu'}});
      assert.deepEqual(consoleRequest(mark, 'POST /eventarc/channel/publish').body, {channel:'projects/demo-fixture/locations/us-central1/channels/firebase', type:'com.example.order.placed', source:'firenook-mcp', attributes:{region:'eu'}, encoding:'json', data:'{"orderId":"o1"}'});
      assert.deepEqual(event.deliveries, [{function:'us-central1-onOrderPlaced', matched:true, outcome:'succeeded', durationMs:0.76, call:'eb524d-12'}]);
      assert.deepEqual(event.data, {orderId:'o1'});
      mark = fake.requests.length;
      await callTool('eventarc_publish', {type:'t', text:'plain', channel:'google'});
      assert.deepEqual(consoleRequest(mark, 'POST /eventarc/channel/publish').body, {channel:'google', type:'t', source:'firenook-mcp', encoding:'text', data:'plain'});
      assert.match((await callTool('eventarc_publish', {type:'t', text:'a', data:1}, true)).error, /not both/);
      assert.equal((await callTool('eventarc_list_events', {q:'delivery:failed'})).events[0].id, 'ab12cd-1');
      assert.equal((await callTool('eventarc_get_event', {id:'ab12cd-1'})).deliveries[0].call, 'eb524d-12');
      const replayed = await callTool('eventarc_replay_event', {id:'ab12cd-1'});
      assert.deepEqual({id:replayed.id, replayOf:replayed.replayOf}, {id:'ab12cd-2', replayOf:'ab12cd-1'});
      assert.match((await callTool('eventarc_get_event', {id:'zz-9'}, true)).error, /HTTP 404/);
      // Extensions.
      assert.deepEqual((await callTool('extensions_list', {})).instances, [{instanceId:'resize', kind:'registry', reference:'firebase/storage-resize-images', version:'0.2.0', name:'Resize Images', state:'running', functionCount:2}]);
      assert.deepEqual((await callTool('extensions_reload', {instance:'resize'})).functions, [{functionId:'ext-resize-generateResizedImage', kind:'storage', status:'receiving'}]);
      assert.match((await callTool('extensions_reload', {instance:'nope'}, true)).error, /There is no extension instance nope/);
      // Pub/Sub.
      assert.deepEqual((await callTool('pubsub_list_topics', {})).topics, [{name:'projects/demo-fixture/topics/orders', kind:'user', published:5, lastPublishedAt:'2026-01-03T00:00:00Z', subscriptions:['projects/demo-fixture/subscriptions/orders-sub'], functions:['us-central1-onOrder']}]);
      const subscriptions = await callTool('pubsub_list_subscriptions', {});
      assert.deepEqual(subscriptions.subscriptions.map(item => item.name), ['projects/demo-fixture/subscriptions/orders-sub', 'projects/demo-fixture/subscriptions/old']);
      assert.equal((await callTool('pubsub_list_subscriptions', {topic:'orders'})).count, 1);
      mark = fake.requests.length;
      const peek = await callTool('pubsub_peek', {subscription:'orders-sub', full:true});
      assert.equal(consoleRequest(mark, 'GET /pubsub/backlog').query.subscription, 'projects/demo-fixture/subscriptions/orders-sub');
      assert.deepEqual(peek.messages.map(message => [message.id, message.data, message.truncated ?? null]), [['41', 'y'.repeat(300), false], ['42', {id:2}, null]]);
      assert.equal(peek.total, 2);
      assert.match((await callTool('pubsub_peek', {subscription:'nope'}, true)).error, /Subscription does not exist/);
      // Cloud Tasks.
      const tasks = await callTool('tasks_list', {});
      assert.deepEqual(tasks.queues[0].tasks, [{id:'1', name:'123', state:'pending', attempt:0, executionCount:0, scheduleTime:null, dueAt:null, url:'http://x/processTask', body:{data:{id:1}}}]);
      mark = fake.requests.length;
      assert.deepEqual(await callTool('tasks_run', {queue:'processTask', id:'1'}), {queue:'processTask', id:'1', started:true, message:'The task is sent on the next tick.'});
      assert.deepEqual(consoleRequest(mark, 'POST /tasks/task/run').body, {queue:'queue:demo-fixture-us-central1-processTask', id:'1'});
      assert.match((await callTool('tasks_run', {queue:'processTask', id:'9'}, true)).error, /No task of processTask has this id/);
      assert.match((await callTool('tasks_list', {queue:'other'}, true)).error, /No Cloud Tasks queue other; the suite has processTask/);
      // Schedules.
      assert.deepEqual((await callTool('schedules_list', {})).schedules.map(item => item.functionId), ['us-central1-nightly', 'us-central1-nightlyV1']);
      mark = fake.requests.length;
      assert.deepEqual(await callTool('schedules_run', {function:'nightly'}), {functionId:'us-central1-nightly', at:'2026-01-03T00:00:00Z', trigger:'console', messageId:'7', skipped:null, delivery:{state:'queued', call:null, status:null, durationMs:null}});
      assert.deepEqual(consoleRequest(mark, 'POST /pubsub/schedule/run').body, {functionId:'us-central1-nightly'});
      assert.match((await callTool('schedules_run', {function:'weekly'}, true)).error, /No scheduled function weekly; the suite has us-central1-nightly, us-central1-nightlyV1/);
    });
  } finally { RULES_ROUTES = undefined; }
});
test('MCP emulators_clear keeps the console\'s safeguard: more than one service names the project id', async () => {
  const callTool = toolCaller(createMcpServer({...options, project:'demo-fixture'}, mkdtempSync(join(tmpdir(), 'firenook-mcp-clear-')), quiet));
  await withSuite(fake.full, async () => {
    let mark = fake.requests.length;
    const refused = await callTool('emulators_clear', {sections:['firestore', 'auth']}, true);
    assert.equal(refused.error, 'Clearing 2 services (firestore, auth) deletes all their data; to confirm, pass confirmProject: "demo-fixture" (the project id)');
    assert.equal(consoleRequest(mark, 'POST /suite/clear'), undefined, 'nothing is cleared');
    assert.match((await callTool('emulators_clear', {sections:['firestore', 'storage'], confirmProject:'demo-other'}, true)).error, /pass confirmProject: "demo-fixture" \(the project id\), not "demo-other"/);
    mark = fake.requests.length;
    assert.deepEqual(await callTool('emulators_clear', {sections:['firestore', 'auth', 'firestore'], confirmProject:'demo-fixture'}), {project:'demo-fixture', cleared:[{section:'firestore', removed:3}, {section:'auth', removed:4}]});
    assert.deepEqual(consoleRequest(mark, 'POST /suite/clear').body, {sections:['firestore', 'auth'], confirm:'demo-fixture'});
    mark = fake.requests.length;
    assert.deepEqual(await callTool('emulators_clear', {sections:['firestore'], runTriggers:true}), {project:'demo-fixture', cleared:[{section:'firestore', removed:3}]});
    assert.deepEqual(consoleRequest(mark, 'POST /suite/clear').body, {sections:['firestore'], runTriggers:true}, 'one service needs no confirmation');
    assert.match((await callTool('emulators_clear', {sections:[]}, true)).error, /Name at least one service/);
  });
});
test('MCP console tools name the cause when the suite runs without the UI', async () => {
  const callTool = toolCaller(createMcpServer({...options, project:'demo-fixture'}, mkdtempSync(join(tmpdir(), 'firenook-mcp-noui-')), quiet));
  const {ui: _, ...withoutUi} = fake.full;
  await withSuite(withoutUi, async () => {
    for (const [name, args] of [['logs_search', {}], ['rules_get', {service:'firestore'}], ['auth_mint_token', {uid:'alice'}], ['emulators_clear', {sections:['auth']}], ['storage_read', {path:'a'}]]) {
      assert.match((await callTool(name, args, true)).error, /uses the console API, which the suite serves on the Emulator UI port, and the running suite for demo-fixture was started without the UI .*emulators\.ui\.enabled in firebase\.json, or firenook emulators:start --ui/, name);
    }
    assert.equal((await callTool('firestore_get', {path:'users/alice'})).exists, true, 'the emulator tools need no UI');
  });
});
test('MCP requests carry x-firenook-client and every tools/call posts the call beacon, fire-and-forget', async () => {
  const server = createMcpServer({...options, project:'demo-fixture'}, mkdtempSync(join(tmpdir(), 'firenook-mcp-beacon-')), quiet);
  const callTool = toolCaller(server);
  const client = `firenook-mcp/${manifest.version}`;
  await withSuite(fake.full, async () => {
    const mark = fake.requests.length;
    const beacons = fake.beacons.length;
    await callTool('firestore_get', {path:'users/alice'});
    await callTool('functions_invoke', {name:'onUserCreated', eventData:{name:'Eve'}, resource:'users/eve'});
    await callTool('emulators_export', {path:join(tmpdir(), `firenook-export-${process.pid}-beacon`)});
    await callTool('auth_get_user', {uid:'zed'});
    await server.handle(rpc(9, 'tools/call', {name:'storage_read', arguments:{path:'missing'}}));
    await server.settled();
    rmSync(join(tmpdir(), `firenook-export-${process.pid}-beacon`), {recursive:true, force:true});
    const sent = since(mark);
    assert.ok(sent.length > 8);
    for (const request of sent) assert.equal(request.headers['x-firenook-client'], client, `${request.method} ${request.path} is marked`);
    const posted = fake.beacons.slice(beacons);
    assert.deepEqual(posted.map(beacon => beacon.body), ['firestore_get', 'functions_invoke', 'emulators_export', 'auth_get_user', 'storage_read'].map(tool => ({client, tool})), 'one beacon per call, failed calls too');
    for (const beacon of posted) {
      assert.equal(beacon.method, 'POST');
      assert.equal(beacon.headers['content-type'], 'application/json');
      assert.equal(beacon.headers['x-firenook-client'], client);
    }
    // An engine without the route (404) changes nothing; one that never
    // answers neither delays the call nor holds the beacon past about a second.
    fake.beaconStatus = 404;
    try { assert.equal((await callTool('firestore_get', {path:'users/alice'})).exists, true); await server.settled(); }
    finally { delete fake.beaconStatus; }
    fake.beaconStatus = 'hang';
    try {
      const started = Date.now();
      assert.equal((await callTool('firestore_get', {path:'users/alice'})).exists, true);
      assert.ok(Date.now() - started < 900, 'the response does not wait for the beacon');
      await server.settled();
      const waited = Date.now() - started;
      assert.ok(waited >= 900 && waited < 3000, `the beacon gives up after about a second (${waited} ms)`);
    } finally {
      delete fake.beaconStatus;
      for (const response of fake.hanging.splice(0)) response.destroy();
    }
  });
  // No UI, no console, no beacon; no suite at all, no beacon either.
  const {ui: _, ...withoutUi} = fake.full;
  await withSuite(withoutUi, async () => {
    const beacons = fake.beacons.length;
    await callTool('firestore_get', {path:'users/alice'});
    await server.settled();
    assert.equal(fake.beacons.length, beacons);
  });
  // The CLI's own commands outside the server send no marker.
  const mark = fake.requests.length;
  await exportEmulators(join(tmpdir(), `firenook-export-${process.pid}-plain`), {...options, project:'demo-fixture', force:true}, mkdtempSync(join(tmpdir(), 'firenook-plain-')), log());
  rmSync(join(tmpdir(), `firenook-export-${process.pid}-plain`), {recursive:true, force:true});
  assert.ok(since(mark).length && since(mark).every(request => request.headers['x-firenook-client'] === undefined));
});
test('firenook mcp with no firebase.json and no --project finds the one running suite on every call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-mcp-discover-'));
  const locators = mkdtempSync(join(tmpdir(), 'firenook-locators-'));
  const write = (project, origin = fake.origin, pid = process.pid) => writeFileSync(join(locators, `hub-${project}.json`), JSON.stringify({version:'15.22.0', origins:[origin], pid}));
  const previous = process.env.FIRENOOK_LOCATOR_DIR;
  process.env.FIRENOOK_LOCATOR_DIR = locators;
  try {
    const server = createMcpServer(options, dir, quiet);
    const callTool = toolCaller(server);
    await withSuite(fake.full, async () => {
      // None running: tools say how to start one or name it.
      let status = await callTool('firenook_status', {});
      assert.equal(status.running, false);
      assert.deepEqual(status.found, {by:'locator'});
      assert.deepEqual(status.suites, {answering:[], stale:[]});
      assert.match(status.error, /^No running suite found: no firebase\.json in .*, no --project, and no hub locator in .* answers\. Start the emulators with firenook emulators:start in the project folder, or start firenook mcp with --project <id> \(or --config <firebase\.json>\)\.$/);
      assert.match((await callTool('firestore_get', {path:'users/alice'}, true)).error, /No running suite found.*firenook emulators:start.*--project <id>/);
      // Stale locators (nothing answers, or another suite's hub answers) do not count.
      write('demo-dead', `http://127.0.0.1:${fake.deadPort}`);
      write('demo-reused', fake.origin, 1);
      writeFileSync(join(locators, 'hub-Not_A_Project.json'), '{}');
      writeFileSync(join(locators, 'unrelated.json'), '{}');
      const stale = (await callTool('firestore_get', {path:'users/alice'}, true)).error;
      assert.match(stale, /\(stale, not answering: [^,]*hub-demo-dead\.json, [^,]*hub-demo-reused\.json\)\. Start/, 'only the locator files of valid project ids are suites');
      // A suite started after the server is found on the next call.
      write('demo-fixture');
      const alice = await callTool('firestore_get', {path:'users/alice'});
      assert.equal(alice.data.name, 'Alice');
      status = await callTool('firenook_status', {});
      assert.equal(status.project, 'demo-fixture');
      assert.deepEqual(status.found, {by:'locator', locator:join(locators, 'hub-demo-fixture.json')});
      assert.equal(status.console, `${fake.origin}/console`);
      assert.equal((await callTool('functions_invoke', {name:'addMessage', data:{text:'hi'}})).status, 200, 'functions:invoke gets the discovered project');
      const destination = join(tmpdir(), `firenook-export-${process.pid}-discovered`);
      assert.equal((await callTool('emulators_export', {path:destination})).ok, true, 'emulators:export gets the discovered project');
      rmSync(destination, {recursive:true, force:true});
      assert.equal((await callTool('auth_mint_token', {uid:'alice'})).idToken, 'header.payload.', 'console tools too');
      // Two answering: ask for --project, naming both.
      write('demo-second');
      assert.equal((await callTool('firestore_get', {path:'users/alice'}, true)).error, `2 running suites answer (demo-fixture at ${fake.origin}, demo-second at ${fake.origin}); start firenook mcp with --project <id> to choose one`);
      status = await callTool('firenook_status', {});
      assert.deepEqual(status.suites.answering.map(suite => suite.project), ['demo-fixture', 'demo-second']);
      // An explicit --project still wins, unchanged.
      const named = toolCaller(createMcpServer({...options, project:'demo-fixture'}, dir, quiet));
      assert.deepEqual((await named('firenook_status', {})).found, {by:'--project'});
      assert.equal((await named('firestore_get', {path:'users/alice'})).exists, true);
    });
  } finally {
    if (previous === undefined) delete process.env.FIRENOOK_LOCATOR_DIR; else process.env.FIRENOOK_LOCATOR_DIR = previous;
    rmSync(locators, {recursive:true, force:true});
  }
});
test('firenook mcp says on stderr how it finds the project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-mcp-line-'));
  const run = async (args, cwd) => {
    const child = spawn(process.execPath, [cli, 'mcp', ...args], {cwd, env:{...process.env, FIRENOOK_LOCATOR_DIR:locatorDir}});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end();
    await once(child, 'close');
    return stderr;
  };
  assert.match(await run([], dir), /tools over stdio for the running suite \(no firebase\.json in .* and no --project: the one hub locator in .* that answers, found on every call\); local emulators only/);
  const {dir: configured} = project();
  assert.match(await run([], configured), /tools over stdio for project demo-fixture \(from .*firebase\.json\); local emulators only/);
});
test('firenook mcp over stdio writes only JSON-RPC lines to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-mcp-stdio-'));
  fake.running = fake.full;
  try {
    const child = spawn(process.execPath, [cli, 'mcp', '--project', 'demo-fixture', '--only', 'firestore,functions'], {cwd:dir, env:{...process.env, FIRENOOK_LOCATOR_DIR:locatorDir}});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = [rpc(1, 'initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'test', version:'0'}}), {jsonrpc:'2.0', method:'notifications/initialized'},
      rpc(2, 'tools/list'), rpc(3, 'tools/call', {name:'firenook_status', arguments:{}}), rpc(4, 'tools/call', {name:'firestore_get', arguments:{path:'users/alice'}}), 'not json', rpc(5, 'ping')];
    child.stdin.end(`${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    const [status] = await once(child, 'close');
    assert.equal(status, 0, stderr);
    const responses = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(responses.every(response => response.jsonrpc === '2.0' && ('result' in response || 'error' in response)), 'every stdout line is a JSON-RPC response');
    const byId = Object.fromEntries(responses.map(response => [response.id, response]));
    assert.equal(byId[1].result.protocolVersion, '2025-06-18');
    assert.equal(byId[2].result.tools.length, 13, 'status and export, six Firestore tools and five Functions tools');
    assert.equal(text(byId[3]).running, true);
    assert.equal(text(byId[4]).data.name, 'Alice');
    assert.deepEqual(byId[5].result, {});
    assert.deepEqual(byId.null, {jsonrpc:'2.0', id:null, error:{code:-32700, message:'Parse error'}});
    assert.equal(responses.length, 6);
    assert.match(stderr, /firenook mcp .*: 13 tools over stdio for project demo-fixture \(from --project\); local emulators only/);
  } finally { fake.running = fake.base; }
});
