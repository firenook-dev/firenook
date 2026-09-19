// functions:invoke. Without --event-data: an HTTPS/callable request to the
// function's route. With --event-data: a background event shaped like the
// official functions shell builds it (firebase-tools 15.22.0
// FunctionsEmulatorShell.createLegacyEvent / createCloudEvent fed by
// LocalFunction.triggerEvent) and posted to the running suite's trigger route,
// which proxies it unchanged to the codebase worker. Pub/Sub functions go
// through the Pub/Sub emulator when it runs, task queue functions through the
// Cloud Tasks emulator, so the brokers deliver the event as they would in
// production.
import { randomUUID } from 'node:crypto';
import { findHub, resolveProject, runningServices, serviceOrigin } from './hub.mjs';
import { encodeFields, relativePath } from './firestore-values.mjs';

// The Admin SDK's placeholder for tasks enqueued against the emulator.
export const EMULATED_SERVICE_ACCOUNT = 'emulated-service-acct@email.com';
// The official Firestore emulator reports every writer with these values.
const AUTH_CONTEXT = {authtype:'unknown', authid:'fake-auth-id@gmail.com'};
const describe = error => error?.cause?.code || error?.cause?.message || error?.message || String(error);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// --data/--event-data/... arrive as JSON text from the command line and as
// parsed values from the MCP tool.
export function jsonOption(value, flag) {
  if (value === undefined || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error(`${flag} must be JSON`); }
}

// Where the suite's services answer: the hub's listing when a hub runs, else
// the configured ports (a plain HTTPS call never needed the hub).
async function locateServices(project, options) {
  let listing;
  let hub;
  try {
    hub = await findHub(project, options);
    listing = await runningServices(hub.origin);
  } catch { listing = undefined; }
  return {listing, hub, origin:name => serviceOrigin(project, name, listing, options), running:name => Boolean(listing?.[name])};
}

async function readResponse(response) {
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : ''; } catch { /* keep the text */ }
  return {status:response.status, statusText:response.statusText, ok:response.ok, body};
}

// GET /backends: the loaded function definitions in the official shape.
export async function listFunctions(functions) {
  let response;
  try { response = await fetch(`${functions}/backends`, {signal:AbortSignal.timeout(10000)}); }
  catch (error) { throw new Error(`no Functions emulator answered at ${functions}/backends (${describe(error)}); start it with fireside emulators:start`); }
  if (!response.ok) throw new Error(`${functions}/backends answered HTTP ${response.status}`);
  const body = await response.json();
  const triggers = [];
  for (const backend of Array.isArray(body?.backends) ? body.backends : []) {
    for (const trigger of Array.isArray(backend.functionTriggers) ? backend.functionTriggers : []) {
      triggers.push({...trigger, codebase:trigger.codebase ?? backend.codebase, extensionInstanceId:backend.extensionInstanceId});
    }
  }
  return triggers;
}

// How a definition is triggered, in the official shell's vocabulary.
export function triggerKind(trigger) {
  if (trigger.taskQueueTrigger) return 'taskQueue';
  if (trigger.blockingTrigger) return 'blocking';
  if (trigger.httpsTrigger) return trigger.labels?.['deployment-callable'] === 'true' ? 'callable' : 'https';
  if (trigger.schedule || trigger.scheduleTrigger) return 'schedule';
  const event = trigger.eventTrigger;
  if (!event) return 'unknown';
  if (event.channel) return 'eventarc';
  const type = String(event.eventType || '');
  if (type.includes('firestore')) return 'firestore';
  if (type.includes('database')) return 'database';
  if (type.includes('pubsub')) return 'pubsub';
  if (type.includes('storage')) return 'storage';
  if (type.includes('auth')) return 'auth';
  return 'event';
}
export const summarizeTrigger = (trigger, project, functions) => ({
  name:trigger.name, region:trigger.region, platform:trigger.platform, entryPoint:trigger.entryPoint, codebase:trigger.codebase,
  kind:triggerKind(trigger), eventType:trigger.eventTrigger?.eventType, resource:trigger.eventTrigger?.resource,
  channel:trigger.eventTrigger?.channel, schedule:trigger.schedule?.schedule ?? trigger.scheduleTrigger?.schedule,
  extensionInstanceId:trigger.extensionInstanceId,
  url:trigger.httpsTrigger ? `${functions}/${project}/${trigger.region}/${trigger.name}` : undefined,
});

// The one definition --region/NAME select, or an error naming the candidates.
export function selectTrigger(triggers, name, region) {
  const byName = triggers.filter(trigger => trigger.name === name);
  const matches = (byName.length ? byName : triggers.filter(trigger => trigger.entryPoint === name)).filter(trigger => !region || trigger.region === region);
  const list = items => items.map(trigger => `${trigger.name} (${trigger.region}, ${triggerKind(trigger)})`).join(', ');
  if (!matches.length) throw new Error(`No function ${name}${region ? ` in ${region}` : ''} is loaded; the running suite has: ${list(triggers) || 'no functions'}`);
  if (matches.length > 1) throw new Error(`${name} is deployed in several regions; pass --region: ${list(matches)}`);
  return matches[0];
}

// FunctionsEmulatorShell.createLegacyEvent (first-generation functions).
export function legacyEvent(eventType, data, opts = {}) {
  let resource = opts.resource;
  if (isObject(resource) && resource.name) resource = resource.name;
  return {eventId:randomUUID(), timestamp:new Date().toISOString(), eventType, resource, params:opts.params,
    auth:{admin:opts.auth?.admin || false, variable:opts.auth?.variable}, data};
}
// FunctionsEmulatorShell.createCloudEvent (second-generation functions).
export function cloudEvent(eventType, data, source = '', extensions = {}) {
  return {specversion:'1.0', datacontenttype:'application/json', id:randomUUID(), type:eventType, time:new Date().toISOString(), source, data, ...extensions};
}
// LocalFunction.constructAuth for the user form; the shell's own
// {admin, variable} form passes through.
export function eventAuth(auth) {
  if (auth === undefined) return undefined;
  if (!isObject(auth)) throw new Error('--auth must be a JSON object: {"uid": "...", "token": {...}} or {"admin": true}');
  if (auth.admin !== undefined || auth.variable !== undefined) return {admin:auth.admin || false, variable:auth.variable};
  return {admin:false, variable:{uid:auth.uid ?? '', token:auth.token || {}}};
}
// LocalFunction.substituteParams: wildcards take the param or, like the shell,
// the wildcard name with a random digit.
export function substituteParams(pattern, params) {
  return String(pattern).replace(/{[^/{}]*}/g, wildcard => {
    const name = wildcard.slice(1, -1).replace(/=\*\*$/, '');
    return params?.[name] || `${name}${1 + Math.floor(Math.random() * 9)}`;
  });
}
// The wildcard values a concrete path gives a pattern (`users/{uid}` and
// `users/alice` yield {uid: "alice"}); `{rest=**}` takes the remainder.
export function matchParams(pattern, path) {
  const params = {};
  if (!pattern) return params;
  const wildcards = String(pattern).split('/');
  const segments = String(path).split('/');
  for (const [index, part] of wildcards.entries()) {
    const match = /^{([^/{}=]+)(=\*\*)?}$/.exec(part);
    if (!match) continue;
    params[match[1]] = match[2] ? segments.slice(index).join('/') : segments[index];
  }
  return params;
}
// LocalFunction.makeFirestoreValue, plus the document name the SDK prefers
// when it builds the snapshot's reference.
export function firestoreValue(input, name) {
  if (input === undefined || input === null || (isObject(input) && !Object.keys(input).length)) return {};
  if (!isObject(input)) throw new Error('Firestore data must be key-value pairs.');
  const currentTime = new Date().toISOString();
  return {name, fields:encodeFields(input), createTime:currentTime, updateTime:currentTime};
}

function firestoreEnvelope(trigger, project, eventData, opts) {
  const event = trigger.eventTrigger;
  const v2 = trigger.platform === 'gcfv2';
  const database = event.eventFilters?.database || '(default)';
  const pattern = v2 ? (event.eventFilterPathPatterns?.document ?? event.eventFilters?.document) : event.resource;
  const relativePattern = pattern ? relativePath(pattern) : undefined;
  let document;
  let params = opts.params;
  if (opts.resource) {
    document = relativePath(opts.resource);
    params ??= matchParams(relativePattern, document);
  } else if (relativePattern) {
    document = substituteParams(relativePattern, params);
    params ??= matchParams(relativePattern, document);
  } else throw new Error(`${trigger.name} declares no document pattern; pass --resource <collection/document>`);
  if (document.split('/').length % 2) throw new Error(`${document} is not a document path (collection/document[/subcollection/document...])`);
  const name = `projects/${project}/databases/${database}/documents/${document}`;
  const operation = String(event.eventType).replace(/\.withAuthContext$/, '').split('.').pop();
  const explicit = isObject(eventData) && (Object.hasOwn(eventData, 'before') || Object.hasOwn(eventData, 'after'));
  const before = explicit ? eventData.before : undefined;
  const after = explicit ? eventData.after : eventData;
  let data;
  switch (operation) {
    case 'create': case 'created': data = {value:firestoreValue(after, name), oldValue:{}}; break;
    case 'delete': case 'deleted': data = {value:{}, oldValue:firestoreValue(explicit ? before : eventData, name)}; break;
    default: data = {value:firestoreValue(after, name), oldValue:firestoreValue(before, name)};
  }
  if (!v2) return {body:legacyEvent(event.eventType, data, {resource:name, params, auth:opts.auth}), document:name};
  const extensions = {document, project, database, namespace:'(default)'};
  if (String(event.eventType).endsWith('.withAuthContext')) Object.assign(extensions, AUTH_CONTEXT);
  return {body:cloudEvent(event.eventType, data, 'projects/_/databases/(default)', extensions), document:name};
}

function storageEnvelope(trigger, project, eventData, opts, storage) {
  const event = trigger.eventTrigger;
  const v2 = trigger.platform === 'gcfv2';
  const declared = v2 ? event.eventFilters?.bucket : event.resource;
  const bucket = (isObject(eventData) && eventData.bucket) || (declared ? String(declared).replace(/^projects\/_\/buckets\//, '') : `${project}.appspot.com`);
  if (!isObject(eventData) || typeof eventData.name !== 'string' || !eventData.name) {
    throw new Error('Storage events need the object in --event-data, e.g. {"name":"uploads/photo.png","contentType":"image/png","size":"1024"}');
  }
  const now = new Date().toISOString();
  const generation = String(eventData.generation ?? Date.now());
  const object = encodeURIComponent(eventData.name);
  const data = {kind:'storage#object', id:`${bucket}/${eventData.name}/${generation}`, bucket, name:eventData.name, generation, metageneration:'1',
    contentType:'application/octet-stream', size:'0', storageClass:'STANDARD', timeCreated:now, updated:now, timeStorageClassUpdated:now,
    ...(storage ? {selfLink:`${storage}/storage/v1/b/${bucket}/o/${object}`, mediaLink:`${storage}/download/storage/v1/b/${bucket}/o/${object}?generation=${generation}&alt=media`} : {}),
    ...eventData};
  for (const key of ['size', 'metageneration']) if (data[key] !== undefined) data[key] = String(data[key]);
  if (!v2) return {body:legacyEvent(event.eventType, data, {resource:opts.resource ?? `projects/_/buckets/${bucket}/objects/${data.name}`, params:opts.params, auth:opts.auth})};
  return {body:cloudEvent(event.eventType, data, `projects/_/buckets/${bucket}`)};
}

// A Pub/Sub message from {data, attributes, orderingKey}: string data is sent
// as given, any other JSON value as its JSON text; both base64-encoded.
export function pubsubMessage(eventData) {
  if (eventData !== undefined && !isObject(eventData)) throw new Error('Pub/Sub --event-data must be {"data": ..., "attributes": {...}}');
  const message = {};
  const {data, attributes, orderingKey} = eventData ?? {};
  if (data !== undefined) message.data = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64');
  if (attributes !== undefined) {
    if (!isObject(attributes) || Object.values(attributes).some(value => typeof value !== 'string')) throw new Error('Pub/Sub attributes must be a map of strings');
    message.attributes = attributes;
  }
  if (orderingKey !== undefined) message.orderingKey = String(orderingKey);
  if (message.data === undefined && !Object.keys(message.attributes ?? {}).length) throw new Error('A Pub/Sub message needs data or at least one attribute');
  return message;
}
export const topicOf = trigger => String(trigger.eventTrigger?.resource || trigger.eventTrigger?.eventFilters?.topic || '').split('/').pop();

function pubsubEnvelope(trigger, project, eventData, opts) {
  const event = trigger.eventTrigger;
  const message = pubsubMessage(eventData);
  const topic = topicOf(trigger);
  if (trigger.platform !== 'gcfv2') return {body:legacyEvent(event.eventType, message, {resource:opts.resource ?? `projects/${project}/topics/${topic}`, params:opts.params, auth:opts.auth}), message, topic};
  return {body:cloudEvent(event.eventType, {message:{...message, messageId:randomUUID()}}, event.eventFilters?.topic ?? topic), message, topic};
}

function authEnvelope(trigger, project, eventData, opts) {
  if (trigger.platform === 'gcfv2') throw new Error(`${trigger.name} is a second-generation Auth function; only first-generation user.create/user.delete events can be injected`);
  if (eventData !== undefined && !isObject(eventData)) throw new Error('Auth --event-data must be a UserRecord object, e.g. {"uid":"alice","email":"alice@example.com"}');
  const now = new Date().toISOString();
  const data = {uid:randomUUID(), ...eventData, metadata:{creationTime:now, lastSignInTime:now, ...(eventData?.metadata ?? {})}};
  return {body:legacyEvent(trigger.eventTrigger.eventType, data, {resource:opts.resource ?? `projects/${project}`, params:opts.params, auth:opts.auth})};
}

function scheduleEnvelope(trigger, project, opts) {
  const eventType = trigger.eventTrigger?.eventType || 'pubsub';
  if (trigger.platform !== 'gcfv2') {
    return {body:legacyEvent(eventType, {}, {resource:opts.resource ?? `projects/${project}/topics/firebase-schedule-${trigger.name}`, params:opts.params, auth:opts.auth})};
  }
  // The worker serves a second-generation schedule as an HTTP function; the
  // SDK reads Cloud Scheduler's headers for jobName/scheduleTime.
  const headers = {'x-cloudscheduler-jobname':`firebase-schedule-${trigger.name}-${trigger.region}`, 'x-cloudscheduler-scheduletime':new Date().toISOString()};
  return {body:cloudEvent(eventType, {}), headers};
}

// The envelope and the transport for one definition.
export function buildEnvelope(trigger, project, eventData, opts, services = {}) {
  const kind = triggerKind(trigger);
  const event = trigger.eventTrigger;
  switch (kind) {
    case 'https': case 'callable': throw new Error(`${trigger.name} is an HTTPS${kind === 'callable' ? ' callable' : ''} function; call it with --data (or a plain fireside functions:invoke ${trigger.name}), not --event-data`);
    case 'blocking': throw new Error(`${trigger.name} is an Auth blocking function; the Auth emulator calls it during sign-in/sign-up flows`);
    case 'database': throw new Error(`${trigger.name} listens to Realtime Database, which Fireside does not emulate`);
    case 'unknown': throw new Error(`${trigger.name} has no trigger Fireside can drive`);
    case 'taskQueue': return {kind, transport:'tasks', task:{httpRequest:{url:'', oidcToken:{serviceAccountEmail:EMULATED_SERVICE_ACCOUNT}, body:Buffer.from(JSON.stringify({data:eventData ?? {}})).toString('base64'), headers:{'Content-Type':'application/json'}}}};
    case 'firestore': return {kind, transport:'functions', ...firestoreEnvelope(trigger, project, eventData, opts)};
    case 'storage': return {kind, transport:'functions', ...storageEnvelope(trigger, project, eventData, opts, services.storage)};
    case 'pubsub': return {kind, transport:'functions', ...pubsubEnvelope(trigger, project, eventData, opts)};
    case 'auth': return {kind, transport:'functions', ...authEnvelope(trigger, project, eventData, opts)};
    case 'schedule': return {kind, transport:'functions', ...scheduleEnvelope(trigger, project, opts)};
    case 'eventarc': return {kind, transport:'functions', body:cloudEvent(opts.eventType || event.eventType, eventData ?? {})};
    default: return {kind, transport:'functions', body:trigger.platform === 'gcfv2' ? cloudEvent(opts.eventType || event.eventType, eventData ?? {}) : legacyEvent(event.eventType, eventData ?? {}, opts)};
  }
}

// The current trigger key of a definition ({region}-{name}-{generation},
// plus -{channel} for Eventarc custom events): the trigger route answers an
// unknown key with the list of valid ones, which carries the generation.
export async function resolveTriggerKey(functions, project, trigger) {
  const route = key => `${functions}/functions/projects/${encodeURIComponent(project)}/triggers/${key}`;
  let probe;
  try { probe = await fetch(route(`fireside-probe-${randomUUID()}`), {method:'POST', headers:{'content-type':'application/json'}, body:'{}', signal:AbortSignal.timeout(10000)}); }
  catch (error) { throw new Error(`no Functions emulator answered at ${functions} (${describe(error)}); start it with fireside emulators:start`); }
  const text = await probe.text();
  const listed = /valid functions are:\s*(.*)$/s.exec(text);
  if (probe.status !== 404 || !listed) throw new Error(`Unexpected answer from the Functions trigger route (HTTP ${probe.status}): ${text.slice(0, 200)}`);
  const keys = listed[1].split(',').map(key => key.trim()).filter(Boolean);
  const id = `${trigger.region}-${trigger.name}`;
  const channel = trigger.eventTrigger?.channel;
  if (!trigger.eventTrigger && keys.includes(id)) return {key:id, keys};
  let best;
  for (const key of keys) {
    if (!key.startsWith(`${id}-`)) continue;
    const rest = key.slice(id.length + 1);
    const match = channel ? (rest.endsWith(`-${channel}`) ? /^(\d+)$/.exec(rest.slice(0, -channel.length - 1)) : null) : /^(\d+)$/.exec(rest);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!best || generation > best.generation) best = {key, generation};
  }
  if (!best) throw new Error(`${id} is not registered on the running suite's trigger route (valid keys: ${keys.join(', ') || 'none'}); it may be reloading, retry in a moment`);
  return {key:best.key, keys};
}

// Runs one invocation and returns what happened; nothing is printed.
export async function runInvoke(name, options, cwd = process.cwd()) {
  if (!name) throw new Error('functions:invoke requires a function name');
  const project = resolveProject(options, cwd);
  const services = await locateServices(project, options);
  const functions = services.origin('functions');
  const eventData = jsonOption(options['event-data'], '--event-data');
  if (options['event-data'] === undefined) {
    const region = options.region || 'us-central1';
    const url = `${functions}/${encodeURIComponent(project.project)}/${encodeURIComponent(region)}/${encodeURIComponent(name)}`;
    const method = (options.method || 'POST').toUpperCase();
    const headers = {};
    let body;
    if (options.data !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({data:jsonOption(options.data, '--data')});
    }
    let response;
    try { response = await fetch(url, {method, headers, body}); }
    catch (error) { throw new Error(`no Functions emulator answered at ${url} (${describe(error)}); start it with fireside emulators:start`); }
    return {function:name, region, transport:'https', method, url, ...await readResponse(response)};
  }
  const opts = {params:jsonOption(options.params, '--params'), auth:eventAuth(jsonOption(options.auth, '--auth')), resource:options.resource, eventType:options['event-type']};
  if (opts.params !== undefined && !isObject(opts.params)) throw new Error('--params must be a JSON object of wildcard values');
  const triggers = await listFunctions(functions);
  const trigger = selectTrigger(triggers, name, options.region);
  const storage = services.running('storage') ? services.origin('storage') : undefined;
  const envelope = buildEnvelope(trigger, project.project, eventData, opts, {storage});
  const base = {function:trigger.name, region:trigger.region, platform:trigger.platform, kind:envelope.kind, eventType:trigger.eventTrigger?.eventType};
  if (envelope.transport === 'tasks') {
    const tasks = services.origin('tasks');
    const url = `${tasks}/projects/${encodeURIComponent(project.project)}/locations/${encodeURIComponent(trigger.region)}/queues/${encodeURIComponent(trigger.name)}/tasks`;
    const response = await post(url, {task:envelope.task}, {authorization:'Bearer owner'});
    return {...base, transport:'tasks', url, envelope:{task:envelope.task}, ...response};
  }
  if (envelope.kind === 'pubsub' && services.running('pubsub')) {
    const pubsub = services.origin('pubsub');
    const url = `${pubsub}/v1/projects/${encodeURIComponent(project.project)}/topics/${encodeURIComponent(envelope.topic)}:publish`;
    const response = await post(url, {messages:[envelope.message]});
    // A topic the broker does not know (the function was not registered with
    // it) falls back to the direct trigger route.
    if (response.status !== 404) return {...base, transport:'pubsub', topic:envelope.topic, url, envelope:{messages:[envelope.message]}, ...response};
  }
  const {key, keys} = await resolveTriggerKey(functions, project.project, trigger);
  const url = `${functions}/functions/projects/${encodeURIComponent(project.project)}/triggers/${key}`;
  const response = await post(url, envelope.body, envelope.headers);
  return {...base, transport:'functions', key, keys, url, envelope:envelope.body, ...response};
}

async function post(url, body, headers = {}) {
  let response;
  try { response = await fetch(url, {method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body), signal:AbortSignal.timeout(60000)}); }
  catch (error) { throw new Error(`${url} did not answer (${describe(error)}); is the suite running?`); }
  return readResponse(response);
}

// The command: prints the delivery, exits 0 on a 2xx answer.
export async function invokeFunction(name, options, cwd = process.cwd(), log = console) {
  const result = await runInvoke(name, options, cwd);
  if (options.json) { log.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
  if (result.transport !== 'https') {
    const via = {functions:`trigger key ${result.key}`, pubsub:`the Pub/Sub emulator (topic ${result.topic})`, tasks:'the Cloud Tasks emulator'}[result.transport];
    log.error(`Fireside: ${[result.kind, 'event', result.eventType].filter(Boolean).join(' ')} for ${result.function} (${result.region}, ${result.platform}) via ${via}`);
  }
  log.log(`${result.status} ${result.statusText} ${result.url}`);
  if (result.body !== '' && result.body !== undefined) log.log(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  return result.ok ? 0 : 1;
}
