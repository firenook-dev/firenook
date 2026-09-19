// Commands that address a running suite through the Emulator Hub: the same
// locator file (`<tmpdir>/hub-<projectId>.json`) and routes the official CLI
// uses, so either CLI can find a suite the other started.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PORTS, SERVICES, canonical, connectHost, contains, loadProject, validProjectId } from './options.mjs';

export const EXPORTABLE = ['firestore', 'auth', 'storage'];
export const METADATA_FILE = 'firebase-export-metadata.json';
// FIRESIDE_LOCATOR_DIR lets tests point the wrapper at a private directory.
export const locatorDirectory = () => process.env.FIRESIDE_LOCATOR_DIR || tmpdir();
export const locatorPath = project => join(locatorDirectory(), `hub-${project}.json`);

export function readLocator(project) {
  const path = locatorPath(project);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${path} is not valid JSON; stop every emulator for ${project} and delete it`); }
}

// The project as the launcher sees it, or (without a firebase.json) just the
// explicit --project id with default ports: export and delete only need the
// id to find the locator file.
export function resolveProject(options, cwd = process.cwd()) {
  try { return loadProject(options, cwd); }
  catch (error) {
    if (!/No firebase\.json/.test(error.message) || !validProjectId(options.project)) throw error;
    return {project:options.project, directory:cwd, host:'127.0.0.1', ports:{...DEFAULT_PORTS}, services:SERVICES, configless:true};
  }
}

const describe = error => error?.cause?.code || error?.cause?.message || error?.message || String(error);

// Finds the running hub: the locator file's origins first, then the port the
// configuration names. Returns {origin, status, locator}.
export async function findHub(project, options = {}) {
  const locator = readLocator(project.project);
  const origins = [...(Array.isArray(locator?.origins) ? locator.origins : [])];
  const configured = `http://${connectHost(project.host)}:${options['hub-port'] || project.ports.hub}`;
  if (!origins.includes(configured)) origins.push(configured);
  let failure;
  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}/`, {signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {origin, status:await response.json(), locator};
    } catch (error) { failure ??= error; }
  }
  const stale = locator ? ` If no suite is running, delete the stale locator ${locatorPath(project.project)}.` : '';
  throw new Error(`Did not find a running emulator hub for project ${project.project} (tried ${origins.join(', ')}): ${describe(failure)}. Start it with fireside emulators:start.${stale}`);
}

// Services the running suite reports, or undefined when the hub cannot list them.
export async function runningServices(origin) {
  try {
    const response = await fetch(`${origin}/emulators`, {signal:AbortSignal.timeout(5000)});
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
  const response = await fetch(`${origin}/_admin/export`, {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({path:destination, targets, initiatedBy:'fireside emulators:export'})});
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
// DELETE routes. Fireside never prompts, so the destructive forms need --force.
export async function firestoreDelete(path, options, argv = [], cwd = process.cwd(), log = console) {
  const project = resolveProject(options, cwd);
  const database = options.database || '(default)';
  const rerun = `fireside firestore:delete ${argv.join(' ')} --force`.replace(/\s+/g, ' ');
  const headers = {authorization:'Bearer owner'};
  const base = () => firestoreOrigin(project, options).then(origin => `${origin}/emulator/v1/projects/${encodeURIComponent(project.project)}/databases/${encodeURIComponent(database)}/documents`);
  const finish = async (response, result) => {
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = {message:text}; }
    if (!response.ok) throw new Error(`Firestore delete failed (HTTP ${response.status}): ${body?.error?.message || body?.message || text || 'no details'}`);
    const deleted = typeof body?.deleted === 'number' ? body.deleted : undefined;
    if (options.json) log.log(JSON.stringify({...result, deleted:deleted ?? null}));
    else log.log(deleted === undefined ? `Deleted ${result.mode === 'all-collections' ? `the ${database} database` : result.path}` : `Deleted ${deleted} documents`);
    return 0;
  };
  if (options['all-collections']) {
    if (path) throw new Error('--all-collections takes no path');
    if (!options.force) throw new Error(`Refusing to delete THE ENTIRE ${database} database of ${project.project} without --force. Re-run: ${rerun}`);
    const response = await fetch(await base(), {method:'DELETE', headers});
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
  const response = await fetch(url, {method:'DELETE', headers});
  return finish(response, {path:trimmed, mode});
}
