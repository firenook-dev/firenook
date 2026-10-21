import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binaryPath, manifest, release } from './binary.mjs';
import { SERVICES, connectHost, launchContext, loadProject } from './options.mjs';
import { nativeEnvironment, requestNativeStop } from './processes.mjs';
import { buildPlan, errorPlace, startBuild } from './build.mjs';

// The Functions workers run on this Node and are tested on Node 24. The check
// is here and not in package.json's engines: npm refuses no release for its
// engines, it quietly installs an older one (for this name, the 0.0.0
// placeholder), so engines names only the floor npm itself runs on.
export function requireNode(version = process.versions.node) {
  if (Number(version.split('.')[0]) !== 24) throw new Error(`the emulators need Node 24, since your Functions run on it; this is Node ${version}. Switch to Node 24 (with nvm: nvm install 24) and run it again`);
}

// `quiet`: the terminal UI shows the configuration findings itself.
export async function diagnose(options, cwd = process.cwd(), {quiet = false} = {}) {
  requireNode();
  // Configuration findings first: they need no installed engine.
  const project = loadProject(options, cwd);
  if (!quiet) for (const warning of project.warnings) console.error(warning);
  const binary = binaryPath();
  // Functions run on the owned runtime with Node workers; Extensions are
  // resolved natively; the console is in the binary. Neither firebase-tools,
  // Java nor a downloaded asset is consulted.
  const extensions = extensionsStatus(binary, project);
  return {binary, project, extensions, services:project.services, demo:project.demo, ui:project.ui,
    singleProjectMode:project.singleProjectMode, warnings:project.warnings, version:manifest.version, engineRevision:release.engineRevision};
}

// Read-only: which extension instances start offline, and which still need the
// registry (a Firebase CLI login or FIREBASE_TOKEN) on first start.
export function extensionsStatus(binary, project) {
  if (!project.data.extensions || !Object.keys(project.data.extensions).length) return [];
  const result = spawnSync(binary, ['extensions', 'status', '--config', project.config, '--project-id', project.project, '--node', process.execPath],
    {cwd:project.directory, env:nativeEnvironment(), encoding:'utf8', windowsHide:true});
  if (result.status !== 0) throw new Error(`extensions status failed: ${(result.stderr || result.stdout || '').trim()}`);
  return JSON.parse(result.stdout);
}

// Copies registry extensions into <project>/extensions/.sources with their
// registry metadata; later starts need no network and no token. Offline, only
// what the shared cache holds with its sidecar is copied, and the registry is
// never contacted.
export function vendorExtensions(binary, project, instances = [], {offline = false} = {}) {
  const args = ['extensions', 'vendor', '--config', project.config, '--project-id', project.project, '--node', process.execPath];
  for (const instance of instances) args.push('--instance', instance);
  if (offline) args.push('--offline');
  const result = spawnSync(binary, args, {cwd:project.directory, env:nativeEnvironment(), stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Records the seed as it is now as the one saved data came from, keeping
// the data; the engine prints what it did.
export function adoptSeed(binary, stateDir, seed) {
  const result = spawnSync(binary, ['state', 'adopt-seed', '--state-dir', stateDir, '--import', seed],
    {env:nativeEnvironment(), stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Returns a stopped store's free pages to the disk, copying the file first
// unless asked not to; the engine prints what it did.
export function compactState(binary, stateDir, {copy = true} = {}) {
  const result = spawnSync(binary, ['state', 'compact', '--state-dir', stateDir, ...(copy ? [] : ['--no-copy'])],
    {env:nativeEnvironment(), stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Prints what a stopped store's file holds, table by table.
export function inspectState(binary, stateDir) {
  const result = spawnSync(binary, ['state', 'inspect', '--state-dir', stateDir],
    {env:nativeEnvironment(), stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Builds the native suite invocation. `mode` is 'start' or 'exec': like the
// official CLI, exec keeps the console off unless --ui is given or
// firebase.json enables it explicitly. `typed` is the command's arguments as
// the developer typed them, which the console reprints in its fixes.
// `quiet`: the terminal UI draws its own banner instead of these lines.
export function prepareLaunch(diagnostic, options, mode = 'start', typed = [], {quiet = false} = {}) {
  const say = quiet ? () => {} : (...line) => console.error(...line);
  const p = diagnostic.project;
  const parent = join(p.directory, '.firenook', 'runs');
  mkdirSync(parent, {recursive:true});
  const run = mkdtempSync(join(parent, 'session-'));
  const state = p.state || join(run, 'state');
  const rc = existsSync(p.rc) ? p.rc : join(run, '.firebaserc');
  if (!existsSync(rc)) writeFileSync(rc, '{}\n', {flag:'wx', mode:0o600});
  const credentials = join(run, 'demo-adc.json');
  writeFileSync(credentials, JSON.stringify({type:'authorized_user', client_id:'demo', client_secret:'demo', refresh_token:'demo'}), {flag:'wx', mode:0o600});
  // The engine reads emulators.ui.enabled itself, so --ui cannot re-enable a
  // console the configuration disables; it only keeps it on for exec.
  const ui = p.ui && (mode !== 'exec' || Boolean(options.ui) || p.uiExplicit);
  if (options.ui && !p.ui) say('note: --ui cannot enable the console while firebase.json sets emulators.ui.enabled to false');
  const debug = Boolean(options.debug) || options['log-verbosity'] === 'DEBUG';
  const debugLog = debug ? join(run, 'firenook-debug.log') : undefined;
  const args = ['suite', '--project-dir', p.directory, '--config', p.config, '--firebase-rc', rc,
    '--project-id', p.project, '--host', p.host,
    '--node', process.execPath, '--state-dir', state, '--minimum-functions', String(p.minimumFunctions)];
  // Absent --only means every service; the engine binds only the selected ones.
  // The alias the project was selected by: each codebase also reads .env.<alias>.
  if (p.alias) args.push('--project-alias', p.alias);
  if (p.services.length < SERVICES.length) args.push('--only', p.services.join(','));
  if (!ui) args.push('--no-ui');
  if (!p.singleProjectMode) args.push('--single-project-mode', 'false');
  if (debugLog) args.push('--debug-log', debugLog);
  if (options['inspect-functions'] !== undefined) args.push(options['inspect-functions'] === true ? '--inspect-functions' : `--inspect-functions=${options['inspect-functions']}`);
  if (options.offline) args.push('--offline');
  for (const [name, port] of Object.entries(p.ports)) args.push(`--${name}-port`, String(port));
  for (const bucket of options['storage-bucket']) args.push('--storage-bucket', bucket);
  if (p.imported) args.push('--import', p.imported);
  if (p.exported) args.push('--export-on-exit', p.exported);
  if (p.resume) args.push('--resume-state');
  if (options['no-diagnostics']) args.push('--no-diagnostics');
  // The console answers only the names it is reached by (loopback and
  // --host by default); a proxy or cloud name is added here.
  if (options['allowed-hosts']) args.push('--allowed-hosts', options['allowed-hosts']);
  if (options.durability) args.push('--durability', options.durability);
  // Why each absent service is absent, so the console's sections can say so
  // and show the fix (a firebase.json snippet, or this command with the
  // service added to --only).
  const context = launchContext(p, {command:`firenook emulators:${mode === 'exec' ? 'exec' : 'start'}`, args:typed});
  args.push('--launch-context', JSON.stringify(context));
  const host = connectHost(p.host);
  // The engine cannot know its own release: this wrapper's version is set by
  // the packaging checkout, while the binary is built from the pinned engine
  // commit. So tell it, and its `--version` and the console's engine badge
  // report what was installed instead of the placeholder crate version.
  const env = {...process.env, FIRENOOK_RELEASE_VERSION:manifest.version, FIRENOOK_ENGINE_REVISION:release.engineRevision,
    GOOGLE_CLOUD_PROJECT:p.project, GCLOUD_PROJECT:p.project,
    GOOGLE_APPLICATION_CREDENTIALS:credentials, CLOUDSDK_CONFIG:join(run, 'gcloud'),
    FIRESTORE_EMULATOR_HOST:`${host}:${p.ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST:`${host}:${p.ports.auth}`,
    FIREBASE_STORAGE_EMULATOR_HOST:`${host}:${p.ports.storage}`, STORAGE_EMULATOR_HOST:`http://${host}:${p.ports.storage}`,
    FIREBASE_EMULATOR_HUB:`${host}:${p.ports.hub}`, PUBSUB_EMULATOR_HOST:`${host}:${p.ports.pubsub}`};
  // FIREBASE_TOKEN stays available to the native process for the Extensions
  // registry only; the runtime keeps it (and every credential) out of the
  // Functions workers' environment.
  delete env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  writeFileSync(join(run, 'launch.json'), JSON.stringify({version:manifest.version, engineRevision:release.engineRevision, args, state, exported:p.exported,
    services:p.services, ui, singleProjectMode:p.singleProjectMode, project:{id:p.project, demo:p.demo}, debugLog, build:Boolean(options.build)}, null, 2));
  say(`Firenook ${manifest.version}; engine ${release.engineRevision}; disk/WAL state ${state}`);
  say(`Services: ${p.services.join(', ')}; Emulator UI ${ui ? 'on' : 'off'}; host ${p.host}`);
  if (p.demo) say(`Demo project ${p.project}: no cloud service is contacted, but user Functions can still reach external providers; this CLI is not a network sandbox.`);
  else say(`Firenook: real project id ${p.project}; every Functions worker is started with the emulator hosts and without Google credentials, but this CLI is not a network sandbox.`);
  if (debugLog) say(`Debug log: ${debugLog}`);
  if (options['log-verbosity'] && options['log-verbosity'] !== 'DEBUG') say(`note: --log-verbosity ${options['log-verbosity']} is accepted for compatibility; Firenook prints its full log`);
  say(`Working data and launch receipt are preserved in ${run}. No automatic deletion.`);
  // --build: the codebases whose own build Firenook runs beside the engine.
  const builds = options.build ? buildPlan(p, mode) : [];
  for (const entry of builds) say(entry.script ? `Build: ${entry.shown} runs its ${entry.script} script${entry.watch ? ', and Firenook loads what it writes on every save' : ' before the emulators start'}`
    : `note: ${entry.shown} has no build or build:watch script, so --build builds nothing there`);
  return {binary:diagnostic.binary, args, env:nativeEnvironment(env), cwd:p.directory, run, ui, services:p.services, debugLog, builds};
}

// --build without the terminal UI: each build's lines on stderr, marked
// with its codebase, starting before the engine does.
function startBuilds(launch, stopping, write = text => process.stderr.write(`${text}\n`)) {
  return (launch.builds ?? []).filter(entry => entry.script).map(entry => {
    const tag = `build ${entry.shown}:`;
    const errors = list => { for (const error of list) write(`${tag} ${errorPlace(error)} ${error.code}: ${error.message}`); };
    return startBuild(entry, {onEvent: event => {
      if (event.type === 'compiled') { errors(event.errors); write(`${tag} ${event.count ? `${event.count} ${event.count === 1 ? 'error' : 'errors'}` : 'compiled, no errors'}`); }
      else if (event.type === 'text') write(`${tag} ${event.text}`);
      else if (event.type === 'ended' && !stopping()) {
        if (!entry.watch) errors(event.errors ?? []);
        if (event.code !== 0 || entry.watch) write(`${tag} ${entry.script} ${event.code === 0 ? 'ended' : event.error ? `could not run: ${event.error.message}` : `failed (exit code ${event.code})`}${entry.watch ? '; saves are no longer compiled' : ''}`);
      }
    }});
  });
}

// Signal only children owned by this invocation. Wait through native export;
// never kill by port/name or return success before shutdown completes.
// `command` is an argv array (spawned directly) or a script string (run
// through the platform shell, as the official emulators:exec does).
export async function supervise(launch, command) {
  // The builds come first: a start loads what they wrote, and exec runs no
  // test on code that did not build.
  let requestedStop = false;
  const builds = startBuilds(launch, () => requestedStop);
  if (builds.length) {
    let interrupted = false;
    const early = () => { interrupted = requestedStop = true; for (const build of builds) build.stop(); };
    process.on('SIGINT', early);
    process.on('SIGTERM', early);
    let firsts;
    try { firsts = await Promise.all(builds.map(build => build.first)); } finally { process.off('SIGINT', early); process.off('SIGTERM', early); }
    if (interrupted) return 130;
    const failed = builds.findIndex((build, at) => !build.entry.watch && firsts[at].code !== 0);
    if (failed !== -1 && command?.length) {
      for (const build of builds) build.stop();
      throw new Error(`the build in ${builds[failed].entry.shown} failed (${builds[failed].command}); the tests did not run`);
    }
  }
  const child = spawn(launch.binary, launch.args, {cwd:launch.cwd, env:launch.env,
    detached:process.platform === 'win32', windowsHide:true,
    stdio:[process.platform === 'win32' ? 'pipe' : 'inherit','pipe','pipe']});
  child.stdin?.on('error', error => { startupError = error; });
  let testChild;
  let ready = false;
  let commandStatus;
  let tail = '';
  let startupError;
  const stop = signal => {
    requestedStop = true;
    for (const build of builds) build.stop();
    if (testChild && testChild.exitCode === null) testChild.kill(signal);
    if (child.exitCode === null) requestNativeStop(child, signal);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  // A start that prints nothing for 20 minutes is stopped, keeping the data;
  // one that keeps reporting (a long repair prints as it goes) is not.
  const quiet = () => setTimeout(() => {
    startupError = new Error('The engine printed nothing for 20 minutes while starting; requesting graceful shutdown and preserving state.');
    stop('SIGTERM');
  }, 20 * 60 * 1000);
  let timeout = quiet();
  function output(chunk, destination) {
    destination.write(chunk);
    if (!ready) { clearTimeout(timeout); timeout = quiet(); }
    tail = (tail + chunk.toString()).slice(-4096);
    if (!ready && /(?:^|\n)All emulators ready\r?\n/.test(tail)) {
      ready = true;
      clearTimeout(timeout);
      if (command?.length && !requestedStop) {
        testChild = typeof command === 'string'
          ? spawn(command, {cwd:process.cwd(), env:launch.env, stdio:'inherit', shell:true, windowsHide:true})
          : spawn(command[0], command.slice(1), {cwd:process.cwd(), env:launch.env, stdio:'inherit'});
        testChild.on('error', error => { startupError = error; commandStatus = 1; stop('SIGTERM'); });
        testChild.on('exit', (code, signal) => {
          commandStatus = code ?? (signal === 'SIGINT' ? 130 : 1);
          // A normal test completion initiates export-first native shutdown.
          requestedStop = true;
          requestNativeStop(child);
        });
      }
    }
  }
  child.stdout.on('data', chunk => output(chunk, process.stdout));
  child.stderr.on('data', chunk => output(chunk, process.stderr));
  try {
    const outcome = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({code, signal}));
    });
    if (testChild && testChild.exitCode === null) {
      testChild.kill('SIGTERM');
      await new Promise(resolveExit => testChild.once('close', resolveExit));
    }
    if (startupError) throw startupError;
    if (requestedStop && outcome.signal && (ready || !['SIGINT', 'SIGTERM'].includes(outcome.signal))) {
      process.stderr.write(`firenook: the engine was ended (${outcome.signal}) before it finished stopping; the next start checks the data first, and repairs it if it needs to\n`);
    }
    if (outcome.code !== 0) return outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 1);
    if (!requestedStop) throw new Error('Emulator exited unexpectedly before requested shutdown');
    return commandStatus ?? 0;
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    for (const build of builds) build.stop();
  }
}
