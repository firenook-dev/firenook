#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { binaryPath, manifest, release } from '../src/binary.mjs';
import { setupAssets } from '../src/assets.mjs';
import { parseOptions } from '../src/options.mjs';
import { diagnose, prepareLaunch, supervise, vendorExtensions } from '../src/runtime.mjs';
import { nativeEnvironment, requestNativeStop } from '../src/processes.mjs';
import { exportEmulators, firestoreDelete } from '../src/hub.mjs';
import { invokeFunction } from '../src/invoke.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { targetApply, targetClear, use } from '../src/rc.mjs';
import { adopt, scaffold } from '../src/init.mjs';

const help = `Fireside ${manifest.version} — Firebase-compatible local emulator suite

Project
  fireside init [--force] [--dry-run] [--no-functions]   Scaffold firebase.json, rules, a Functions codebase
  fireside init --adopt [--dry-run]                       Check an existing firebase.json; add what Fireside needs
  fireside use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]   .firebaserc aliases
  fireside target:apply storage NAME BUCKET...            Map a Storage target to buckets in .firebaserc
  fireside target:clear storage NAME
  fireside setup                                          Download the verified Emulator UI asset
  fireside doctor [options]                               Read-only package/runtime/config checks (JSON)

Emulators
  fireside emulators:start [options]
  fireside emulators:exec [options] "npm test"            Script through the shell, as the official CLI
  fireside emulators:exec [options] -- CMD [ARGS...]      Argv command, no shell interpretation
  fireside emulators:export DIR [--force] [--only firestore,auth,storage]
  fireside firestore:delete PATH (-r | --shallow) [-f] [--database ID]
  fireside firestore:delete --all-collections -f [--database ID]
  fireside functions:invoke NAME [--data JSON] [--region us-central1] [--method POST]
  fireside functions:invoke NAME --event-data JSON [--resource PATH] [--params JSON] [--auth JSON]
                                                          Inject a background event (Firestore, Storage,
                                                          Pub/Sub, Auth, schedule, Eventarc, task queue)
  fireside ext:vendor [--instance ID]...                  Copy registry Extensions into the project
  fireside mcp [--project ID] [--only firestore,auth,...] Model Context Protocol server over stdio

Advanced
  fireside binary-path                                    Verified packaged native binary location
  fireside native ARGS...                                 Explicit native CLI (no adapter safeguards)

Common options: -P/--project ID, -c/--config firebase.json, --json (doctor, export, delete, init),
  --debug (engine log in .fireside/runs/session-*/fireside-debug.log), --log-verbosity LEVEL,
  --non-interactive (accepted; Fireside never prompts, destructive commands need --force).
Start/exec: --only auth,functions,firestore,storage,pubsub (extensions=functions; eventarc/tasks/hub/ui/
  logging follow their parent), --import DIR, --export-on-exit[=DIR], --state-dir DIR, --resume-state,
  --storage-bucket target=bucket (repeatable), --host HOST, --ui, --minimum-functions N,
  --inspect-functions[=PORT], --offline, --durability write-behind|per-commit, --no-diagnostics,
  --firestore-websocket-port N, --hub-port N, --logging-port N, --eventarc-port N, --tasks-port N.

firebase.json service subsets, storage {rules} or targets, several Firestore databases, ui.enabled and
singleProjectMode are honoured; database/hosting/dataconnect/apphosting entries are skipped with a
warning. Any lowercase project id is accepted; demo-* ids never reach cloud services. Functions run on
the owned runtime with Node 24 workers; Storage rules are evaluated natively. Not provided:
functions:shell (Fireside never starts a second Functions runtime; use functions:invoke), and every
deploy/login command (never intercepted). Disk/WAL state by default; runs are kept, never deleted.
`;

const common = ['project', 'config', 'help', 'non-interactive', 'json', 'debug', 'log-verbosity'];
const launch = [...common, 'import', 'export-on-exit', 'only', 'state-dir', 'resume-state', 'host', 'minimum-functions', 'storage-bucket', 'inspect-functions', 'offline', 'firestore-websocket-port', 'logging-port', 'eventarc-port', 'tasks-port', 'hub-port', 'durability', 'no-diagnostics', 'ui'];
const accepted = {
  doctor:[...launch, 'instance'], 'emulators:start':launch, 'emulators:exec':launch, 'ext:vendor':[...common, 'instance', 'offline'],
  'emulators:export':[...common, 'force', 'only', 'hub-port'],
  'firestore:delete':[...common, 'recursive', 'shallow', 'all-collections', 'database', 'force', 'hub-port'],
  use:[...common, 'add', 'alias', 'unalias', 'clear'],
  'target:apply':common, 'target:clear':common,
  init:[...common, 'adopt', 'dry-run', 'force', 'functions', 'no-functions'],
  'functions:invoke':[...common, 'data', 'event-data', 'params', 'auth', 'resource', 'event-type', 'region', 'method', 'hub-port'],
  mcp:[...common, 'only', 'hub-port'],
};
function checkOptions(action, options) {
  for (const [name, value] of Object.entries(options)) {
    if (Array.isArray(value) ? !value.length : value === undefined) continue;
    if (!accepted[action].includes(name)) throw new Error(`--${name} is not an option of fireside ${action}; see --help`);
  }
}
function noPositionals(action, positionals) {
  if (positionals.length) throw new Error(`Unexpected argument ${positionals[0]}; fireside ${action} takes options only${action === 'emulators:start' ? ' (test commands belong to emulators:exec)' : ''}.`);
}

// emulators:exec accepts either an argv command after -- or one script string.
function execCommand(action, {command, positionals, flags}) {
  if (command !== undefined) {
    noPositionals(action, positionals);
    if (!command.length) throw new Error('emulators:exec requires a command after --');
    return command;
  }
  if (positionals.length === 1) {
    console.error('Fireside: running the script through the shell as the official CLI does; use -- for an argv command without shell interpretation');
    return positionals[0];
  }
  if (positionals.length > 1) throw new Error(`emulators:exec received ${positionals.length} arguments without --; run: fireside emulators:exec ${[...flags, '--', ...positionals].join(' ')}`);
  throw new Error('emulators:exec requires a script (one quoted string) or an argv command after --');
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h', 'help'].includes(action)) { console.log(help); return 0; }
  if (['--version', '-v'].includes(action)) { console.log(`${manifest.version} (engine source ${release.engineRevision})`); return 0; }
  if (action === 'binary-path') { if (args.length) throw new Error('binary-path takes no arguments'); console.log(binaryPath()); return 0; }
  if (action === 'setup') { if (args.length) throw new Error('setup takes no arguments'); binaryPath(); await setupAssets(); return 0; }
  if (action === 'native') {
    if (!args.length) throw new Error('native requires a native command');
    const child = spawn(binaryPath(), args, {env:nativeEnvironment(),detached:process.platform === 'win32',windowsHide:true,stdio:[process.platform === 'win32' ? 'pipe' : 'inherit','inherit','inherit']});
    child.stdin?.on('error', error => console.error(`Native control: ${error.message}`));
    const onInt = () => requestNativeStop(child, 'SIGINT');
    const onTerm = () => requestNativeStop(child, 'SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    try { return await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); }); }
    finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  }
  if (action === 'functions:invoke') {
    const [name, ...rest] = args;
    if (!name || name.startsWith('-')) throw new Error('functions:invoke requires a function name');
    const {options, command, positionals} = parseOptions(rest);
    if (command !== undefined) throw new Error('functions:invoke takes no command after --');
    noPositionals(action, positionals);
    checkOptions(action, options);
    return invokeFunction(name, options);
  }
  if (!Object.hasOwn(accepted, action)) throw new Error(`Unsupported command ${action}; use --help. Firebase deploy/login commands are never intercepted.`);
  const parsed = parseOptions(args);
  const {options, command, positionals} = parsed;
  if (options.help) { console.log(help); return 0; }
  checkOptions(action, options);
  if (action !== 'emulators:exec' && command !== undefined) throw new Error('Only emulators:exec accepts a command after --');
  if (action === 'emulators:export') { if (positionals.length !== 1) throw new Error('emulators:export takes exactly one destination directory'); return exportEmulators(positionals[0], options); }
  if (action === 'firestore:delete') { if (positionals.length > 1) throw new Error('firestore:delete takes at most one path'); return firestoreDelete(positionals[0], options, args); }
  if (action === 'use') { if (positionals.length > 1) throw new Error('use takes at most one alias or project id'); return use(positionals[0], options); }
  if (action === 'target:apply') return targetApply(positionals, options);
  if (action === 'target:clear') return targetClear(positionals, options);
  if (action === 'init') { noPositionals(action, positionals); return options.adopt ? adopt(options) : scaffold(options); }
  if (action === 'mcp') { noPositionals(action, positionals); return serveMcp(options); }
  const testCommand = action === 'emulators:exec' ? execCommand(action, parsed) : noPositionals(action, positionals);
  const diagnostic = await diagnose(options);
  if (action === 'doctor') { console.log(JSON.stringify(diagnostic, null, 2)); return 0; }
  if (action === 'ext:vendor') return vendorExtensions(diagnostic.binary, diagnostic.project, options.instance);
  return supervise(prepareLaunch(diagnostic, options, action === 'emulators:exec' ? 'exec' : 'start'), testCommand);
}
try { process.exitCode = await main(); }
catch (error) { console.error(`Fireside: ${error.message}`); process.exitCode = 1; }
