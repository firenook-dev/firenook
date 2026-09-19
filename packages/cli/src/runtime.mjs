import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetPaths } from './assets.mjs';
import { binaryPath, manifest, release } from './binary.mjs';
import { SERVICES, connectHost, loadProject } from './options.mjs';
import { nativeEnvironment, requestNativeStop } from './processes.mjs';

export async function diagnose(options, cwd = process.cwd()) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(`Node 24 is required for the tested Functions workers; received ${process.versions.node}`);
  // Configuration findings first: they need no installed engine.
  const project = loadProject(options, cwd);
  for (const warning of project.warnings) console.error(warning);
  const binary = binaryPath();
  // Functions run on the owned runtime with Node workers; Extensions are
  // resolved natively. Neither firebase-tools nor Java is consulted.
  const files = await assetPaths().catch(error => { throw new Error(`${error.message}. Run fireside setup to provision the pinned public Emulator UI asset.`); });
  const extensions = extensionsStatus(binary, project);
  return {binary, files, project, extensions, services:project.services, demo:project.demo, ui:project.ui,
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

// Calls a function on the running suite through its HTTPS route: a callable
// body when --data is given, a plain request otherwise. Prints status and body.
export async function invokeFunction(name, options, cwd = process.cwd()) {
  const project = loadProject(options, cwd);
  const region = options.region || 'us-central1';
  const url = `http://${project.host}:${project.ports.functions}/${project.project}/${region}/${name}`;
  const method = (options.method || 'POST').toUpperCase();
  const headers = {};
  let body;
  if (options.data !== undefined) {
    let parsed;
    try { parsed = JSON.parse(options.data); } catch { throw new Error('--data must be JSON'); }
    headers['content-type'] = 'application/json';
    body = JSON.stringify({data: parsed});
  }
  let response;
  try { response = await fetch(url, {method, headers, body}); }
  catch (error) { throw new Error(`no Functions emulator answered at ${url} (${error.cause?.code || error.message}); start it with fireside emulators:start`); }
  const text = await response.text();
  console.log(`${response.status} ${response.statusText} ${url}`);
  if (text) console.log(text);
  return response.ok ? 0 : 1;
}

// Copies registry extensions into <project>/extensions/.sources with their
// registry metadata; later starts need no network and no token.
export function vendorExtensions(binary, project, instances = []) {
  const args = ['extensions', 'vendor', '--config', project.config, '--project-id', project.project, '--node', process.execPath];
  for (const instance of instances) args.push('--instance', instance);
  const result = spawnSync(binary, args, {cwd:project.directory, env:nativeEnvironment(), stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Builds the native suite invocation. `mode` is 'start' or 'exec': like the
// official CLI, exec keeps the Emulator UI off unless --ui is given or
// firebase.json enables it explicitly.
export function prepareLaunch(diagnostic, options, mode = 'start') {
  const p = diagnostic.project;
  const parent = join(p.directory, '.fireside', 'runs');
  mkdirSync(parent, {recursive:true});
  const run = mkdtempSync(join(parent, 'session-'));
  const state = p.state || join(run, 'state');
  const rc = existsSync(p.rc) ? p.rc : join(run, '.firebaserc');
  if (!existsSync(rc)) writeFileSync(rc, '{}\n', {flag:'wx', mode:0o600});
  const credentials = join(run, 'demo-adc.json');
  writeFileSync(credentials, JSON.stringify({type:'authorized_user', client_id:'demo', client_secret:'demo', refresh_token:'demo'}), {flag:'wx', mode:0o600});
  // The engine reads emulators.ui.enabled itself, so --ui cannot re-enable a
  // UI the configuration disables; it only keeps it on for exec.
  const ui = p.ui && (mode !== 'exec' || Boolean(options.ui) || p.uiExplicit);
  if (options.ui && !p.ui) console.error('note: --ui cannot enable the Emulator UI while firebase.json sets emulators.ui.enabled to false');
  const debug = Boolean(options.debug) || options['log-verbosity'] === 'DEBUG';
  const debugLog = debug ? join(run, 'fireside-debug.log') : undefined;
  const args = ['suite', '--project-dir', p.directory, '--config', p.config, '--firebase-rc', rc,
    '--project-id', p.project, '--host', p.host,
    '--node', process.execPath, '--ui-archive', diagnostic.files.ui, '--state-dir', state, '--minimum-functions', String(p.minimumFunctions)];
  // Absent --only means every service; the engine binds only the selected ones.
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
  if (options['resume-state']) args.push('--resume-state');
  if (options['no-diagnostics']) args.push('--no-diagnostics');
  if (options.durability) args.push('--durability', options.durability);
  const host = connectHost(p.host);
  const env = {...process.env, GOOGLE_CLOUD_PROJECT:p.project, GCLOUD_PROJECT:p.project,
    GOOGLE_APPLICATION_CREDENTIALS:credentials, CLOUDSDK_CONFIG:join(run, 'gcloud'),
    FIRESTORE_EMULATOR_HOST:`${host}:${p.ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST:`${host}:${p.ports.auth}`,
    FIREBASE_STORAGE_EMULATOR_HOST:`${host}:${p.ports.storage}`, STORAGE_EMULATOR_HOST:`http://${host}:${p.ports.storage}`,
    FIREBASE_EMULATOR_HUB:`${host}:${p.ports.hub}`, PUBSUB_EMULATOR_HOST:`${host}:${p.ports.pubsub}`};
  // FIREBASE_TOKEN stays available to the native process for the Extensions
  // registry only; the runtime keeps it (and every credential) out of the
  // Functions workers' environment.
  delete env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  writeFileSync(join(run, 'launch.json'), JSON.stringify({version:manifest.version, engineRevision:release.engineRevision, args, state, exported:p.exported,
    services:p.services, ui, singleProjectMode:p.singleProjectMode, project:{id:p.project, demo:p.demo}, debugLog}, null, 2));
  console.error(`Fireside ${manifest.version}; engine ${release.engineRevision}; disk/WAL state ${state}`);
  console.error(`Services: ${p.services.join(', ')}; Emulator UI ${ui ? 'on' : 'off'}; host ${p.host}`);
  if (p.demo) console.error(`Demo project ${p.project}: no cloud service is contacted, but user Functions can still reach external providers; this CLI is not a network sandbox.`);
  else console.error(`Fireside: real project id ${p.project}; every Functions worker is started with the emulator hosts and without Google credentials, but this CLI is not a network sandbox.`);
  if (debugLog) console.error(`Debug log: ${debugLog}`);
  if (options['log-verbosity'] && options['log-verbosity'] !== 'DEBUG') console.error(`note: --log-verbosity ${options['log-verbosity']} is accepted for compatibility; Fireside prints its full log`);
  console.error(`Working data and launch receipt are preserved in ${run}. No automatic deletion.`);
  return {binary:diagnostic.binary, args, env:nativeEnvironment(env), cwd:p.directory, run, ui, services:p.services, debugLog};
}

// Signal only children owned by this invocation. Wait through native export;
// never kill by port/name or return success before shutdown completes.
// `command` is an argv array (spawned directly) or a script string (run
// through the platform shell, as the official emulators:exec does).
export async function supervise(launch, command) {
  const child = spawn(launch.binary, launch.args, {cwd:launch.cwd, env:launch.env,
    detached:process.platform === 'win32', windowsHide:true,
    stdio:[process.platform === 'win32' ? 'pipe' : 'inherit','pipe','pipe']});
  child.stdin?.on('error', error => { startupError = error; });
  let testChild;
  let ready = false;
  let requestedStop = false;
  let commandStatus;
  let tail = '';
  let startupError;
  const stop = signal => {
    requestedStop = true;
    if (testChild && testChild.exitCode === null) testChild.kill(signal);
    if (child.exitCode === null) requestNativeStop(child, signal);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timeout = setTimeout(() => {
    startupError = new Error('Emulator readiness exceeded 20 minutes; requesting graceful shutdown and preserving state.');
    stop('SIGTERM');
  }, 20 * 60 * 1000);
  function output(chunk, destination) {
    destination.write(chunk);
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
    if (outcome.code !== 0) return outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 1);
    if (!requestedStop) throw new Error('Emulator exited unexpectedly before requested shutdown');
    return commandStatus ?? 0;
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}
