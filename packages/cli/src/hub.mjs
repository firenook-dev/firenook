// Commands that address a running suite through the Emulator Hub: the same
// locator file (`<tmpdir>/hub-<projectId>.json`) and routes the official CLI
// uses, so either CLI can find a suite the other started. The locator names
// one suite per project id, the first one started; each Firenook suite also
// keeps a record of its own, with its folder (see recordPath), so that two
// suites for one project id can each be found.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PORTS, SERVICES, canonical, connectHost, contains, findConfig, loadProject, validProjectId } from './options.mjs';
import { suiteFetch } from './client.mjs';

export const EXPORTABLE = ['firestore', 'auth', 'storage'];
export const METADATA_FILE = 'firebase-export-metadata.json';
// FIRENOOK_LOCATOR_DIR lets tests point the wrapper at a private directory.
export const locatorDirectory = () => process.env.FIRENOOK_LOCATOR_DIR || tmpdir();
export const locatorPath = project => join(locatorDirectory(), `hub-${project}.json`);

// Each Firenook suite's own record: the locator's fields (its hub's
// origins and its pid) and its project id, folder and firebase.json. It is
// named by the suite's pid, so no other suite ever writes it.
export const recordsDirectory = () => join(locatorDirectory(), 'firenook-hubs');
export const recordPath = (project, pid) => join(recordsDirectory(), `hub-${project}-${pid}.json`);
function readRecords(project) {
  let names;
  try { names = readdirSync(recordsDirectory()); } catch { return []; }
  const prefix = `hub-${project}-`;
  return names.filter(name => name.startsWith(prefix) && /^\d+\.json$/.test(name.slice(prefix.length))).flatMap(name => {
    const path = join(recordsDirectory(), name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return record?.projectId === project && Array.isArray(record.origins) ? [{...record, path}] : [];
    } catch { return []; }
  });
}
const samePath = (a, b) => {
  const [left, right] = [canonical(String(a)), canonical(String(b))];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const originPort = origin => { try { return Number(new URL(origin).port); } catch { return undefined; } };

// The hub's status when `origin` answers, with `pid` when one is given (a
// stale file whose port another suite took does not count).
async function probe(origin, pid, timeout = 2000) {
  try {
    const response = await suiteFetch(`${origin}/`, {signal:AbortSignal.timeout(timeout)});
    if (!response.ok) return undefined;
    const status = await response.json();
    if (pid !== undefined && status?.pid !== undefined && status.pid !== pid) return undefined;
    return status;
  } catch { return undefined; }
}
// The suites running for `project` that keep a record, each with the
// origin that answered.
async function runningRecords(project) {
  const found = await Promise.all(readRecords(project).map(async record => {
    for (const origin of record.origins) {
      const status = await probe(origin, record.pid);
      if (status) return {...record, origin, status};
    }
    return undefined;
  }));
  return found.filter(Boolean);
}
const listed = records => records.map(record => `${record.origin} from ${record.projectDir}`).join(', ');

export function readLocator(project) {
  const path = locatorPath(project);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${path} is not valid JSON; stop every emulator for ${project} and delete it`); }
}

// The project as the launcher sees it, or (without a firebase.json) just the
// explicit --project id with default ports: export and delete only need the
// id to find the locator file.
// Discovery (discoverProject below) applies only when neither --project,
// --config nor a firebase.json in cwd or a folder above it names a project.
export const needsDiscovery = (options, cwd = process.cwd()) => !options.project && !options.config && !findConfig(options, cwd);
export function resolveProject(options, cwd = process.cwd()) {
  try { return loadProject(options, cwd); }
  catch (error) {
    if (!/No firebase\.json/.test(error.message) || !validProjectId(options.project)) throw error;
    return {project:options.project, directory:cwd, host:'127.0.0.1', ports:{...DEFAULT_PORTS}, services:SERVICES, configless:true};
  }
}

const describe = error => error?.cause?.code || error?.cause?.message || error?.message || String(error);

// The suites running on this machine: every hub-<project>.json in the locator
// directory, probed in parallel. A locator answers when one of its origins
// does with the pid the file records (a stale file whose port another suite
// took does not count). Returns {answering, stale}, each [{project, path,
// origin?}] sorted by project id.
// The locator file names, rescanned only when the directory changed: the
// system temporary directory can hold tens of thousands of entries, and a
// directory's mtime moves whenever a file is added or removed (a change in
// the last two seconds is always rescanned, for coarse timestamps).
let scanned;
function locatorNames() {
  const directory = locatorDirectory();
  const {mtimeMs} = statSync(directory);
  if (scanned?.directory === directory && scanned.mtimeMs === mtimeMs && Date.now() - mtimeMs > 2000) return scanned.names;
  const names = readdirSync(directory).filter(name => /^hub-.+\.json$/.test(name) && validProjectId(name.slice('hub-'.length, -'.json'.length)));
  scanned = {directory, mtimeMs, names};
  return names;
}
// Every Firenook record counts too: a second suite for one project id has
// no locator of its own. A suite with both is listed once.
export async function runningSuites(timeout = 2000) {
  let names;
  try { names = locatorNames(); }
  catch { return {answering:[], stale:[]}; }
  let records = [];
  try { records = readdirSync(recordsDirectory()).filter(name => /^hub-.+-\d+\.json$/.test(name)); } catch { /* none */ }
  const files = [...names.map(name => ({path:join(locatorDirectory(), name), project:name.slice('hub-'.length, -'.json'.length)})),
    ...records.map(name => ({path:join(recordsDirectory(), name)}))];
  const probes = await Promise.all(files.map(async ({path, project}) => {
    let locator;
    try { locator = JSON.parse(readFileSync(path, 'utf8')); } catch { return {project, path, answering:false}; }
    project ??= locator?.projectId;
    if (!validProjectId(project)) return undefined;
    for (const origin of Array.isArray(locator?.origins) ? locator.origins : []) {
      const status = await probe(origin, locator.pid, timeout);
      if (status) return {project, path, origin, pid:status.pid ?? locator.pid, answering:true};
    }
    return {project, path, answering:false};
  }));
  const seen = new Set();
  const unique = probes.filter(Boolean).filter(probe => {
    if (!probe.answering) return true;
    const key = `${probe.project} ${probe.pid ?? probe.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const pick = answering => unique.filter(probe => probe.answering === answering).map(({answering: _, pid: __, ...probe}) => probe).sort((a, b) => a.project.localeCompare(b.project));
  return {answering:pick(true), stale:pick(false)};
}

// The project of the one running suite, for a command started outside any
// project folder (no firebase.json, no --project): the configless project
// resolveProject builds for --project, plus how it was found. Two answering
// suites ask for --project; none is an error naming emulators:start.
// --hub-port picks the suite whose hub it is.
export async function discoverProject(cwd = process.cwd(), command = 'this command', options = {}) {
  const found = await runningSuites();
  const stale = found.stale;
  const answering = options['hub-port'] ? found.answering.filter(suite => originPort(suite.origin) === Number(options['hub-port'])) : found.answering;
  if (answering.length === 1) {
    const [suite] = answering;
    return {project:suite.project, directory:cwd, host:'127.0.0.1', ports:{...DEFAULT_PORTS}, services:SERVICES, configless:true, discovered:{locator:suite.path, origin:suite.origin}};
  }
  if (answering.length > 1) {
    // --project tells suites of different projects apart; --hub-port, two of one.
    const projects = new Set(answering.map(suite => suite.project)).size;
    const choose = projects === answering.length ? 'with --project <id> to choose one' : `with --hub-port <port> to choose one${projects > 1 ? ', or with --project <id>' : ''}`;
    throw new Error(`${answering.length} running suites answer (${answering.map(suite => `${suite.project} at ${suite.origin}`).join(', ')}); start ${command} ${choose}`);
  }
  const ignored = stale.length ? ` (stale, not answering: ${stale.map(suite => suite.path).join(', ')})` : '';
  throw new Error(`No running suite found: no firebase.json in ${cwd}, no --project, and no hub locator in ${locatorDirectory()} answers${ignored}. Start the emulators with firenook emulators:start in the project folder, or start ${command} with --project <id> (or --config <firebase.json>).`);
}

// Finds the running hub. Returns {origin, status, locator}.
// --hub-port names the hub: that one, and no other. A project read from a
// folder's firebase.json reaches the suite started from that folder (its
// record says so), whichever suite the official locator names; a project
// known only by its id reaches the one Firenook suite running for it, and
// asks for --hub-port when there are two. Then, for a suite that keeps no
// record (the official CLI's), the locator file's origins, and the port the
// configuration names; a hub that answers there for another folder's
// suite is not this folder's.
export async function findHub(project, options = {}) {
  const locator = readLocator(project.project);
  const notFound = (origins, reason, more = '') => {
    const stale = locator ? ` If no suite is running, delete the stale locator ${locatorPath(project.project)}.` : '';
    return new Error(`Did not find a running emulator hub for project ${project.project} (tried ${origins.join(', ')}): ${reason}.${more} Start it with firenook emulators:start.${stale}`);
  };
  if (options['hub-port']) {
    const origin = `http://${connectHost(project.host)}:${options['hub-port']}`;
    try {
      const response = await suiteFetch(`${origin}/`, {signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {origin, status:await response.json(), locator};
    } catch (error) { throw notFound([origin], describe(error)); }
  }
  const records = await runningRecords(project.project);
  const folder = project.configless ? undefined : project.directory;
  const mine = folder ? records.filter(record => samePath(record.projectDir, folder)) : records;
  if (mine.length === 1) return {origin:mine[0].origin, status:mine[0].status, locator};
  if (mine.length > 1) {
    // Two from one folder (their ports set at the start): the configured hub's.
    const configured = folder && mine.find(record => originPort(record.origin) === project.ports.hub);
    if (configured) return {origin:configured.origin, status:configured.status, locator};
    throw new Error(`${mine.length} suites run for ${project.project} (${listed(mine)}); ${folder ? '' : 'run the command in the project\'s folder, or '}pass --hub-port <port> to choose one`);
  }
  const others = folder ? records : [];
  const origins = [...(Array.isArray(locator?.origins) ? locator.origins : [])];
  // A discovered project has no configuration of its own: its locator is all.
  const configured = `http://${connectHost(project.host)}:${project.ports.hub}`;
  if (!project.discovered && !origins.includes(configured)) origins.push(configured);
  let failure;
  for (const origin of origins) {
    try {
      const response = await suiteFetch(`${origin}/`, {signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      if (others.some(record => record.pid === status?.pid)) continue;
      return {origin, status, locator};
    } catch (error) { failure ??= error; }
  }
  const elsewhere = others.length === 1 ? ` 1 other suite for ${project.project} runs, from another folder (${listed(others)}); --hub-port reaches it.`
    : others.length ? ` ${others.length} other suites for ${project.project} run, from other folders (${listed(others)}); --hub-port reaches one.` : '';
  throw notFound(origins, failure ? describe(failure) : 'the hub there is another folder\'s suite', elsewhere);
}

// Services the running suite reports, or undefined when the hub cannot list them.
export async function runningServices(origin) {
  try {
    const response = await suiteFetch(`${origin}/emulators`, {signal:AbortSignal.timeout(5000)});
    if (!response.ok) return undefined;
    const body = await response.json();
    return body && typeof body === 'object' ? body : undefined;
  } catch { return undefined; }
}

// The HTTP origin of one running service: the hub's listing first (the suite
// may run on ports other than the configured ones), otherwise the configured
// host and port. `listing` (from runningServices) avoids a second hub round
// trip when the caller already has it. A listing that omits the service means
// the suite did not start it, which is an error.
export const SERVICE_LABELS = {firestore:'Firestore', auth:'Auth', storage:'Storage', functions:'Functions', pubsub:'Pub/Sub', tasks:'Cloud Tasks', eventarc:'Eventarc', hub:'the hub', ui:'the Emulator UI', logging:'logging'};
export function serviceOrigin(project, name, listing, options = {}) {
  const service = listing?.[name];
  if (listing && !service) throw new Error(`The running suite for ${project.project} did not start ${SERVICE_LABELS[name] || name} (it is absent from the hub's /emulators listing)`);
  if (service?.host && service?.port) return `http://${connectHost(String(service.host))}:${service.port}`;
  const port = options[`${name}-port`] || project.ports?.[name];
  if (!port) throw new Error(`No port is known for the ${name} emulator of ${project.project}`);
  return `http://${connectHost(project.host)}:${port}`;
}

// Finds the hub and resolves a service origin in one step.
export async function locateService(project, name, options = {}) {
  const {origin} = await findHub(project, options);
  return serviceOrigin(project, name, await runningServices(origin), options);
}

// emulators:export <path>: like the official command, the export runs inside
// the suite; the CLI only checks the destination and posts the request.
export async function exportEmulators(target, options, cwd = process.cwd(), log = console) {
  if (!target) throw new Error('emulators:export requires a destination directory');
  const project = resolveProject(options, cwd);
  const destination = canonical(resolve(cwd, target));
  if (contains(destination, canonical(cwd)) || contains(destination, canonical(project.directory))) {
    throw new Error('Export destination must not be the project directory, the current directory or an ancestor of either; choose a dedicated directory');
  }
  if (existsSync(destination)) {
    if (!statSync(destination).isDirectory()) throw new Error(`${destination} exists and is not a directory`);
    const entries = readdirSync(destination);
    if (entries.length && !entries.includes(METADATA_FILE) && !options.force) {
      throw new Error(`${destination} is not empty and holds no ${METADATA_FILE}; re-run with --force to overwrite its contents`);
    }
  }
  const {origin} = await findHub(project, options);
  const running = await runningServices(origin);
  const targets = EXPORTABLE.filter(name => project.services.includes(name) && (!running || Object.hasOwn(running, name)));
  if (!targets.length) throw new Error(`Nothing to export: none of ${EXPORTABLE.join(', ')} is selected and running (check --only and the started services)`);
  if (!existsSync(destination)) mkdirSync(destination, {recursive:true});
  log.error(`Found running emulator hub for project ${project.project} at ${origin}; exporting ${targets.join(', ')} to ${destination}`);
  // No Origin header: the hub refuses requests that carry one.
  const response = await suiteFetch(`${origin}/_admin/export`, {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({path:destination, targets, initiatedBy:'firenook emulators:export'})});
  const text = await response.text();
  let message;
  try { message = JSON.parse(text)?.message; } catch { message = text; }
  if (!response.ok) throw new Error(`Export request failed (HTTP ${response.status}): ${message || 'see the emulator log'}`);
  if (options.json) log.log(JSON.stringify({path:destination, targets, ok:true}));
  else log.log(`Export complete: ${destination}`);
  return 0;
}

// The Firestore REST origin of the running suite: the hub's listing when it
// answers, otherwise the configured port.
const firestoreOrigin = (project, options) => locateService(project, 'firestore', options);

// firestore:delete [path]: the official flag contract over the emulator's
// DELETE routes. Firenook never prompts, so the destructive forms need --force.
export async function firestoreDelete(path, options, argv = [], cwd = process.cwd(), log = console) {
  const project = resolveProject(options, cwd);
  const database = options.database || '(default)';
  const rerun = `firenook firestore:delete ${argv.join(' ')} --force`.replace(/\s+/g, ' ');
  const headers = {authorization:'Bearer owner'};
  const base = () => firestoreOrigin(project, options).then(origin => `${origin}/emulator/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents`);
  const finish = async (response, result) => {
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = {message:text}; }
    if (!response.ok) throw new Error(`Firestore delete failed (HTTP ${response.status}): ${body?.error?.message || body?.message || text || 'no details'}`);
    const deleted = typeof body?.deleted === 'number' ? body.deleted : undefined;
    if (options.json) log.log(JSON.stringify({...result, deleted:deleted ?? null}));
    else log.log(deleted === undefined ? `Deleted ${result.mode === 'all-collections' ? `the ${database} database` : result.path}` : `Deleted ${deleted} ${deleted === 1 ? 'document' : 'documents'}`);
    return 0;
  };
  if (options['all-collections']) {
    if (path) throw new Error('--all-collections takes no path');
    if (!options.force) throw new Error(`Refusing to delete THE ENTIRE ${database} database of ${project.project} without --force. Re-run: ${rerun}`);
    const response = await suiteFetch(await base(), {method:'DELETE', headers});
    return finish(response, {path:null, mode:'all-collections'});
  }
  if (!path) throw new Error('Must specify a path.');
  const trimmed = path.replace(/(^\/+|\/+$)/g, '');
  const segments = trimmed.split('/');
  if (!trimmed || segments.some(segment => !segment)) throw new Error('Path must not have any empty segments.');
  const document = segments.length % 2 === 0;
  if (!document && !options.recursive && !options.shallow) throw new Error('Must pass recursive or shallow option when deleting a collection.');
  const mode = options.recursive ? 'recursive' : 'shallow';
  if (!document && options.recursive && !options.force) {
    throw new Error(`Refusing to recursively delete the collection ${trimmed} of ${project.project} without --force. Re-run: ${rerun}`);
  }
  const url = `${await base()}/${segments.map(encodeURIComponent).join('/')}?mode=${mode}`;
  const response = await suiteFetch(url, {method:'DELETE', headers});
  return finish(response, {path:trimmed, mode});
}
