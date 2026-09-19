// firenook mcp: a Model Context Protocol server over stdio (newline-delimited
// JSON-RPC 2.0, as the MCP stdio transport specifies) that exposes the running
// local suite to an agent: Firestore documents, Auth accounts and codes,
// Storage objects, Functions inventory and invocation, Pub/Sub publishing,
// Cloud Tasks statistics and exports. Every tool talks to the local emulators
// only, found through the hub locator; nothing is sent anywhere else. No
// dependency beyond Node: stdout carries JSON-RPC lines and nothing else,
// diagnostics go to stderr.
import { createInterface } from 'node:readline';
import { manifest, release } from './binary.mjs';
import { exportEmulators, findHub, locatorPath, readLocator, resolveProject, runningServices, serviceOrigin } from './hub.mjs';
import { listFunctions, pubsubMessage, runInvoke, summarizeTrigger } from './invoke.mjs';
import { decodeDocument, encodeFields, encodeValue } from './firestore-values.mjs';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const TOOL_GROUPS = ['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks'];
const OWNER = {authorization:'Bearer owner'};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class ToolError extends Error {}
const describe = error => error?.cause?.code || error?.cause?.message || error?.message || String(error);

// One HTTP exchange with an emulator; non-2xx answers become tool errors that
// carry the emulator's own message.
async function call(url, {method = 'GET', headers = {}, body, allow = []} = {}) {
  let response;
  try {
    response = await fetch(url, {method, headers:{...(body !== undefined ? {'content-type':'application/json'} : {}), ...headers},
      body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(60000)});
  } catch (error) { throw new ToolError(`${method} ${url} failed: ${describe(error)}; is the suite running?`); }
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep the text */ }
  if (!response.ok && !allow.includes(response.status)) {
    const message = parsed?.error?.message || parsed?.message || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    throw new ToolError(`${method} ${url} answered HTTP ${response.status}: ${message || 'no details'}`);
  }
  return {status:response.status, body:parsed};
}

// A Firestore field path in update masks: simple names bare, others quoted.
const fieldPath = name => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/[\\`]/g, char => `\\${char}`)}\``);
const OPERATORS = {'==':'EQUAL', '!=':'NOT_EQUAL', '<':'LESS_THAN', '<=':'LESS_THAN_OR_EQUAL', '>':'GREATER_THAN', '>=':'GREATER_THAN_OR_EQUAL',
  'array-contains':'ARRAY_CONTAINS', 'array-contains-any':'ARRAY_CONTAINS_ANY', in:'IN', 'not-in':'NOT_IN'};
const trimPath = path => String(path).replace(/(^\/+|\/+$)/g, '');
const encodePath = path => trimPath(path).split('/').map(encodeURIComponent).join('/');

// Where the suite answers, resolved for every call so a restarted suite on
// other ports is found without restarting the server.
async function suite(context, name) {
  const project = resolveProject(context.options, context.cwd);
  const hub = await findHub(project, context.options);
  const listing = await runningServices(hub.origin);
  return {project, hub, listing, origin:name ? serviceOrigin(project, name, listing, context.options) : undefined,
    originOf:service => serviceOrigin(project, service, listing, context.options)};
}

const string = description => ({type:'string', description});
const schema = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
const DATABASE = string('Firestore database id; default (default)');
const BUCKET = string('Storage bucket; default <project>.appspot.com');

export const TOOLS = [
  {name:'firenook_status', group:'status', description:'The running Firenook suite: hub locator, hub status, the emulators listing (host and port per service) and the CLI version.',
    inputSchema:schema({}),
    async run(_args, context) {
      const project = resolveProject(context.options, context.cwd);
      const locator = readLocator(project.project);
      let hub;
      try { hub = await findHub(project, context.options); }
      catch (error) { return {project:project.project, running:false, locator:locatorPath(project.project), error:error.message, version:manifest.version, engineRevision:release.engineRevision}; }
      return {project:project.project, running:true, locator:{path:locatorPath(project.project), contents:locator ?? null}, hub:{origin:hub.origin, status:hub.status},
        emulators:await runningServices(hub.origin) ?? null, version:manifest.version, engineRevision:release.engineRevision};
    }},
  {name:'firestore_get', group:'firestore', description:'Read one Firestore document by path (collection/document[/subcollection/document]); returns its fields as plain JSON or exists:false.',
    inputSchema:schema({path:string('Document path, e.g. users/alice'), database:DATABASE}, ['path']),
    async run({path, database = '(default)'}, context) {
      const {project, origin} = await suite(context, 'firestore');
      const {status, body} = await call(`${origin}/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents/${encodePath(path)}`, {headers:OWNER, allow:[404]});
      if (status === 404) return {path:trimPath(path), exists:false};
      return {exists:true, ...decodeDocument(body)};
    }},
  {name:'firestore_query', group:'firestore', description:'Run a structured query over one collection (Firestore runQuery): optional where filters, ordering and limit; returns matching documents as plain JSON.',
    inputSchema:schema({collection:string('Collection path, e.g. users or users/alice/posts'), database:DATABASE,
      where:{type:'array', description:'Filters combined with AND', items:schema({field:string('Field path'), op:{type:'string', enum:Object.keys(OPERATORS), description:'Comparison operator'}, value:{description:'Plain JSON value ({"$timestamp":...}, {"$ref":...} sentinels allowed)'}}, ['field', 'op', 'value'])},
      orderBy:{type:'array', description:'Sort keys', items:schema({field:string('Field path'), direction:{type:'string', enum:['asc', 'desc'], description:'Default asc'}}, ['field'])},
      limit:{type:'integer', description:'Maximum documents; default 50', minimum:1}}, ['collection']),
    async run({collection, database = '(default)', where = [], orderBy = [], limit = 50}, context) {
      const {project, origin} = await suite(context, 'firestore');
      const segments = trimPath(collection).split('/');
      if (segments.length % 2 === 0) throw new ToolError(`${collection} is a document path; firestore_query takes a collection path`);
      const root = `projects/${project.project}/databases/${database}/documents`;
      const parent = segments.length > 1 ? `${root}/${segments.slice(0, -1).join('/')}` : root;
      const encode = value => encodeValue(value, {project:project.project, database});
      const filters = where.map(({field, op, value}) => {
        if (!OPERATORS[op]) throw new ToolError(`Unsupported operator ${op}; use one of ${Object.keys(OPERATORS).join(', ')}`);
        return {fieldFilter:{field:{fieldPath:field}, op:OPERATORS[op], value:encode(value)}};
      });
      const structuredQuery = {from:[{collectionId:segments[segments.length - 1]}], limit};
      if (filters.length === 1) structuredQuery.where = filters[0];
      else if (filters.length > 1) structuredQuery.where = {compositeFilter:{op:'AND', filters}};
      if (orderBy.length) structuredQuery.orderBy = orderBy.map(({field, direction = 'asc'}) => ({field:{fieldPath:field}, direction:direction === 'desc' ? 'DESCENDING' : 'ASCENDING'}));
      const {body} = await call(`${origin}/v1/${parent.split('/').map(encodeURIComponent).join('/')}:runQuery`, {method:'POST', headers:OWNER, body:{structuredQuery}});
      const documents = (Array.isArray(body) ? body : []).filter(entry => entry.document).map(entry => decodeDocument(entry.document));
      return {collection:trimPath(collection), count:documents.length, documents};
    }},
  {name:'firestore_set', group:'firestore', description:'Write a Firestore document from plain JSON: replaces it, or with merge:true updates only the given top-level fields.',
    inputSchema:schema({path:string('Document path'), data:{type:'object', description:'Fields as plain JSON'}, merge:{type:'boolean', description:'Merge into the existing document'}, database:DATABASE}, ['path', 'data']),
    async run({path, data, merge = false, database = '(default)'}, context) {
      const {project, origin} = await suite(context, 'firestore');
      if (trimPath(path).split('/').length % 2) throw new ToolError(`${path} is a collection path; firestore_set needs a document path`);
      const mask = merge ? Object.keys(data).map(key => `updateMask.fieldPaths=${encodeURIComponent(fieldPath(key))}`) : [];
      const url = `${origin}/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents/${encodePath(path)}${mask.length ? `?${mask.join('&')}` : ''}`;
      const {body} = await call(url, {method:'PATCH', headers:OWNER, body:{fields:encodeFields(data, {project:project.project, database})}});
      return {written:true, merge, ...decodeDocument(body)};
    }},
  {name:'firestore_delete', group:'firestore', description:'Delete a document (recursive:true also its subcollections) or a collection (its documents; recursive:true everything beneath) through the emulator delete route.',
    inputSchema:schema({path:string('Document or collection path'), recursive:{type:'boolean', description:'Also delete nested collections'}, database:DATABASE}, ['path']),
    async run({path, recursive = false, database = '(default)'}, context) {
      const {project, origin} = await suite(context, 'firestore');
      const mode = recursive ? 'recursive' : 'shallow';
      const {body} = await call(`${origin}/emulator/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents/${encodePath(path)}?mode=${mode}`, {method:'DELETE', headers:OWNER});
      return {path:trimPath(path), mode, deleted:typeof body?.deleted === 'number' ? body.deleted : null};
    }},
  {name:'firestore_list_collections', group:'firestore', description:'List collection ids at the database root or under a document (listCollectionIds).',
    inputSchema:schema({path:string('Document path; omit for the root collections'), database:DATABASE}),
    async run({path, database = '(default)'}, context) {
      const {project, origin} = await suite(context, 'firestore');
      const root = `${origin}/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents`;
      const {body} = await call(`${path ? `${root}/${encodePath(path)}` : root}:listCollectionIds`, {method:'POST', headers:OWNER, body:{}});
      return {path:path ? trimPath(path) : null, collectionIds:body.collectionIds ?? []};
    }},
  {name:'auth_list_users', group:'auth', description:'List Auth emulator accounts (accounts:batchGet) with uid, email, phone, display name, claims and provider data.',
    inputSchema:schema({maxResults:{type:'integer', description:'Page size; default 100', minimum:1}, pageToken:string('Continue a previous listing')}),
    async run({maxResults = 100, pageToken}, context) {
      const {project, origin} = await suite(context, 'auth');
      const query = `maxResults=${maxResults}${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const {body} = await call(`${origin}/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project.project)}/accounts:batchGet?${query}`, {headers:OWNER});
      const users = (body.users ?? []).map(account);
      return {count:users.length, users, nextPageToken:body.nextPageToken ?? null};
    }},
  {name:'auth_get_user', group:'auth', description:'Look up one Auth account by uid, email or phone number (accounts:lookup).',
    inputSchema:schema({uid:string('Account id (localId)'), email:string('Email address'), phoneNumber:string('Phone number in E.164 form')}),
    async run({uid, email, phoneNumber}, context) {
      const {project, origin} = await suite(context, 'auth');
      const request = uid ? {localId:[uid]} : email ? {email:[email]} : phoneNumber ? {phoneNumber:[phoneNumber]} : undefined;
      if (!request) throw new ToolError('auth_get_user needs uid, email or phoneNumber');
      const {body} = await call(`${origin}/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project.project)}/accounts:lookup`, {method:'POST', headers:OWNER, body:request});
      const user = body.users?.[0];
      return user ? {found:true, user:account(user)} : {found:false};
    }},
  {name:'auth_create_user', group:'auth', description:'Create an Auth emulator account with a synthetic email/password, phone number or display name (never real credentials).',
    inputSchema:schema({uid:string('Account id to assign'), email:string('Email'), password:string('Password'), phoneNumber:string('Phone number'), displayName:string('Display name'),
      photoUrl:string('Photo URL'), emailVerified:{type:'boolean', description:'Mark the email verified'}, disabled:{type:'boolean', description:'Create the account disabled'}}),
    async run({uid, email, password, phoneNumber, displayName, photoUrl, emailVerified, disabled}, context) {
      const {project, origin} = await suite(context, 'auth');
      const request = {localId:uid, email, password, phoneNumber, displayName, photoUrl, emailVerified, disabled};
      for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
      if (!Object.keys(request).length) throw new ToolError('auth_create_user needs at least one of uid, email, phoneNumber, displayName');
      const {body} = await call(`${origin}/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project.project)}/accounts`, {method:'POST', headers:OWNER, body:request});
      return {created:true, uid:body.localId, email:body.email ?? null, phoneNumber:body.phoneNumber ?? null, displayName:body.displayName ?? null};
    }},
  {name:'auth_delete_user', group:'auth', description:'Delete one Auth emulator account by uid (accounts:delete).',
    inputSchema:schema({uid:string('Account id')}, ['uid']),
    async run({uid}, context) {
      const {project, origin} = await suite(context, 'auth');
      await call(`${origin}/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project.project)}/accounts:delete`, {method:'POST', headers:OWNER, body:{localId:uid}});
      return {uid, deleted:true};
    }},
  {name:'auth_oob_codes', group:'auth', description:'The pending out-of-band codes (email verification, password reset, sign-in links) the Auth emulator holds instead of sending email.',
    inputSchema:schema({}),
    async run(_args, context) {
      const {project, origin} = await suite(context, 'auth');
      const {body} = await call(`${origin}/emulator/v1/projects/${encodeURIComponent(project.project)}/oobCodes`, {headers:OWNER});
      return {oobCodes:body.oobCodes ?? []};
    }},
  {name:'auth_verification_codes', group:'auth', description:'The pending phone verification codes the Auth emulator holds instead of sending SMS.',
    inputSchema:schema({}),
    async run(_args, context) {
      const {project, origin} = await suite(context, 'auth');
      const {body} = await call(`${origin}/emulator/v1/projects/${encodeURIComponent(project.project)}/verificationCodes`, {headers:OWNER});
      return {verificationCodes:body.verificationCodes ?? []};
    }},
  {name:'storage_list', group:'storage', description:'List Storage objects and folder prefixes under a prefix (one level, like listAll).',
    inputSchema:schema({bucket:BUCKET, prefix:string('Folder prefix, e.g. uploads/ (a trailing slash is added)'), maxResults:{type:'integer', description:'Page size; default 100', minimum:1}, pageToken:string('Continue a previous listing')}),
    async run({bucket, prefix = '', maxResults = 100, pageToken}, context) {
      const {project, origin} = await suite(context, 'storage');
      const name = bucket || `${project.project}.appspot.com`;
      const folder = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
      const query = `prefix=${encodeURIComponent(folder)}&delimiter=${encodeURIComponent('/')}&maxResults=${maxResults}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const {body} = await call(`${origin}/v0/b/${encodeURIComponent(name)}/o?${query}`, {headers:OWNER});
      return {bucket:name, prefix:folder, prefixes:body.prefixes ?? [], items:body.items ?? [], nextPageToken:body.nextPageToken ?? null};
    }},
  {name:'storage_get_metadata', group:'storage', description:'The metadata of one Storage object (content type, size, timestamps, custom metadata, download tokens) or exists:false.',
    inputSchema:schema({bucket:BUCKET, path:string('Object path, e.g. uploads/photo.png')}, ['path']),
    async run({bucket, path}, context) {
      const {project, origin} = await suite(context, 'storage');
      const name = bucket || `${project.project}.appspot.com`;
      const {status, body} = await call(`${origin}/v0/b/${encodeURIComponent(name)}/o/${encodeURIComponent(trimPath(path))}`, {headers:OWNER, allow:[404]});
      if (status === 404) return {bucket:name, path:trimPath(path), exists:false};
      return {exists:true, ...body};
    }},
  {name:'functions_list', group:'functions', description:'The functions loaded by the running suite: name, region, generation, trigger kind, event type or schedule, and the HTTPS URL of request/callable functions.',
    inputSchema:schema({}),
    async run(_args, context) {
      const {project, origin} = await suite(context, 'functions');
      const triggers = await listFunctions(origin);
      return {count:triggers.length, functions:triggers.map(trigger => summarizeTrigger(trigger, project.project, origin))};
    }},
  {name:'functions_invoke', group:'functions', description:'Invoke a loaded function: an HTTPS/callable request with data, or with eventData a background event (Firestore before/after, Storage object, Pub/Sub message, Auth user, schedule, Eventarc custom event, task queue payload) shaped as the official functions shell sends it.',
    inputSchema:schema({name:string('Function name'), region:string('Region when the name is deployed in several'), data:{description:'Callable payload (sent as {"data": ...})'},
      eventData:{description:'Background event payload; its shape depends on the trigger'}, resource:string('Firestore document path or the legacy resource name'),
      params:{type:'object', description:'Wildcard values for the trigger pattern'}, auth:{type:'object', description:'{"uid","token"} or {"admin":true} for first-generation events'},
      eventType:string('Override the CloudEvent type for Eventarc custom events'), method:string('HTTP method for plain HTTPS functions; default POST')}, ['name']),
    async run({name, region, data, eventData, resource, params, auth, eventType, method}, context) {
      const options = {...context.options, region, data:data === undefined ? undefined : JSON.stringify(data), 'event-data':eventData === undefined ? undefined : JSON.stringify(eventData),
        resource, params:params === undefined ? undefined : JSON.stringify(params), auth:auth === undefined ? undefined : JSON.stringify(auth), 'event-type':eventType, method};
      for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];
      return runInvoke(name, options, context.cwd);
    }},
  {name:'pubsub_publish', group:'pubsub', description:'Publish a message to a Pub/Sub emulator topic: string data as given, other JSON as its text (base64-encoded on the wire), plus attributes.',
    inputSchema:schema({topic:string('Topic name (or projects/<p>/topics/<name>)'), data:{description:'Message data'}, attributes:{type:'object', description:'String attributes'}, orderingKey:string('Ordering key')}, ['topic']),
    async run({topic, data, attributes, orderingKey}, context) {
      const {project, origin} = await suite(context, 'pubsub');
      const name = String(topic).split('/').pop();
      const message = pubsubMessage({data, attributes, orderingKey});
      const {body} = await call(`${origin}/v1/projects/${encodeURIComponent(project.project)}/topics/${encodeURIComponent(name)}:publish`, {method:'POST', body:{messages:[message]}});
      return {topic:name, messageIds:body.messageIds ?? [], message};
    }},
  {name:'tasks_stats', group:'tasks', description:'Queue statistics of the Cloud Tasks emulator (queueStats).',
    inputSchema:schema({}),
    async run(_args, context) {
      const {origin} = await suite(context, 'tasks');
      return (await call(`${origin}/queueStats`)).body;
    }},
  {name:'emulators_export', group:'status', description:'Export the running Firestore, Auth and Storage data to a directory outside the project (firenook emulators:export).',
    inputSchema:schema({path:string('Destination directory'), force:{type:'boolean', description:'Overwrite a non-empty foreign directory'}}, ['path']),
    async run({path, force = false}, context) {
      const lines = [];
      const log = {log:line => lines.push(line), error:line => lines.push(line)};
      await exportEmulators(path, {...context.options, force, json:true}, context.cwd, log);
      return {...JSON.parse(lines[lines.length - 1]), log:lines.slice(0, -1)};
    }},
];

// The Admin SDK's UserRecord view of an Auth emulator account.
function account(user) {
  let customClaims = {};
  try { customClaims = user.customAttributes ? JSON.parse(user.customAttributes) : {}; } catch { customClaims = {raw:user.customAttributes}; }
  const time = value => (value ? new Date(Number(value)).toISOString() : null);
  return {uid:user.localId, email:user.email ?? null, emailVerified:Boolean(user.emailVerified), phoneNumber:user.phoneNumber ?? null, displayName:user.displayName ?? null,
    photoUrl:user.photoUrl ?? null, disabled:Boolean(user.disabled), customClaims, tenantId:user.tenantId ?? null,
    providers:(user.providerUserInfo ?? []).map(info => ({providerId:info.providerId, rawId:info.rawId, email:info.email ?? null, displayName:info.displayName ?? null})),
    mfa:user.mfaInfo ?? [], createdAt:time(user.createdAt), lastLoginAt:time(user.lastLoginAt)};
}

// Minimal JSON Schema checks (types, required, enum, minimum) so a wrong call
// is an -32602 error instead of a confusing emulator answer.
export function validateArguments(schemaObject, args) {
  if (args === undefined) args = {};
  if (!isObject(args)) return 'arguments must be an object';
  for (const name of schemaObject.required ?? []) if (args[name] === undefined) return `missing required argument ${name}`;
  for (const [name, value] of Object.entries(args)) {
    const property = schemaObject.properties?.[name];
    if (!property) return `unknown argument ${name}`;
    const problem = checkValue(property, value, name);
    if (problem) return problem;
  }
  return undefined;
}
function checkValue(property, value, name) {
  if (property.type) {
    const type = property.type;
    const ok = type === 'string' ? typeof value === 'string' : type === 'boolean' ? typeof value === 'boolean'
      : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number'
        : type === 'array' ? Array.isArray(value) : type === 'object' ? isObject(value) : true;
    if (!ok) return `${name} must be ${type === 'integer' ? 'an integer' : `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`}`;
  }
  if (property.enum && !property.enum.includes(value)) return `${name} must be one of ${property.enum.join(', ')}`;
  if (property.minimum !== undefined && value < property.minimum) return `${name} must be at least ${property.minimum}`;
  if (property.type === 'array' && property.items) {
    for (const [index, item] of value.entries()) {
      const problem = property.items.type === 'object' ? validateArguments(property.items, item) : checkValue(property.items, item, `${name}[${index}]`);
      if (problem) return `${name}[${index}]: ${problem}`;
    }
  }
  return undefined;
}

export function selectTools(only) {
  if (only === undefined) return TOOLS;
  const groups = String(only).split(',').map(item => item.trim()).filter(Boolean);
  for (const group of groups) if (!TOOL_GROUPS.includes(group)) throw new Error(`${group} is not a tool group; --only takes ${TOOL_GROUPS.join(', ')}`);
  if (!groups.length) throw new Error('--only requires a comma-separated list of tool groups');
  return TOOLS.filter(tool => tool.group === 'status' || groups.includes(tool.group));
}

// The protocol handler, independent of the transport. `handle` takes one
// parsed message and returns the response to send, or undefined for a
// notification.
export function createMcpServer(options, cwd = process.cwd(), log = console) {
  const {only, ...rest} = options;
  const tools = selectTools(only);
  const context = {options:rest, cwd};
  const error = (id, code, message, data) => ({jsonrpc:'2.0', id:id ?? null, error:{code, message, ...(data === undefined ? {} : {data})}});
  const result = (id, value) => ({jsonrpc:'2.0', id, result:value});
  async function handle(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(isObject(message) ? message.id : null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 request or notification');
    }
    const {id, method, params} = message;
    const notification = id === undefined;
    if (method.startsWith('notifications/')) return undefined;
    if (notification) return undefined;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return result(id, {protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'firenook', version:manifest.version},
          instructions:'Tools act on the local Firenook emulator suite only (found through the hub locator of the configured project). Firestore values use plain JSON with {"$timestamp"}, {"$ref"}, {"$geo"} and {"$bytes"} sentinels. Nothing is sent to any cloud service.'});
      }
      case 'ping': return result(id, {});
      case 'tools/list': return result(id, {tools:tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}))});
      case 'tools/call': {
        if (!isObject(params) || typeof params.name !== 'string') return error(id, -32602, 'tools/call needs params.name');
        const tool = tools.find(candidate => candidate.name === params.name);
        if (!tool) return error(id, -32602, `Unknown tool: ${params.name}`);
        if (params.arguments !== undefined && !isObject(params.arguments)) return error(id, -32602, 'params.arguments must be an object');
        const problem = validateArguments(tool.inputSchema, params.arguments);
        if (problem) return error(id, -32602, `Invalid arguments for ${tool.name}: ${problem}`);
        try {
          const value = await tool.run(params.arguments ?? {}, context);
          return result(id, {content:[{type:'text', text:JSON.stringify(value, null, 2)}]});
        } catch (failure) {
          log.error(`firenook mcp: ${tool.name}: ${failure.message}`);
          return result(id, {content:[{type:'text', text:JSON.stringify({error:failure.message}, null, 2)}], isError:true});
        }
      }
      default: return error(id, -32601, `Method not found: ${method}`);
    }
  }
  return {tools, handle};
}

// The stdio transport: one JSON-RPC message per line in, one per line out.
export async function serveMcp(options, cwd = process.cwd(), streams = {input:process.stdin, output:process.stdout, log:console}) {
  const {input, output, log} = streams;
  const server = createMcpServer(options, cwd, log);
  let closed = false;
  // A client that went away closes our stdout; stop quietly instead of crashing.
  output.on?.('error', () => { closed = true; input.destroy?.(); });
  const send = message => { if (!closed) output.write(`${JSON.stringify(message)}\n`); };
  const pending = new Set();
  log.error(`firenook mcp ${manifest.version}: ${server.tools.length} tools over stdio for project ${describeProject(options, cwd)}; local emulators only`);
  const lines = createInterface({input, crlfDelay:Infinity});
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { send({jsonrpc:'2.0', id:null, error:{code:-32700, message:'Parse error'}}); continue; }
    const work = (async () => {
      const responses = Array.isArray(message) ? (await Promise.all(message.map(item => server.handle(item)))).filter(Boolean) : await server.handle(message);
      if (Array.isArray(responses) ? responses.length : responses) send(responses);
    })().catch(failure => send({jsonrpc:'2.0', id:isObject(message) ? message.id ?? null : null, error:{code:-32603, message:`Internal error: ${failure.message}`}}));
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
  return 0;
}
function describeProject(options, cwd) {
  try { return resolveProject(options, cwd).project; } catch (error) { return `(unresolved: ${error.message})`; }
}
