// The firenook mcp tools over the engine's Console API (`/console/api/v1` on
// the Emulator UI port): what an agent needs while it builds or fixes a
// feature beyond plain data access. Auth bulk actions and resets run as
// console jobs; the tools wait for the job and report its outcome.
import { suiteFetch } from './client.mjs';
import { encodeFields } from './firestore-values.mjs';
import { ORDER_BY, ToolError, WHERE, boolean, consoleCall, integer, queryString, schema, sortOrder, string, strings, suite, trimPath, whereFilter } from './mcp-suite.mjs';

const DATABASE_ID = string('Firestore database id; default (default)');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits for a console job (`202` + Job) to leave the running state.
async function finished(context, job, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let current = job;
  // A small job finishes in milliseconds: poll soon, then every 250 ms (the
  // engine publishes job state at most that often).
  for (let poll = 0; current?.state === 'running'; poll++) {
    if (Date.now() > deadline) throw new ToolError(`${current.title || current.kind} is still running after ${timeout / 1000} s (job ${current.id}); its outcome is in the console's jobs list`);
    await sleep([20, 50, 100][poll] ?? 250);
    current = (await consoleCall(context, `/jobs/${encodeURIComponent(current.id)}`)).body;
  }
  if (current?.state === 'failed' || current?.state === 'cancelled') throw new ToolError(`${current.title || current.kind} ${current.state}: ${current.message || 'no details'}`);
  return current;
}

// ── Logs and function calls ───────────────────────────────────────────────
// The console's filter grammar takes `key:value` terms (a repeated key is
// OR) and quoted phrases; the tools build it from plain arguments.
const quote = value => (/^[^\s"()]+$/.test(value) ? value : `"${String(value).replace(/"/g, ' ')}"`);
const terms = (key, values) => (values === undefined ? [] : (Array.isArray(values) ? values : [values]).map(value => `${key}:${quote(value)}`));
// Function names as the console's ids (<region>-<name>): a bare name means
// every region it is deployed in.
async function functionIds(context, names) {
  if (names === undefined) return undefined;
  const wanted = Array.isArray(names) ? names : [names];
  const {body} = await consoleCall(context, '/functions');
  const loaded = body.functions ?? [];
  return wanted.flatMap(name => {
    const ids = loaded.filter(item => item.id === name || item.name === name).map(item => item.id);
    return ids.length ? ids : [name];
  });
}
const LEVELS = ['debug', 'info', 'warn', 'error'];
const LOG_SERVICES = ['hub', 'firestore', 'auth', 'storage', 'functions', 'pubsub', 'eventarc', 'tasks'];
const LOG_FILTERS = {
  service:{type:'array', description:'Only these services (any of)', items:{type:'string', enum:LOG_SERVICES}},
  level:{type:'array', description:'Only these levels (any of), e.g. ["warn","error"]', items:{type:'string', enum:LEVELS}},
  function:string('Only this function\'s lines: its name or <region>-<name> id'),
  execution:string('Only one function call\'s lines: the call id from functions_list_calls'),
  text:string('Case-insensitive text the message or payload contains'),
  q:string('Extra filter terms in the console\'s grammar, e.g. kind:rules.denied payload.orderId:o1 -level:debug'),
  from:string('Lines at or after: RFC 3339, YYYY-MM-DD, today, reload (since the last Functions reload) or relative like -15m'),
  to:string('Lines at or before, in the same forms'),
};
async function logFilter(context, {service, level, function:name, execution, text, q, from, to}) {
  const parts = [...terms('service', service), ...terms('level', level), ...terms('function', await functionIds(context, name)), ...terms('execution', execution),
    ...(text ? [quote(text)] : []), ...(q ? [q] : [])];
  return {q:parts.join(' ') || undefined, from, to};
}
const logLine = entry => ({cursor:entry.cursor, time:entry.time, level:entry.level, service:entry.service, ...(entry.function ? {function:entry.function} : entry.source ? {source:entry.source} : {}),
  ...(entry.execution ? {call:entry.execution} : {}), ...(entry.kind ? {kind:entry.kind} : {}), message:entry.message, ...(entry.payload ? {payload:entry.payload} : {}), ...(entry.truncated ? {truncated:true} : {})});
// Durations to a hundredth of a millisecond, as the console shows them.
const ms = value => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
const callSummary = item => ({id:item.id, function:item.functionId, kind:item.kind, origin:item.origin, summary:item.summary, startedAt:item.startedAt, durationMs:ms(item.durationMs),
  outcome:item.outcome ?? 'running', ...(item.status === null ? {} : {status:item.status}), ...(item.error ? {error:item.error} : {}), ...(item.cold ? {cold:true} : {}),
  ...(item.attempt > 1 ? {attempt:item.attempt} : {}), ...(item.replayOf ? {replayOf:item.replayOf} : {}), logCount:item.logCount});
// A recorded body as JSON when it is JSON, text or base64 otherwise, cut at `limit` characters.
function recordedBody(body, contentType, limit) {
  if (!body || body.encoding === 'empty') return {body:null};
  const cut = body.text.length > limit;
  const text = cut ? body.text.slice(0, limit) : body.text;
  const json = body.encoding === 'text' && !cut && !body.truncated && /json/i.test(contentType || '') ? safeJson(text) : undefined;
  return {body:json ?? text, ...(body.encoding === 'base64' ? {encoding:'base64'} : {}), size:body.size, ...(cut || body.truncated ? {truncated:true} : {})};
}
const LOGS_TOOLS = [
  {name:'logs_search', group:'logs', description:'Search the suite\'s log (every emulator and every function\'s console output) by service, level, function, call, text and time; returns the newest matching lines, oldest first.',
    inputSchema:schema({...LOG_FILTERS, limit:integer('At most this many lines; default 50', 1, 2000), before:string('The older cursor of a previous search, for the lines before it')}),
    async run(args, context) {
      const {limit = 50, before} = args;
      const {body} = await consoleCall(context, '/logs/entries', {query:{...await logFilter(context, args), limit, before}});
      return {count:body.items?.length ?? 0, lines:(body.items ?? []).map(logLine), older:body.older ?? null};
    }},
  {name:'logs_facets', group:'logs', description:'Count the log lines matching a filter by level, service, function, codebase, extension instance and kind, to see where errors and warnings come from before reading them.',
    inputSchema:schema(LOG_FILTERS),
    async run(args, context) {
      const {body} = await consoleCall(context, '/logs/facets', {query:await logFilter(context, args)});
      const counts = list => Object.fromEntries((list ?? []).map(item => [item.value, item.count]));
      return {kept:body.kept, matched:body.matched, levels:counts(body.levels), services:counts(body.services), functions:counts(body.functions), instances:counts(body.instances),
        codebases:counts(body.codebases), kinds:counts(body.kinds), lastReload:body.lastReload};
    }},
];
const FUNCTION_CALLS_TOOLS = [
  {name:'functions_list_calls', group:'functions', description:'Recent function calls, newest first: trigger kind and cause, outcome (succeeded, failed, timedOut, crashed...), HTTP status, duration and the first line of the error.',
    inputSchema:schema({function:string('Only this function: its name or <region>-<name> id'), kind:{type:'string', enum:['http', 'callable', 'firestore', 'storage', 'auth', 'pubsub', 'schedule', 'eventarc', 'tasks', 'blocking', 'alerts', 'other'], description:'Only this trigger kind'},
      outcome:{type:'string', enum:['succeeded', 'failed', 'skipped', 'running'], description:'Only calls that ended this way'}, q:string('Extra filter terms, e.g. took:>200ms status:>=500 is:cold'),
      limit:integer('At most this many; default 20', 1, 500), cursor:string('nextCursor of a previous listing')}),
    async run({function:name, kind, outcome, q, limit = 20, cursor}, context) {
      const filter = [...terms('function', await functionIds(context, name)), ...terms('kind', kind), ...terms('outcome', outcome), ...(q ? [q] : [])].join(' ');
      const {body} = await consoleCall(context, '/functions/invocations', {query:{q:filter || undefined, limit, cursor}});
      return {total:body.page?.total?.count ?? null, calls:(body.page?.items ?? []).map(callSummary), nextCursor:body.page?.nextCursor ?? null};
    }},
  {name:'functions_get_call', group:'functions', description:'One function call in full: its cause, request (method, path, headers, body), response (status, body), event payload, the error with its stack trace, the call\'s console output and timings.',
    inputSchema:schema({id:string('Call id from functions_list_calls'), maxBodyChars:integer('Cut each body at this many characters; default 16384', 1, 262144)}, ['id']),
    async run({id, maxBodyChars = 16384}, context) {
      const {body} = await consoleCall(context, `/functions/invocations/${encodeURIComponent(id)}`);
      const detail = body.detail;
      // The thrown error's stack: the worker's function.error line, else the
      // first error-level line the call logged (an unhandled error).
      const failure = (detail.logs ?? []).find(line => line.kind === 'function.error') ?? (detail.logs ?? []).find(line => line.level === 'error');
      const summary = callSummary(detail.summary);
      return {...summary, ...(failure ? {error:summary.error ?? failure.message.split('\n')[0], stack:failure.message} : {}), cause:detail.summary.cause,
        request:{method:detail.request.method, path:detail.request.path, contentType:detail.request.contentType,
          headers:Object.fromEntries((detail.request.headers ?? []).map(header => [header.name, header.sensitive ? '(hidden)' : header.value])), ...recordedBody(detail.request.body, detail.request.contentType, maxBodyChars)},
        response:detail.response ? {status:detail.response.status, contentType:detail.response.contentType, ...recordedBody(detail.response.body, detail.response.contentType, maxBodyChars)} : null,
        ...(detail.event === null || detail.event === undefined ? {} : {event:detail.event}),
        logs:(detail.logs ?? []).map(line => ({at:line.at, level:line.level, message:line.message, ...(line.kind ? {kind:line.kind} : {}), ...(line.fields ? {fields:line.fields} : {})})),
        ...(detail.logsDropped ? {logsDropped:detail.logsDropped} : {}), timings:Object.fromEntries(Object.entries(detail.timings ?? {}).map(([key, value]) => [key, ms(value)])), replayable:detail.replayable, ...(detail.notReplayable ? {notReplayable:detail.notReplayable} : {})};
    }},
  {name:'functions_replay_call', group:'functions', description:'Run a recorded function call again with the same request or event (after a fix, say) and report the new call: outcome, status, response body and its id for functions_get_call.',
    inputSchema:schema({id:string('Call id from functions_list_calls'), maxBodyChars:integer('Cut the response body at this many characters; default 16384', 1, 262144)}, ['id']),
    async run({id, maxBodyChars = 16384}, context) {
      const {body} = await consoleCall(context, `/functions/invocations/${encodeURIComponent(id)}/replay`, {method:'POST', body:{}, timeout:600000});
      const frames = (typeof body === 'string' ? body.split('\n') : [JSON.stringify(body)]).filter(Boolean).map(safeJson);
      const chunks = frames.filter(frame => frame.frame === 'chunk');
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.text, chunk.encoding === 'base64' ? 'base64' : 'utf8')));
      const finished = frames.find(frame => frame.frame === 'finished')?.invocation ?? frames.find(frame => frame.frame === 'started')?.invocation;
      const failed = frames.find(frame => frame.frame === 'failed');
      const head = frames.find(frame => frame.frame === 'head');
      const contentType = (head?.headers ?? []).find?.(header => (header.name ?? header[0])?.toLowerCase() === 'content-type');
      const text = bytes.toString('utf8');
      const response = text.length > maxBodyChars ? {body:text.slice(0, maxBodyChars), truncated:true} : {body:safeJson(text)};
      return {replayOf:id, ...(finished ? callSummary(finished) : {}), ...(head ? {status:head.status} : {}), ...(contentType ? {contentType:contentType.value ?? contentType[1]} : {}), ...response,
        ...(frames.some(frame => frame.frame === 'truncated') ? {truncated:true} : {}), ...(failed ? {failed:failed.message} : {})};
    }},
];

// ── Security Rules ────────────────────────────────────────────────────────
const SERVICE = {type:'string', enum:['firestore', 'storage'], description:'Which rules: firestore (default) or storage'};
const rulesDocument = body => ({source:body.source, enforced:body.enforced, file:body.path ?? null, hash:body.hash, ...(body.fileProblems?.length ? {problems:body.fileProblems} : {}),
  ...(body.database ? {database:body.database} : {}), ...(body.mode ? {mode:body.mode, bucket:body.bucket, governs:body.governs} : {})});
// The rule text a trace position names: the condition, and its whole line.
const quoteRule = (source, step) => {
  const line = source.split('\n')[step.line - 1]?.trim();
  return {line:step.line, ...(source && step.to > step.from ? {condition:source.slice(step.from, step.to)} : {}), ...(line ? {text:line} : {})};
};
// What decided a dry-run result: the allow condition that granted it, or for
// a denial every allow condition that ran (and failed), or none at all.
function verdict(result, source) {
  const allows = result.allows ?? [];
  const granted = allows.find(step => step.outcome === 'allow');
  const decidedBy = granted ? [granted] : allows;
  const outcome = {allowed:result.outcome === 'allow', outcome:result.outcome, ...(result.error ? {error:result.error} : {})};
  if (!decidedBy.length) return {...outcome, decidedBy:[], reason:result.error || 'No allow statement matches this request, so it is denied by default.'};
  return {...outcome, decidedBy:decidedBy.map(step => ({...quoteRule(source, step), outcome:step.outcome})),
    steps:(result.explanation ?? []).slice(0, 60).map(step => ({line:step.line, expression:source.slice(step.from, step.to), value:step.value, ...(step.error ? {error:true} : {})})),
    ...(result.explanation?.length > 60 || result.truncated ? {stepsTruncated:true} : {}), ...(result.changedKeys ? {changedKeys:result.changedKeys} : {}),
    ...(result.queryReason ? {queryReason:result.queryReason} : {})};
}
const RULES_TOOLS = [
  {name:'rules_get', group:'rules', description:'The Security Rules in force: the Firestore rules of a database and the Storage rules of a bucket (source, whether they are enforced, the file and its problems).',
    inputSchema:schema({service:{...SERVICE, description:'Only firestore or storage; default both'}, database:DATABASE_ID, bucket:string('Storage bucket; default the default bucket')}),
    async run({service, database, bucket}, context) {
      const result = {};
      for (const name of service ? [service] : ['firestore', 'storage']) {
        try { result[name] = rulesDocument((await consoleCall(context, `/${name}/rules`, {query:name === 'firestore' ? {database} : {bucket}})).body); }
        catch (error) { if (service) throw error; result[name] = {error:error.message}; }
      }
      return result;
    }},
  {name:'rules_evaluate', group:'rules', description:'Ask the rules in force (or a draft) whether a request would be allowed: get, list, create, update or delete on a Firestore path or Storage object as a given user or unauthenticated; returns the verdict, the rule line that decided it and each evaluated expression\'s value. Nothing is written.',
    inputSchema:schema({service:SERVICE, method:{type:'string', enum:['get', 'list', 'create', 'update', 'delete'], description:'The operation'},
      path:string('Firestore document path (a collection path for list), or the Storage object name (a folder ending in / for list)'),
      uid:string('Act as this signed-in user; omit for an unauthenticated request'), claims:{type:'object', description:'request.auth.token: custom claims and token fields (email, firebase.sign_in_provider...)'},
      idToken:string('Act as the user of this emulator ID token (from auth_mint_token) instead of uid/claims'),
      data:{type:'object', description:'Firestore create/update: the written fields as plain JSON (update: the fields set over the existing document)'},
      existing:{type:['object', 'null'], description:'Firestore: the document before the request as plain JSON, or null for none; default the stored document'},
      where:WHERE, orderBy:ORDER_BY, limit:integer('Firestore list: the query limit'), collectionGroup:boolean('Firestore list: a collection-group query on the path\'s last collection id'),
      object:{...schema({size:{type:'integer', description:'Bytes', minimum:0}, contentType:string('Content type'), customMetadata:{type:'object', description:'String metadata'}}), description:'Storage create/update: the proposed object'},
      time:string('request.time as RFC 3339; default now'), source:string('Evaluate this draft rules source instead of the rules in force'), database:DATABASE_ID, bucket:string('Storage bucket; default the default bucket')}, ['method', 'path']),
    async run({service = 'firestore', method, path, uid, claims, idToken, data, existing, where, orderBy, limit, collectionGroup, object, time, source, database, bucket}, context) {
      if (idToken && (uid || claims)) throw new ToolError('Pass either idToken or uid/claims, not both');
      if (claims && !uid) throw new ToolError('claims need a uid (an unauthenticated request has no token)');
      const auth = idToken ? {authorization:`Bearer ${idToken}`} : uid ? {auth:{uid, token:claims ?? {}}} : {};
      const {project} = await suite(context);
      let request;
      if (service === 'firestore') {
        if (object) throw new ToolError('object describes a Storage upload; for Firestore pass data');
        const values = {project:project.project, database:database ?? '(default)'};
        const query = method === 'list' && (where || orderBy || limit) ? {...(where ? {where:whereFilter(where, values)} : {}), ...(orderBy ? {orderBy:sortOrder(orderBy)} : {}), ...(limit ? {limit} : {})} : undefined;
        request = {method, path:trimPath(path), ...auth, ...(data ? {data:encodeFields(data, values)} : {}), ...(existing === undefined ? {} : {resource:existing === null ? null : encodeFields(existing, values)}),
          ...(query ? {query} : {}), ...(collectionGroup ? {group:true} : {}), ...(time ? {time} : {})};
      } else {
        if (data || existing !== undefined || where || orderBy || limit || collectionGroup) throw new ToolError('data, existing and the query arguments are Firestore\'s; for Storage pass object');
        request = {method, bucket:bucket ?? '', path:String(path).replace(/^\/+/, ''), ...auth, ...(object ? {proposed:object} : {}), ...(time ? {time} : {})};
      }
      const {body} = await consoleCall(context, `/${service}/rules/evaluate`, {method:'POST', body:{...(service === 'firestore' ? {database} : {bucket}), ...(source ? {source} : {}), requests:[request]}});
      const rules = source ?? (await consoleCall(context, `/${service}/rules`, {query:service === 'firestore' ? {database} : {bucket}})).body.source ?? '';
      return {service, method, path:request.path, as:idToken ? 'the idToken\'s user' : uid ? {uid, claims:claims ?? {}} : 'unauthenticated', ...(source ? {draft:true} : {}), ...verdict(body.results[0], rules)};
    }},
  {name:'rules_list_denials', group:'rules', description:'Recent requests the Security Rules denied (app clients only; admin and owner requests skip the rules), newest last; with explain, the rule lines that denied each one.',
    inputSchema:schema({service:{...SERVICE, description:'Only firestore or storage; default both'}, path:string('Only paths starting with this'), uid:string('Only this user\'s requests'),
      from:string('Denials at or after: RFC 3339, today or relative like -15m'), limit:integer('At most this many; default 20', 1, 200), explain:boolean('Fetch the deciding rule lines of each denial (at most 20)')}),
    async run({service, path, uid, from, limit = 20, explain = false}, context) {
      const kinds = {firestore:'rules.denied', storage:'storage.denied'};
      const q = [...terms('kind', service ? [kinds[service]] : Object.values(kinds)), ...terms('payload.uid', uid)].join(' ');
      const {body} = await consoleCall(context, '/logs/entries', {query:{q, from, limit:path ? 2000 : limit}});
      const prefix = path === undefined ? undefined : trimPath(path);
      const lines = (body.items ?? []).filter(line => prefix === undefined || String(line.payload?.path ?? '').startsWith(prefix)).slice(-limit);
      const denials = [];
      for (const [index, line] of lines.entries()) {
        const storage = line.kind === kinds.storage;
        const id = storage ? line.payload?.decision : line.payload?.requestId;
        const denial = {time:line.time, service:storage ? 'storage' : 'firestore', method:line.payload?.method, path:line.payload?.path, uid:line.payload?.uid ?? null,
          ...(storage ? {bucket:line.payload?.bucket} : {database:line.payload?.database}), ...(id ? {decision:id} : {}), message:line.message};
        if (explain && id && index >= lines.length - 20) {
          try {
            const detail = (await consoleCall(context, storage ? `/storage/rules/decisions/${encodeURIComponent(id)}` : `/firestore/rules/decisions/${encodeURIComponent(id)}`)).body;
            Object.assign(denial, {...verdict(detail.result, detail.rules ?? ''), steps:undefined});
          } catch (error) { denial.explainError = error.message; }
        }
        denials.push(denial);
      }
      return {count:denials.length, denials};
    }},
];

// ── Auth ──────────────────────────────────────────────────────────────────
const TENANT = string('Tenant id; omit for a project-level user');
const USERS = {uid:string('Account id'), uids:strings('Several account ids (instead of uid)'), tenant:TENANT};
const userKeys = ({uid, uids, tenant = ''}) => {
  const ids = [...(uid === undefined ? [] : [uid]), ...(uids ?? [])];
  if (!ids.length) throw new ToolError('Name the user with uid (or several with uids)');
  return [...new Set(ids)].map(id => `${tenant}|${id}`);
};
// One Auth bulk action (disable, enable, revoke, claims) for the named users,
// waited for; a user it could not change is a tool error.
async function authBulk(context, action, args, extra = {}) {
  const keys = userKeys(args);
  const {body} = await consoleCall(context, `/auth/users:${action}`, {method:'POST', body:{target:{by:'keys', keys}, ...extra}});
  const job = await finished(context, body);
  if (job.errorCount) throw new ToolError(`${job.title}: ${job.errors.map(item => `${item.key.split('|').pop()}: ${item.message}`).join('; ')}`);
  return {users:keys.map(key => key.split('|').pop()), ...(args.tenant ? {tenant:args.tenant} : {}), changed:job.done - job.skipped - job.errorCount, unchanged:job.skipped};
}
const AUTH_TOOLS = [
  {name:'auth_mint_token', group:'auth', description:'Mint a Firebase ID token (valid one hour) and refresh token for an existing Auth emulator user, so an agent can call a function or the REST API as that user; claims replace the custom claims for this token only.',
    inputSchema:schema({uid:string('Account id'), tenant:TENANT, claims:{type:'object', description:'Custom claims for this token only (nothing is stored); omit for the user\'s own'},
      provider:string('Sign-in provider the token names, e.g. password or phone; default the user\'s first')}, ['uid']),
    async run({uid, tenant, claims, provider}, context) {
      const {body} = await consoleCall(context, '/auth/tokens', {method:'POST', body:{uid, tenant, claims, provider}});
      return {uid, ...(tenant ? {tenant} : {}), idToken:body.idToken, refreshToken:body.refreshToken, expiresAt:body.expiresAt, provider:body.provider, claims:body.payload,
        use:'Send it as Authorization: Bearer <idToken> to a function or a REST route.'};
    }},
  {name:'auth_set_claims', group:'auth', description:'Set an Auth emulator user\'s custom claims: replace them (as the Admin SDK\'s setCustomUserClaims does) or with mode merge change only the given keys (a null value removes that key).',
    inputSchema:schema({...USERS, claims:{type:'object', description:'Custom claims as JSON'}, mode:{type:'string', enum:['replace', 'merge'], description:'Default replace'}}, ['claims']),
    run:(args, context) => authBulk(context, 'setClaims', args, {claims:args.claims, mode:args.mode ?? 'replace'})},
  {name:'auth_remove_claims', group:'auth', description:'Remove the named custom claim keys from an Auth emulator user, keeping its other claims.',
    inputSchema:schema({...USERS, keys:strings('Claim names to remove')}, ['keys']),
    run:(args, context) => authBulk(context, 'removeClaims', args, {keys:args.keys})},
  {name:'auth_disable_user', group:'auth', description:'Disable an Auth emulator account: its sign-ins and token refreshes fail until it is enabled again.',
    inputSchema:schema(USERS), run:(args, context) => authBulk(context, 'disable', args)},
  {name:'auth_enable_user', group:'auth', description:'Enable a disabled Auth emulator account again.',
    inputSchema:schema(USERS), run:(args, context) => authBulk(context, 'enable', args)},
  {name:'auth_revoke_tokens', group:'auth', description:'Revoke an Auth emulator user\'s refresh tokens (validSince moves to now), so its existing sessions must sign in again.',
    inputSchema:schema(USERS), run:(args, context) => authBulk(context, 'revoke', args)},
  {name:'auth_list_tenants', group:'auth', description:'List the Auth emulator\'s tenants (multi-tenancy) with their user counts and sign-in settings.',
    inputSchema:schema({q:string('Match tenant id or display name (substring)'), limit:integer('At most this many; default 500', 1, 500)}),
    async run({q, limit}, context) {
      const {body} = await consoleCall(context, '/auth/tenants', {query:{q, limit}});
      return {total:body.total, projectUsers:body.projectUsers, tenants:body.items ?? []};
    }},
];

// ── Reset ─────────────────────────────────────────────────────────────────
const CLEARABLE = ['firestore', 'auth', 'storage', 'pubsub', 'tasks'];
const RESET_TOOLS = [
  {name:'emulators_clear', group:'reset', description:'DESTRUCTIVE: delete all data of the chosen services (every Firestore document, every Auth user and tenant, every Storage object, every Pub/Sub topic, subscription, schema and message, every Cloud Tasks task and its history). Clearing more than one service needs confirmProject set to the project id.',
    inputSchema:schema({sections:{type:'array', description:'Services to clear', items:{type:'string', enum:CLEARABLE}},
      confirmProject:string('The project id, required when clearing more than one service (the console\'s safeguard)'),
      runTriggers:boolean('Firestore only: run the delete triggers of the cleared documents; default false')}, ['sections']),
    async run({sections, confirmProject, runTriggers}, context) {
      const chosen = [...new Set(sections)];
      if (!chosen.length) throw new ToolError('Name at least one service to clear in sections');
      const {project} = await suite(context);
      if (chosen.length > 1 && confirmProject !== project.project) {
        throw new ToolError(`Clearing ${chosen.length} services (${chosen.join(', ')}) deletes all their data; to confirm, pass confirmProject: "${project.project}" (the project id)${confirmProject === undefined ? '' : `, not "${confirmProject}"`}`);
      }
      const {body} = await consoleCall(context, '/suite/clear', {method:'POST', body:{sections:chosen, ...(chosen.length > 1 ? {confirm:confirmProject} : {}), ...(runTriggers ? {runTriggers} : {})}});
      const job = await finished(context, body, 600000);
      return {project:project.project, cleared:Array.isArray(job.result) ? job.result : [], ...(job.errorCount ? {errors:job.errors} : {})};
    }},
];

// ── Storage files ─────────────────────────────────────────────────────────
// The console's object routes act as the Admin SDK with the owner token
// (rules are skipped); a binary body passes the console's guard with its
// x-firenook-console header.
const ADMIN = {authorization:'Bearer owner'};
const READ_LIMIT = 1024 * 1024;
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|yaml|x-yaml|toml|csv|x-ndjson|ld\+json|[a-z.+-]*\+(json|xml)))|^image\/svg\+xml/i;
// An object's bucket and name; without a bucket, the suite's default bucket
// (the console knows it, as configured or <project>.appspot.com).
async function objectQuery(context, {bucket, path}) {
  if (!bucket) {
    const {project, body} = await consoleCall(context, '/storage/buckets');
    bucket = body.defaultBucket || `${project.project}.appspot.com`;
  }
  return {bucket, name:String(path).replace(/^\/+/, '')};
}
const objectSummary = detail => ({bucket:detail.bucket, path:detail.name, size:detail.size, contentType:detail.contentType, customMetadata:detail.customMetadata ?? {},
  generation:detail.generation, md5Hash:detail.md5Hash, updated:detail.updated, ...(detail.downloadTokens?.length ? {downloadTokens:detail.downloadTokens} : {})});
// The first `limit` bytes of a response body, and whether there was more.
async function readCapped(response, limit) {
  const chunks = [];
  let length = 0;
  let more = false;
  const reader = response.body.getReader();
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length > limit) { more = true; await reader.cancel(); break; }
  }
  const bytes = Buffer.concat(chunks);
  return {bytes:bytes.subarray(0, limit), more};
}
// A copy or move of one object (or a folder, a path ending in /), as a
// console job that is waited for.
async function relocate(context, action, {bucket, path, to, toBucket, overwrite = false}) {
  const source = await objectQuery(context, {bucket, path});
  const {body} = await consoleCall(context, `/storage/objects:${action}`, {method:'POST', headers:ADMIN,
    body:{bucket:source.bucket, target:{by:'keys', keys:[source.name]}, destination:{bucket:toBucket || source.bucket, prefix:''}, renameTo:String(to).replace(/^\/+/, ''), onConflict:overwrite ? 'replace' : 'fail'}});
  const job = await finished(context, body);
  if (job.errorCount) throw new ToolError(`${job.title}: ${job.errors.map(item => item.message).join('; ')}`);
  if (!job.done || job.skipped === job.done) throw new ToolError(`${job.title}: nothing to ${action}; ${source.name} does not exist in gs://${source.bucket}`);
  return {from:{bucket:source.bucket, path:source.name}, to:{bucket:toBucket || source.bucket, path:String(to).replace(/^\/+/, '')}, objects:job.done - job.skipped, ...(job.skipped ? {skipped:job.skipped} : {})};
}
const OBJECT = string('Object path, e.g. products/shoe.png');
const STORAGE_BUCKET = string('Storage bucket; default the suite\'s default bucket');
const STORAGE_TOOLS = [
  {name:'storage_read', group:'storage', description:'Read a Storage object\'s content: text inline (text, JSON, XML, SVG...), anything else as base64; at most maxBytes are returned and truncated says whether there is more.',
    inputSchema:schema({bucket:STORAGE_BUCKET, path:OBJECT, maxBytes:integer(`Most bytes to return; default 65536, at most ${READ_LIMIT}`, 1, READ_LIMIT),
      encoding:{type:'string', enum:['auto', 'text', 'base64'], description:'auto (default) picks text for textual content types'}}, ['path']),
    async run({bucket, path, maxBytes = 65536, encoding = 'auto'}, context) {
      const query = await objectQuery(context, {bucket, path});
      const {base, body:detail} = await consoleCall(context, '/storage/object', {query, headers:ADMIN});
      let response;
      try { response = await suiteFetch(`${base}/storage/object/media${queryString(query)}`, {headers:{range:`bytes=0-${maxBytes - 1}`}, signal:AbortSignal.timeout(60000)}); }
      catch (error) { throw new ToolError(`Reading gs://${query.bucket}/${query.name} failed: ${error.message}`); }
      if (!response.ok) throw new ToolError(`Reading gs://${query.bucket}/${query.name} answered HTTP ${response.status}`);
      const {bytes, more} = await readCapped(response, maxBytes);
      const text = encoding === 'text' || (encoding === 'auto' && TEXTUAL.test(detail.contentType || ''));
      return {...objectSummary(detail), encoding:text ? 'text' : 'base64', returnedBytes:bytes.length, truncated:more || bytes.length < detail.size,
        content:text ? bytes.toString('utf8') : bytes.toString('base64')};
    }},
  {name:'storage_upload', group:'storage', description:'Upload (create or replace) a Storage object from text or base64 bytes with a content type and custom metadata, as the Admin SDK would (rules skipped; finalize triggers run).',
    inputSchema:schema({bucket:STORAGE_BUCKET, path:OBJECT, text:string('Content as text (sent as UTF-8)'), base64:string('Content as base64 bytes (instead of text)'),
      contentType:string('Content type; default text/plain for text, application/octet-stream for base64'), customMetadata:{type:'object', description:'String metadata'},
      cacheControl:string('Cache-Control'), ifNotExists:boolean('Refuse to replace an existing object')}, ['path']),
    async run({bucket, path, text, base64, contentType, customMetadata, cacheControl, ifNotExists = false}, context) {
      if ((text === undefined) === (base64 === undefined)) throw new ToolError('Pass the content as exactly one of text or base64');
      if (base64 !== undefined && !/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64.replace(/\s+/g, ''))) throw new ToolError('base64 is not base64 data');
      if (customMetadata && Object.values(customMetadata).some(value => typeof value !== 'string')) throw new ToolError('customMetadata values must be strings');
      const query = await objectQuery(context, {bucket, path});
      const bytes = text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(base64, 'base64');
      const metadata = {...(customMetadata ? {customMetadata} : {}), ...(cacheControl ? {cacheControl} : {})};
      const headers = {...ADMIN, 'x-firenook-console':'1', 'content-type':contentType || (text !== undefined ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
        ...(Object.keys(metadata).length ? {'x-firenook-metadata':`b64.${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`} : {}), ...(ifNotExists ? {'if-none-match':'*'} : {})};
      const {body} = await consoleCall(context, '/storage/object', {method:'PUT', query, headers, raw:bytes});
      return {uploaded:true, ...objectSummary(body)};
    }},
  {name:'storage_delete', group:'storage', description:'DESTRUCTIVE: delete one Storage object, or with a path ending in / every object under that folder.',
    inputSchema:schema({bucket:STORAGE_BUCKET, path:string('Object path, or a folder ending in /')}, ['path']),
    async run({bucket, path}, context) {
      const query = await objectQuery(context, {bucket, path});
      if (!query.name.endsWith('/')) {
        await consoleCall(context, '/storage/object', {method:'DELETE', headers:ADMIN, body:query});
        return {bucket:query.bucket, path:query.name, deleted:1};
      }
      const {body} = await consoleCall(context, '/storage/objects:delete', {method:'POST', headers:ADMIN, body:{bucket:query.bucket, target:{by:'keys', keys:[query.name]}}});
      const job = await finished(context, body);
      if (job.errorCount) throw new ToolError(`${job.title}: ${job.errors.map(item => item.message).join('; ')}`);
      return {bucket:query.bucket, path:query.name, deleted:job.done - job.skipped};
    }},
  {name:'storage_copy', group:'storage', description:'Copy a Storage object (or a folder, a path ending in /) to a new path, in the same or another bucket; refuses to overwrite unless overwrite is true.',
    inputSchema:schema({bucket:STORAGE_BUCKET, path:string('Source object path, or a folder ending in /'), to:string('Destination path (a folder ends in /)'), toBucket:string('Destination bucket; default the source bucket'),
      overwrite:boolean('Replace an existing destination')}, ['path', 'to']),
    run:(args, context) => relocate(context, 'copy', args)},
  {name:'storage_move', group:'storage', description:'Move (rename) a Storage object or a folder (a path ending in /), in the same or another bucket; refuses to overwrite unless overwrite is true.',
    inputSchema:schema({bucket:STORAGE_BUCKET, path:string('Source object path, or a folder ending in /'), to:string('Destination path (a folder ends in /)'), toBucket:string('Destination bucket; default the source bucket'),
      overwrite:boolean('Replace an existing destination')}, ['path', 'to']),
    run:(args, context) => relocate(context, 'move', args)},
];

// ── Eventarc ──────────────────────────────────────────────────────────────
const eventSummary = event => ({id:event.id, eventId:event.eventId, receivedAt:event.receivedAt, channel:event.channel, type:event.eventType, source:event.source, subject:event.subject,
  origin:event.origin, matched:event.matched, delivered:event.delivered, failed:event.failed, pending:event.pending, ...(event.error ? {error:event.error} : {})});
// An event with its deliveries, once the deliveries in flight have finished
// (they run after the publish answers) or about three seconds have passed.
async function settledEvent(context, id) {
  let view;
  for (let attempt = 0; attempt < 12; attempt++) {
    view = (await consoleCall(context, `/eventarc/events/${encodeURIComponent(id)}`)).body;
    if (!view.detail?.summary?.pending) break;
    await sleep(250);
  }
  const detail = view.detail;
  return {...eventSummary(detail.summary), attributes:detail.attributes, data:detail.data, ...(detail.dataTruncated ? {dataTruncated:true} : {}), ...(detail.replayOf ? {replayOf:detail.replayOf} : {}),
    deliveries:(detail.deliveries ?? []).map(delivery => ({function:delivery.functionId, matched:delivery.matched, outcome:delivery.outcome, durationMs:ms(delivery.durationMs), call:delivery.invocationId,
      ...(delivery.mismatches?.length ? {mismatches:delivery.mismatches} : {})}))};
}
const EVENT_ID = string('The event id from eventarc_list_events (<nonce>-<seq>), not the CloudEvent id');
const EVENTARC_TOOLS = [
  {name:'eventarc_publish', group:'eventarc', description:'Publish a custom CloudEvent to an Eventarc channel (default the project\'s Firebase channel), as getEventarc().channel().publish() does, and report which functions received it and how each call ended.',
    inputSchema:schema({type:string('CloudEvent type, e.g. com.example.order.shipped'), data:{description:'Event data as JSON'}, text:string('Event data as plain text (instead of data)'),
      source:string('CloudEvent source; default firenook-mcp'), subject:string('CloudEvent subject'), channel:string('Full channel name or google; default projects/<project>/locations/us-central1/channels/firebase'),
      attributes:{type:'object', description:'Extension attributes (lowercase names, string values)'}}, ['type']),
    async run({type, data, text, source = 'firenook-mcp', subject, channel, attributes}, context) {
      if (data !== undefined && text !== undefined) throw new ToolError('Pass the event data as data (JSON) or text, not both');
      const {project} = await suite(context);
      const body = {channel:channel || `projects/${project.project}/locations/us-central1/channels/firebase`, type, source, subject, attributes,
        encoding:text === undefined ? 'json' : 'text', data:text ?? (data === undefined ? '' : JSON.stringify(data))};
      const {body:published} = await consoleCall(context, '/eventarc/channel/publish', {method:'POST', body});
      return settledEvent(context, published.event.id);
    }},
  {name:'eventarc_list_events', group:'eventarc', description:'The Eventarc events the suite received, newest first (custom events, replays and the Firebase services\' own), with how many functions matched, received or failed each.',
    inputSchema:schema({channel:string('Full channel name or google; default every channel'), q:string('Filter, e.g. type:com.example.* or delivery:failed'),
      limit:integer('At most this many; default 20', 1, 500), cursor:string('nextCursor of a previous listing')}),
    async run({channel, q, limit = 20, cursor}, context) {
      const {body} = await consoleCall(context, '/eventarc/events', {query:{channel, q, limit, cursor}});
      return {total:body.page?.total?.count ?? null, events:(body.page?.items ?? []).map(eventSummary), nextCursor:body.page?.nextCursor ?? null};
    }},
  {name:'eventarc_get_event', group:'eventarc', description:'One Eventarc event with its attributes, data and every function delivery (outcome, duration, invocation id for functions_get_call).',
    inputSchema:schema({id:EVENT_ID}, ['id']),
    run:({id}, context) => settledEvent(context, id)},
  {name:'eventarc_replay_event', group:'eventarc', description:'Deliver a received Eventarc event again to the functions it matches (a new event, origin replay) and report the new deliveries.',
    inputSchema:schema({id:EVENT_ID, keepId:boolean('Keep the original CloudEvent id; default a new one')}, ['id']),
    async run({id, keepId}, context) {
      const {body} = await consoleCall(context, `/eventarc/events/${encodeURIComponent(id)}/replay`, {method:'POST', body:keepId === undefined ? {} : {keepId}});
      return settledEvent(context, body.event.id);
    }},
];

// ── Extensions ────────────────────────────────────────────────────────────
const instanceSummary = item => ({instanceId:item.instanceId, kind:item.kind, reference:item.reference, version:item.version, name:item.displayName || item.name, state:item.state,
  functionCount:item.functionCount, ...(item.error ? {error:item.error} : {}), ...(item.warnings?.length ? {warnings:item.warnings} : {})});
const EXTENSIONS_TOOLS = [
  {name:'extensions_list', group:'extensions', description:'The Firebase Extensions instances the suite runs: reference and version, state (running, loading, failed) with the load error, and their function count.',
    inputSchema:schema({}),
    async run(_args, context) {
      const {body} = await consoleCall(context, '/extensions/instances');
      return {phase:body.phase, offline:body.offline, instances:(body.instances ?? []).map(instanceSummary), ...(body.dropped?.length ? {dropped:body.dropped} : {})};
    }},
  {name:'extensions_reload', group:'extensions', description:'Reload one Extensions instance (re-read its .env parameters and source, restart its functions) and report its state and functions afterwards.',
    inputSchema:schema({instance:string('Instance id, e.g. resize-images')}, ['instance']),
    async run({instance}, context) {
      const {body} = await consoleCall(context, `/extensions/instances/${encodeURIComponent(instance)}/reload`, {method:'POST', body:{}});
      return {...instanceSummary(body.summary), functions:(body.functions ?? []).map(item => ({functionId:item.functionId, kind:item.kind, status:item.status}))};
    }},
];

// ── Pub/Sub ───────────────────────────────────────────────────────────────
const resource = (project, kind, name) => (String(name).startsWith('projects/') ? String(name) : `projects/${project.project}/${kind}/${name}`);
const subscriptionSummary = item => ({name:item.name, topic:item.topic, delivery:item.delivery, managed:item.managed, ...(item.filter ? {filter:item.filter} : {}),
  ...(item.deadLetterTopic ? {deadLetterTopic:item.deadLetterTopic} : {}), backlog:item.counters?.backlog ?? 0, outstanding:item.counters?.outstanding ?? 0, oldestUnackedAt:item.counters?.oldestUnackedAt ?? null});
const PUBSUB_TOOLS = [
  {name:'pubsub_list_topics', group:'pubsub', description:'The Pub/Sub emulator\'s topics with their published counts, subscriptions and the functions they trigger (schedule topics included).',
    inputSchema:schema({}),
    async run(_args, context) {
      const {body} = await consoleCall(context, '/pubsub/topics');
      return {project:body.project, topics:(body.items ?? []).map(topic => ({name:topic.name, kind:topic.kind, published:topic.counters?.published ?? 0, lastPublishedAt:topic.counters?.lastPublishedAt ?? null,
        subscriptions:(topic.subscriptions ?? []).map(item => item.name), functions:(topic.functions ?? []).map(item => item.functionId)})),
      ...(body.otherProjects?.length ? {otherProjects:body.otherProjects} : {})};
    }},
  {name:'pubsub_list_subscriptions', group:'pubsub', description:'Every Pub/Sub subscription (of every topic, and detached ones) with its delivery type, filter, dead-letter topic and backlog.',
    inputSchema:schema({topic:string('Only this topic\'s subscriptions (id or full name)')}),
    async run({topic}, context) {
      const {project, body} = await consoleCall(context, '/pubsub/topics');
      const wanted = topic ? resource(project, 'topics', topic) : undefined;
      const items = [...(body.items ?? []).filter(item => !wanted || item.name === wanted).flatMap(item => item.subscriptions ?? []), ...(wanted ? [] : body.detached ?? [])];
      return {count:items.length, subscriptions:items.map(subscriptionSummary)};
    }},
  {name:'pubsub_peek', group:'pubsub', description:'Peek at a subscription\'s backlog in delivery order without pulling, leasing or acking anything: each message\'s state, attempts, attributes and data.',
    inputSchema:schema({subscription:string('Subscription id or full name'), state:{type:'string', enum:['available', 'outstanding', 'pushing', 'acked'], description:'Only messages in this state; default every state'},
      limit:integer('At most this many; default 20', 1, 500), full:boolean('Return each message\'s whole data instead of a 256-character preview'), cursor:string('nextCursor of a previous peek')}, ['subscription']),
    async run({subscription, state, limit = 20, full = false, cursor}, context) {
      const {project} = await suite(context);
      const {body} = await consoleCall(context, '/pubsub/backlog', {query:{subscription:resource(project, 'subscriptions', subscription), state, limit, cursor}});
      let topic;
      if (full && body.items?.length) topic = (await consoleCall(context, '/pubsub/subscription', {query:{name:resource(project, 'subscriptions', subscription)}})).body.subscription?.summary?.topic;
      const messages = [];
      for (const row of body.items ?? []) {
        const message = {id:row.id, state:row.state, place:row.place, attempts:row.attempts, publishTime:row.publishTime, size:row.size, attributes:row.attributes, orderingKey:row.orderingKey,
          data:row.data?.encoding === 'json' ? safeJson(row.data.text) : row.data?.text, encoding:row.data?.encoding, ...(row.data?.truncated ? {truncated:true} : {})};
        if (full && topic && row.data?.truncated) {
          const whole = (await consoleCall(context, '/pubsub/message', {query:{topic, id:row.id}, allow:[404]})).body;
          if (whole?.dataBase64 !== undefined) Object.assign(message, {data:whole.dataJson ? safeJson(whole.dataText) : whole.dataText ?? whole.dataBase64, encoding:whole.dataText === null ? 'base64' : message.encoding, truncated:false});
        }
        messages.push(message);
      }
      return {subscription:resource(project, 'subscriptions', subscription), total:body.total?.count ?? messages.length, messages, nextCursor:body.nextCursor ?? null};
    }},
];
function safeJson(text) { try { return JSON.parse(text); } catch { return text; } }

// ── Cloud Tasks ───────────────────────────────────────────────────────────
// A queue named by its key, its id or the function it dispatches to.
async function findQueue(context, name) {
  const {body} = await consoleCall(context, '/tasks/queues');
  const queues = body.items ?? [];
  const match = queues.find(queue => queue.key === name || queue.id === name || queue.function?.name === name || queue.function?.functionId === name);
  if (!match) throw new ToolError(`No Cloud Tasks queue ${name}; the suite has ${queues.map(queue => queue.id).join(', ') || 'no queues'}`);
  return match;
}
const taskSummary = task => ({id:task.id, name:task.shortName || task.name, state:task.state, attempt:task.attempt, executionCount:task.executionCount, scheduleTime:task.scheduleTime, dueAt:task.dueAt,
  ...(task.lastError ? {lastError:task.lastError} : {}), url:task.url, body:task.body?.json && !task.body?.truncated ? safeJson(task.body.text) : task.body?.text, ...(task.body?.truncated ? {bodyTruncated:true} : {})});
const TASKS_TOOLS = [
  {name:'tasks_list', group:'tasks', description:'The Cloud Tasks queues (with their pending and running counts) and the tasks waiting in them; with queue, only that queue\'s tasks, optionally in one state.',
    inputSchema:schema({queue:string('Queue id, key (queue:<project>-<location>-<id>) or its function name'), state:{type:'string', enum:['pending', 'held', 'dispatching', 'running', 'backoff'], description:'Only tasks in this state'},
      limit:integer('Tasks per queue; default 20', 1, 500)}),
    async run({queue, state, limit = 20}, context) {
      const queues = queue ? [await findQueue(context, queue)] : (await consoleCall(context, '/tasks/queues')).body.items ?? [];
      const result = [];
      for (const item of queues) {
        const {body} = await consoleCall(context, '/tasks/tasks', {query:{queue:item.key, state, limit}});
        result.push({queue:item.id, key:item.key, location:item.location, function:item.function?.functionId ?? null, paused:item.paused, pending:item.counters?.pending ?? 0, running:item.counters?.running ?? 0,
          tasks:(body.items ?? []).map(taskSummary), total:body.total?.count ?? null});
      }
      return {queues:result};
    }},
  {name:'tasks_run', group:'tasks', description:'Dispatch one waiting Cloud Tasks task now instead of at its schedule time (it is sent on the next tick).',
    inputSchema:schema({queue:string('Queue id, key or its function name'), id:string('Task id from tasks_list')}, ['queue', 'id']),
    async run({queue, id}, context) {
      const match = await findQueue(context, queue);
      const {body} = await consoleCall(context, '/tasks/task/run', {method:'POST', body:{queue:match.key, id:String(id)}});
      return {queue:match.id, id:String(id), started:body.started, message:body.message};
    }},
];

// ── Schedules ─────────────────────────────────────────────────────────────
// How a schedule tick reached its function: queued, or the call it became.
const delivery = item => (item ? {state:item.mark, call:item.invocation, status:item.status, durationMs:ms(item.durationMs), ...(item.error ? {error:item.error} : {}), ...(item.skippedReason ? {skipped:item.skippedReason} : {})} : null);
const SCHEDULES_TOOLS = [
  {name:'schedules_list', group:'schedules', description:'The scheduled functions (onSchedule, pubsub.schedule): expression, time zone, next runs, paused state and the latest runs with their delivery.',
    inputSchema:schema({}),
    async run(_args, context) {
      const {body} = await consoleCall(context, '/pubsub/schedules');
      return {schedules:(body.items ?? []).map(item => ({functionId:item.functionId, function:item.functionName, region:item.region, expression:item.expression, timeZone:item.timeZone, automatic:item.automatic,
        paused:item.paused, nextRunAt:item.nextRunAt, runs:item.runs, lastRuns:(item.lastRuns ?? []).slice(0, 5).map(run => ({at:run.at, trigger:run.trigger, skipped:run.skipped, delivery:delivery(run.delivery)})),
        ...(item.problem ? {problem:item.problem} : {})}))};
    }},
  {name:'schedules_run', group:'schedules', description:'Run a scheduled function now: publish one tick to its schedule topic, as Cloud Scheduler would, and report the run.',
    inputSchema:schema({function:string('Function name or its region-qualified id, e.g. nightlyReport or us-central1-nightlyReport')}, ['function']),
    async run({function:name}, context) {
      const {body} = await consoleCall(context, '/pubsub/schedules');
      const items = body.items ?? [];
      const matches = items.filter(item => item.functionId === name || item.functionName === name);
      if (!matches.length) throw new ToolError(`No scheduled function ${name}; the suite has ${items.map(item => item.functionId).join(', ') || 'none'}`);
      if (matches.length > 1) throw new ToolError(`${name} is scheduled in several regions; pass one of ${matches.map(item => item.functionId).join(', ')}`);
      const run = (await consoleCall(context, '/pubsub/schedule/run', {method:'POST', body:{functionId:matches[0].functionId}})).body;
      return {functionId:matches[0].functionId, at:run.at, trigger:run.trigger, messageId:run.messageId, skipped:run.skipped, delivery:delivery(run.delivery)};
    }},
];

export const CONSOLE_TOOLS = [...FUNCTION_CALLS_TOOLS, ...LOGS_TOOLS, ...RULES_TOOLS, ...AUTH_TOOLS, ...RESET_TOOLS, ...STORAGE_TOOLS, ...EVENTARC_TOOLS, ...EXTENSIONS_TOOLS, ...PUBSUB_TOOLS, ...TASKS_TOOLS, ...SCHEDULES_TOOLS];
