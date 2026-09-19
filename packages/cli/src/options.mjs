import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// The five data services Fireside emulates.
export const SERVICES = ['firestore', 'auth', 'storage', 'functions', 'pubsub'];
// Every name the official CLI accepts in --only and under firebase.json emulators.
export const OFFICIAL_EMULATORS = ['auth', 'functions', 'firestore', 'database', 'hosting', 'pubsub', 'storage', 'eventarc', 'dataconnect', 'tasks', 'apphosting', 'extensions', 'ui', 'logging', 'hub'];
// Official services Fireside does not implement (roadmap).
export const UNIMPLEMENTED = ['database', 'hosting', 'dataconnect', 'apphosting'];
// Listeners that follow their parent: eventarc/tasks with functions, the rest always.
const FOLLOWERS = ['eventarc', 'tasks', 'hub', 'ui', 'logging'];
const LISTENERS = ['firestore', 'auth', 'storage', 'functions', 'pubsub', 'hub', 'ui', 'logging', 'eventarc', 'tasks'];
// The official default ports, used when firebase.json names none; every port
// is still passed to the engine explicitly.
export const DEFAULT_PORTS = {firestore:8080, auth:9099, storage:9199, functions:5001, pubsub:8085, hub:4400, ui:4000, logging:4500, eventarc:9299, tasks:9499, 'firestore-websocket':9150};
export const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];
export const VERBOSITIES = ['DEBUG', 'INFO', 'QUIET', 'SILENT', 'WARN', 'ERROR'];

const values = new Set(['project', 'config', 'import', 'only', 'state-dir', 'host', 'minimum-functions', 'storage-bucket', 'firestore-websocket-port', 'logging-port', 'eventarc-port', 'tasks-port', 'hub-port', 'durability', 'instance', 'data', 'event-data', 'params', 'auth', 'resource', 'event-type', 'region', 'method', 'log-verbosity', 'alias', 'add', 'unalias', 'database']);
const durabilities = new Set(['write-behind', 'per-commit']);
const switches = new Set(['resume-state', 'no-diagnostics', 'help', 'offline', 'non-interactive', 'json', 'force', 'debug', 'ui', 'adopt', 'dry-run', 'recursive', 'shallow', 'all-collections', 'clear', 'functions', 'no-functions']);
// Optional-value options: a bare flag or --name=value.
const optionalValues = new Set(['inspect-functions']);
// Official single-letter aliases.
const shorts = {P:'project', c:'config', C:'config', r:'recursive', f:'force', h:'help'};
const repeated = new Set(['storage-bucket', 'instance']);

// Returns {options, command, positionals, flags}: `command` is the argv after
// `--` (undefined when absent), `positionals` the bare arguments, `flags` the
// remaining arguments in order (for reprinting a corrected command line).
export function parseOptions(argv) {
  const options = {'storage-bucket': [], instance: []};
  const positionals = [];
  const flags = [];
  let command;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { command = argv.slice(i + 1); break; }
    let name, value;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      name = arg.slice(2, equals < 0 ? undefined : equals);
      value = equals < 0 ? undefined : arg.slice(equals + 1);
    } else if (/^-[A-Za-z]$/.test(arg)) {
      name = shorts[arg[1]];
      if (!name) throw new Error(`Unsupported option ${arg}; no option is silently ignored.`);
    } else { positionals.push(arg); continue; }
    flags.push(arg);
    if (switches.has(name)) {
      if (value !== undefined) throw new Error(`--${name} does not take a value`);
      value = true;
    } else if (optionalValues.has(name)) {
      if (value === undefined) value = true;
      else if (!/^\d+$/.test(value)) throw new Error(`--${name} takes a TCP port when given a value`);
    } else if (values.has(name) || name === 'export-on-exit') {
      const next = argv[i + 1];
      if (value === undefined && next !== undefined && !(name === 'export-on-exit' ? next.startsWith('-') : next.startsWith('--'))) { value = argv[++i]; flags.push(value); }
      if (value === undefined && name === 'export-on-exit') value = true;
      if (value === undefined || value === '') throw new Error(`--${name} requires a value`);
    } else throw new Error(`Unsupported option --${name}; no option is silently ignored.`);
    if (repeated.has(name)) options[name].push(value);
    else {
      if (Object.hasOwn(options, name)) throw new Error(`Duplicate --${name}`);
      options[name] = value;
    }
  }
  if (options.durability !== undefined && !durabilities.has(options.durability)) {
    throw new Error(`--durability must be write-behind (default) or per-commit, not ${options.durability}`);
  }
  if (options['log-verbosity'] !== undefined) {
    options['log-verbosity'] = String(options['log-verbosity']).toUpperCase();
    if (!VERBOSITIES.includes(options['log-verbosity'])) throw new Error(`--log-verbosity must be one of ${VERBOSITIES.join(', ')}`);
  }
  if (options.recursive && options.shallow) throw new Error('Cannot pass recursive and shallow options together.');
  if (options.functions && options['no-functions']) throw new Error('--functions and --no-functions are exclusive');
  return {options, command, positionals, flags};
}

// Firebase project ids: lowercase, 6 to 30 characters, start with a letter,
// end with a letter or digit. demo-* ids of any length stay local by contract.
export const validProjectId = id => typeof id === 'string' && (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) || /^demo-[a-z0-9][a-z0-9-]*$/.test(id));
export const isDemoProject = id => typeof id === 'string' && id.startsWith('demo-');
export const isLoopback = host => LOOPBACK.includes(host);
// Host clients connect to when the suite binds a wildcard address.
export function connectHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]' || host === '::1') return '[::1]';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// Resolve existing parent symlinks even for a destination that does not exist.
export function canonical(path) {
  path = resolve(path);
  if (existsSync(path)) return realpathSync(path);
  return resolve(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
export const contains = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Reads firebase.json and .firebaserc with every check the launcher applies,
// collecting findings instead of throwing: `errors` (Fireside cannot start),
// `warnings` (configured official services it skips, safety notes). Invalid
// JSON and a missing firebase.json still throw.
export function inspectProject(options, cwd = process.cwd()) {
  const errors = [];
  const warnings = [];
  const fail = (code, message) => errors.push({code, message});
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  if (!existsSync(config)) throw new Error(`No firebase.json at ${config}; run fireside init in the project directory or pass --config`);
  let data;
  try { data = readJson(config); } catch (error) { throw new Error(`${config} is not valid JSON: ${error.message}`); }
  if (!isObject(data)) throw new Error(`${config} must contain a JSON object`);
  const rc = resolve(directory, '.firebaserc');
  let rcData = {};
  if (existsSync(rc)) {
    try { rcData = readJson(rc); } catch (error) { throw new Error(`${rc} is not valid JSON: ${error.message}`); }
  }
  const aliases = isObject(rcData?.projects) ? rcData.projects : {};
  const selection = options.project || aliases.default;
  const project = (selection !== undefined && aliases[selection]) || selection;
  if (!project) fail('project-missing', 'No project id. Pass --project <id> (or -P <id>), or record one with fireside use --add <id> (projects.default in .firebaserc).');
  else if (!validProjectId(project)) fail('project-invalid', `Invalid project id ${project}: use lowercase letters, digits and hyphens (6 to 30 characters, starting with a letter), or a demo- prefix for a local-only project.`);
  const demo = isDemoProject(project);

  const emulators = data.emulators ?? {};
  if (!isObject(emulators)) fail('emulators', 'firebase.json emulators must be an object');
  const known = [...SERVICES, 'hub', 'ui', 'logging', 'eventarc', 'tasks', 'extensions', 'singleProjectMode'];
  const skipped = [];
  for (const name of Object.keys(isObject(emulators) ? emulators : {})) {
    if (UNIMPLEMENTED.includes(name)) { skipped.push(name); warnings.push(`Fireside: firebase.json configures the ${name} emulator, which Fireside does not implement; skipping it.`); }
    else if (!known.includes(name)) fail('emulators-key', `Unsupported configured emulator: ${name}. Valid emulators keys are ${[...known, ...UNIMPLEMENTED].join(', ')}.`);
  }
  const has = key => Object.hasOwn(data, key);
  const hasEmulator = name => isObject(emulators) && Object.hasOwn(emulators, name);
  // Official filterEmulatorTargets: a top-level section or an emulators entry
  // configures a service; extensions count as functions.
  const configured = SERVICES.filter(name => {
    if (name === 'functions') return has('functions') || has('extensions') || hasEmulator('functions') || hasEmulator('extensions');
    if (name === 'firestore' || name === 'storage') return has(name) || hasEmulator(name);
    return hasEmulator(name);
  });
  let services = configured;
  if (options.only !== undefined) {
    const requested = String(options.only).split(',').map(item => item.trim().split(':')[0]).filter(Boolean);
    if (!requested.length) fail('only', '--only requires a comma-separated list of emulator names');
    const wanted = new Set();
    for (const name of requested) {
      if (!OFFICIAL_EMULATORS.includes(name)) fail('only', `${name} is not a valid emulator name, valid options are: ${JSON.stringify(OFFICIAL_EMULATORS)}`);
      else if (UNIMPLEMENTED.includes(name)) fail('only', `The ${name} emulator is not implemented by Fireside (roadmap); remove it from --only.`);
      else if (name === 'extensions') wanted.add('functions');
      else if (!FOLLOWERS.includes(name)) wanted.add(name);
    }
    for (const name of wanted) if (!configured.includes(name)) warnings.push(`Fireside: not starting the ${name} emulator; firebase.json does not configure it (run fireside init --adopt or add emulators.${name}).`);
    services = configured.filter(name => wanted.has(name));
  }
  if (!errors.length && !services.length) fail('services', 'No emulators to start, run fireside init to get started.');

  const uiConfig = isObject(emulators) ? emulators.ui : undefined;
  if (uiConfig !== undefined && !isObject(uiConfig)) fail('ui', 'firebase.json emulators.ui must be an object');
  const ui = uiConfig?.enabled !== false;
  const uiExplicit = uiConfig?.enabled === true;
  const spm = isObject(emulators) ? emulators.singleProjectMode : undefined;
  if (spm !== undefined && typeof spm !== 'boolean') fail('single-project-mode', 'firebase.json emulators.singleProjectMode must be true or false');
  const singleProjectMode = spm !== false;

  if (has('storage')) {
    if (Array.isArray(data.storage)) {
      for (const entry of data.storage) if (!isObject(entry) || !entry.target || !entry.rules) fail('storage', 'Each firebase.json storage array entry needs target and rules.');
    } else if (!isObject(data.storage) || typeof data.storage.rules !== 'string') fail('storage', 'firebase.json storage must be {rules} or an array of {target, rules} entries.');
  }
  if (has('firestore')) {
    if (Array.isArray(data.firestore)) {
      let unnamed = 0;
      for (const entry of data.firestore) {
        if (!isObject(entry)) { fail('firestore', 'Each firebase.json firestore array entry must be an object.'); continue; }
        if (entry.database === undefined) unnamed += 1;
        else if (typeof entry.database !== 'string' || !entry.database) fail('firestore', 'firebase.json firestore[].database must be a database id.');
      }
      if (unnamed > 1) fail('firestore', 'At most one firebase.json firestore entry may omit database (it is the (default) database).');
    } else if (!isObject(data.firestore)) fail('firestore', 'firebase.json firestore must be an object or an array of {database, rules, indexes} entries.');
  }

  const entry = name => (isObject(emulators) && isObject(emulators[name]) ? emulators[name] : undefined);
  const configuredHost = LISTENERS.map(name => entry(name)?.host).find(host => typeof host === 'string' && host);
  const host = options.host || configuredHost || '127.0.0.1';
  if (typeof host !== 'string' || !host.trim()) fail('host', '--host requires a host name or address');
  for (const name of LISTENERS) {
    const own = entry(name)?.host;
    if (own && own !== host && !isLoopback(own)) fail('host', `Unsupported host for ${name}: ${own} differs from ${host}; the Fireside suite listens on one host (use --host or the same emulators.<name>.host everywhere).`);
  }
  if (typeof host === 'string' && !isLoopback(host)) warnings.push(`Fireside: binding ${host}; the emulators have no authentication, so every service, the data and arbitrary Functions execution are reachable from any device that can reach this host.`);

  const ports = {};
  for (const name of [...LISTENERS, 'firestore-websocket']) {
    const override = options[`${name}-port`];
    const value = override ?? (name === 'firestore-websocket' ? entry('firestore')?.websocketPort : entry(name)?.port) ?? DEFAULT_PORTS[name];
    if (value !== undefined) {
      if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) fail('port', `Invalid port for ${name}`);
      ports[name] = Number(value);
    }
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) fail('port', 'Emulator ports must be distinct');

  const imported = options.import ? canonical(resolve(cwd, options.import)) : undefined;
  let exported = options['export-on-exit'];
  if (exported === true) exported = imported;
  if (options['export-on-exit'] && !exported) fail('export', '--export-on-exit requires --import or an explicit destination');
  if (exported) {
    exported = canonical(resolve(cwd, exported));
    if (contains(exported, canonical(cwd)) || contains(exported, canonical(directory))) fail('export', 'Export destination must not be the project directory or an ancestor');
  }
  const state = options['state-dir'] ? canonical(resolve(cwd, options['state-dir'])) : undefined;
  if (state && existsSync(state) && !options['resume-state'] && readdirSync(state).length) fail('state', 'Existing nonempty state requires explicit --resume-state; never silently reimport or reset it');
  if (options['minimum-functions'] !== undefined && !/^\d+$/.test(String(options['minimum-functions']))) fail('minimum-functions', '--minimum-functions must be a nonnegative integer');
  if (state && [imported, exported, canonical(directory)].filter(Boolean).some(path => contains(state, path) || (path !== canonical(directory) && contains(path, state)))) {
    fail('state', 'State must be separate from seed/export directories and must not contain the project');
  }
  if (options['resume-state'] && (!imported || !state)) fail('state', '--resume-state requires explicit --state-dir and --import');
  if (options['resume-state'] && imported && exported && (contains(imported, exported) || contains(exported, imported))) fail('state', 'Resume exports must be separate from the immutable seed');
  // The engine needs a positive minimum only when a Functions codebase exists.
  const functionsConfigured = has('functions') || has('extensions');
  const minimumFunctions = options['minimum-functions'] !== undefined ? String(options['minimum-functions']) : (services.includes('functions') && functionsConfigured ? '1' : '0');
  return {config, directory, rc, data, project, demo, configured, services, skipped, ui, uiExplicit, singleProjectMode, host, ports, imported, exported, state, minimumFunctions, errors, warnings};
}

export function loadProject(options, cwd = process.cwd()) {
  const project = inspectProject(options, cwd);
  if (project.errors.length) throw new Error(project.errors[0].message);
  return project;
}
