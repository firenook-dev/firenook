// What every firenook mcp tool shares: how a call finds the suite (the
// folder's project, or the one running suite when there is none), one HTTP
// exchange with an emulator or the console API, the call beacon, and the JSON
// Schema helpers the tools declare. Requests go to the local suite only.
import { resolve } from 'node:path';
import { manifest } from './binary.mjs';
import { suiteFetch } from './client.mjs';
import { encodeValue } from './firestore-values.mjs';
import { discoverProject, findHub, needsDiscovery, resolveProject, runningServices, serviceOrigin } from './hub.mjs';

export const CLIENT = `firenook-mcp/${manifest.version}`;
export const OWNER = {authorization:'Bearer owner'};
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class ToolError extends Error {}
const describe = error => error?.cause?.code || error?.cause?.message || error?.message || String(error);

export const trimPath = path => String(path).replace(/(^\/+|\/+$)/g, '');
export const encodePath = path => trimPath(path).split('/').map(encodeURIComponent).join('/');
// A query string from an object: undefined values are left out, arrays repeat
// the key.
export function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// One HTTP exchange with the suite; non-2xx answers become tool errors that
// carry the service's own message (and the console's fix, when it gives one).
// `bytes: true` returns the body as a Buffer with the response headers.
export async function call(url, {method = 'GET', headers = {}, body, raw, allow = [], bytes = false, timeout = 60000} = {}) {
  let response;
  try {
    const json = body !== undefined && raw === undefined;
    response = await suiteFetch(url, {method, headers:{...(json ? {'content-type':'application/json'} : {}), ...headers},
      body:raw ?? (json ? JSON.stringify(body) : undefined), signal:AbortSignal.timeout(timeout)});
  } catch (error) { throw new ToolError(`${method} ${url} failed: ${describe(error)}; is the suite running?`); }
  if (bytes && (response.ok || allow.includes(response.status))) return {status:response.status, headers:response.headers, body:Buffer.from(await response.arrayBuffer())};
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep the text */ }
  if (!response.ok && !allow.includes(response.status)) {
    const message = parsed?.error?.message || parsed?.message || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    const fix = typeof parsed?.error?.fix === 'string' ? ` ${parsed.error.fix}` : '';
    throw new ToolError(`${method} ${url} answered HTTP ${response.status}: ${message || 'no details'}${fix}`);
  }
  return {status:response.status, body:parsed};
}

// How the server finds its project, for the startup line and firenook_status.
export function projectSource(options, cwd) {
  if (options.config) return {by:'--config', config:resolve(cwd, options.config)};
  if (needsDiscovery(options, cwd)) return {by:'locator'};
  if (options.project) return {by:'--project'};
  return {by:'firebase.json', config:resolve(cwd, 'firebase.json')};
}

// The project a call addresses, resolved on every call so a suite started or
// restarted after the server is found: the folder's firebase.json (or
// --project / --config) as the CLI reads it; with none of them, the one
// running suite whose hub locator answers.
export async function target(context) {
  if (!needsDiscovery(context.options, context.cwd)) return resolveProject(context.options, context.cwd);
  try { return await discoverProject(context.cwd, 'firenook mcp'); }
  catch (error) { throw new ToolError(error.message); }
}
// The options for code that resolves the project itself (functions:invoke,
// emulators:export): a discovered project is passed on as --project.
export const optionsFor = (context, project) => (project.discovered ? {...context.options, project:project.project} : context.options);

// Where the suite answers, found once per tool call (a call that makes
// several requests, or waits for a job, asks again for nothing). `context.seen`
// keeps it for the beacon after the call.
export async function suite(context, name) {
  context.found ??= (async () => {
    const project = await target(context);
    const hub = await findHub(project, context.options);
    return {project, hub, listing:await runningServices(hub.origin)};
  })();
  let found;
  try { found = await context.found; } catch (error) { context.found = undefined; throw error; }
  const {project, hub, listing} = found;
  context.seen = {project, listing};
  return {project, hub, listing, origin:name ? serviceOrigin(project, name, listing, context.options) : undefined,
    originOf:service => serviceOrigin(project, service, listing, context.options)};
}

// The Console API (`/console/api/v1`), which the engine serves on the
// Emulator UI port.
export function consoleBase(project, listing, options = {}) {
  if (listing && !listing.ui) {
    throw new ToolError(`This tool uses the console API, which the suite serves on the Emulator UI port, and the running suite for ${project.project} was started without the UI (no ui in the hub's /emulators listing). Restart it with --ui (firenook emulators:start --ui, or emulators:exec --ui), which starts the UI even where firebase.json sets emulators.ui.enabled to false; or set that to true.`);
  }
  return `${serviceOrigin(project, 'ui', listing, options)}/console/api/v1`;
}
// One Console API exchange: JSON in and out. A mutation always carries a JSON
// body (the console's guard refuses a bodiless POST as a simple request).
export async function consoleCall(context, path, {method = 'GET', query, body, ...rest} = {}) {
  const {project, listing} = await suite(context);
  const base = consoleBase(project, listing, context.options);
  const mutation = method !== 'GET' && method !== 'HEAD';
  return {project, listing, base, ...await call(`${base}${path}${queryString(query)}`, {method, body:body ?? (mutation && rest.raw === undefined ? {} : undefined), ...rest})};
}

// After each tools/call: tells the console an agent called (the Coding agent
// tab shows when). Fire-and-forget: about a second at most, every failure
// ignored (an older engine answers 404, a suite without the UI has no console).
export function postBeacon(seen, tool) {
  if (!seen?.listing?.ui) return Promise.resolve();
  let url;
  try { url = `${consoleBase(seen.project, seen.listing)}/agents/calls`; } catch { return Promise.resolve(); }
  return suiteFetch(url, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({client:CLIENT, tool}), signal:AbortSignal.timeout(1000)})
    .then(response => response.arrayBuffer()).then(() => undefined, () => undefined);
}

export const string = description => ({type:'string', description});
export const integer = (description, minimum = 1, maximum) => ({type:'integer', description, minimum, ...(maximum === undefined ? {} : {maximum})});
export const boolean = description => ({type:'boolean', description});
export const strings = description => ({type:'array', description, items:{type:'string'}});
export const schema = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
export const DATABASE = string('Firestore database id; default (default)');
export const BUCKET = string('Storage bucket; default <project>.appspot.com');
export const defaultBucket = project => `${project.project}.appspot.com`;

// Plain where filters ({field, op, value}) as a Firestore REST filter.
export const OPERATORS = {'==':'EQUAL', '!=':'NOT_EQUAL', '<':'LESS_THAN', '<=':'LESS_THAN_OR_EQUAL', '>':'GREATER_THAN', '>=':'GREATER_THAN_OR_EQUAL',
  'array-contains':'ARRAY_CONTAINS', 'array-contains-any':'ARRAY_CONTAINS_ANY', in:'IN', 'not-in':'NOT_IN'};
export const WHERE = {type:'array', description:'Filters combined with AND', items:schema({field:string('Field path'), op:{type:'string', enum:Object.keys(OPERATORS), description:'Comparison operator'}, value:{description:'Plain JSON value ({"$timestamp":...}, {"$ref":...} sentinels allowed)'}}, ['field', 'op', 'value'])};
export const ORDER_BY = {type:'array', description:'Sort keys', items:schema({field:string('Field path'), direction:{type:'string', enum:['asc', 'desc'], description:'Default asc'}}, ['field'])};
export function whereFilter(where = [], context = {}) {
  const filters = where.map(({field, op, value}) => {
    if (!OPERATORS[op]) throw new ToolError(`Unsupported operator ${op}; use one of ${Object.keys(OPERATORS).join(', ')}`);
    return {fieldFilter:{field:{fieldPath:field}, op:OPERATORS[op], value:encodeValue(value, context)}};
  });
  if (filters.length > 1) return {compositeFilter:{op:'AND', filters}};
  return filters[0];
}
export const sortOrder = orderBy => orderBy.map(({field, direction = 'asc'}) => ({field:{fieldPath:field}, direction:direction === 'desc' ? 'DESCENDING' : 'ASCENDING'}));
