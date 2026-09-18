import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetPaths } from './assets.mjs';
import { binaryPath, manifest, release } from './binary.mjs';
import { loadProject } from './options.mjs';
import { nativeEnvironment, requestNativeStop } from './processes.mjs';

export async function diagnose(options, cwd = process.cwd()) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(`Node 24 is required for the tested Functions workers; received ${process.versions.node}`);
  const binary = binaryPath();
  const project = loadProject(options, cwd);
  // Functions run on the owned runtime with Node workers; Extensions are
  // resolved natively. Neither firebase-tools nor Java is consulted.
  const files = await assetPaths().catch(error => { throw new Error(`${error.message}. Run fireside setup to provision the pinned public Emulator UI asset.`); });
  const extensions = extensionsStatus(binary, project);
  return {binary, files, project, extensions, version:manifest.version, engineRevision:release.engineRevision};
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

export function prepareLaunch(diagnostic, options) {
  const p = diagnostic.project;
  const parent = join(p.directory, '.fireside', 'runs');
  mkdirSync(parent, {recursive:true});
  const run = mkdtempSync(join(parent, 'session-'));
  const state = p.state || join(run, 'state');
  const rc = existsSync(p.rc) ? p.rc : join(run, '.firebaserc');
  if (!existsSync(rc)) writeFileSync(rc, '{}\n', {flag:'wx', mode:0o600});
  const credentials = join(run, 'demo-adc.json');
  writeFileSync(credentials, JSON.stringify({type:'authorized_user', client_id:'demo', client_secret:'demo', refresh_token:'demo'}), {flag:'wx', mode:0o600});
  const args = ['suite', '--project-dir', p.directory, '--config', p.config, '--firebase-rc', rc,
    '--project-id', p.project, '--host', p.host,
    // The native suite requires a positive minimum; a configured Functions
    // source has at least one handler, so the default is one.
    '--node', process.execPath, '--ui-archive', diagnostic.files.ui, '--state-dir', state, '--minimum-functions', options['minimum-functions'] || '1'];
  if (options['inspect-functions'] !== undefined) args.push(options['inspect-functions'] === true ? '--inspect-functions' : `--inspect-functions=${options['inspect-functions']}`);
  if (options.offline) args.push('--offline');
  for (const [name, port] of Object.entries(p.ports)) args.push(`--${name}-port`, String(port));
  for (const bucket of options['storage-bucket']) args.push('--storage-bucket', bucket);
  if (p.imported) args.push('--import', p.imported);
  if (p.exported) args.push('--export-on-exit', p.exported);
  if (options['resume-state']) args.push('--resume-state');
  if (options['no-diagnostics']) args.push('--no-diagnostics');
  if (options.durability) args.push('--durability', options.durability);
  const env = {...process.env, GOOGLE_CLOUD_PROJECT:p.project, GCLOUD_PROJECT:p.project,
    GOOGLE_APPLICATION_CREDENTIALS:credentials, CLOUDSDK_CONFIG:join(run, 'gcloud'),
    FIRESTORE_EMULATOR_HOST:`${p.host}:${p.ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST:`${p.host}:${p.ports.auth}`,
    FIREBASE_STORAGE_EMULATOR_HOST:`${p.host}:${p.ports.storage}`, STORAGE_EMULATOR_HOST:`http://${p.host}:${p.ports.storage}`,
    FIREBASE_EMULATOR_HUB:`${p.host}:${p.ports.hub}`, PUBSUB_EMULATOR_HOST:`${p.host}:${p.ports.pubsub}`};
  // FIREBASE_TOKEN stays available to the native process for the Extensions
  // registry only; the runtime keeps it (and every credential) out of the
  // Functions workers' environment.
  delete env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  writeFileSync(join(run, 'launch.json'), JSON.stringify({version:manifest.version, engineRevision:release.engineRevision, args, state, exported:p.exported}, null, 2));
  console.error(`Fireside ${manifest.version}; engine ${release.engineRevision}; disk/WAL state ${state}`);
  console.error('Local demo project only. User Functions can still contact external providers; this CLI is not a network sandbox.');
  console.error(`Working data and launch receipt are preserved in ${run}. No automatic deletion.`);
  return {binary:diagnostic.binary, args, env:nativeEnvironment(env), cwd:p.directory};
}

// Signal only children owned by this invocation. Wait through native export;
// never kill by port/name or return success before shutdown completes.
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
        testChild = spawn(command[0], command.slice(1), {cwd:process.cwd(), env:launch.env, stdio:'inherit'});
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
