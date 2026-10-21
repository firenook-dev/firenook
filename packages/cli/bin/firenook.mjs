#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { binaryPath, manifest, release } from '../src/binary.mjs';
import { parseOptions } from '../src/options.mjs';
import { adoptSeed, compactState, diagnose, inspectState, prepareLaunch, supervise, vendorExtensions } from '../src/runtime.mjs';
import { runInteractive, startInTerminal } from '../src/session.mjs';
import { interactive } from '../src/terminal.mjs';
import { nativeEnvironment, requestNativeStop } from '../src/processes.mjs';
import { exportEmulators, firestoreDelete } from '../src/hub.mjs';
import { invokeFunction } from '../src/invoke.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { mcpAdd } from '../src/agents.mjs';
import { targetApply, targetClear, use } from '../src/rc.mjs';
import { adopt, scaffold } from '../src/init.mjs';
import { initInTerminal } from '../src/init-screen.mjs';

const help = `Firenook ${manifest.version} — a faster drop-in replacement for the Firebase Local Emulator Suite

Project
  firenook init [--yes] [--language typescript|javascript|none]   A new project; a screen of choices in a terminal
  firenook init --adopt [--dry-run]                       Check an existing firebase.json; add what Firenook needs
  firenook use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]   .firebaserc aliases
  firenook target:apply storage NAME BUCKET...            Map a Storage target to buckets in .firebaserc
  firenook target:clear storage NAME
  firenook setup                                          Nothing to download; kept for scripts that still run it
  firenook doctor [options]                               Read-only package/runtime/config checks (JSON)

Emulators
  firenook emulators:start [options]
  firenook emulators:exec [options] "npm test"            Script through the shell, as the official CLI
  firenook emulators:exec [options] -- CMD [ARGS...]      Argv command, no shell interpretation
  firenook emulators:export DIR [--force] [--only firestore,auth,storage]
  firenook firestore:delete PATH [-r | --shallow] [-f] [--database ID]
  firenook firestore:delete --all-collections -f [--database ID]
  firenook functions:invoke NAME [--data JSON] [--region us-central1] [--method POST]
  firenook functions:invoke NAME --event-data JSON [--resource PATH] [--params JSON] [--auth JSON]
                                                          Inject a background event (Firestore, Storage,
                                                          Pub/Sub, Auth, schedule, Eventarc, task queue)
  firenook ext:vendor [--instance ID]...                  Copy registry Extensions into the project
  firenook mcp [--project ID] [--only firestore,auth,...] Model Context Protocol server over stdio for coding
                                                          agents; outside a project, the one running suite
  firenook mcp add [--agent claude,cursor,vscode] [--dry-run] [--force]   Give the project's coding agents
                                                          the server (.mcp.json, .cursor/, .vscode/mcp.json)

Saved data (--keep-data, or --state-dir with --resume-state)
  firenook state:adopt-seed --state-dir DIR --import DIR  Keep saved data whose seed changed: record the
                                                          seed as it is now (the old receipt is kept)
  firenook state:inspect --state-dir DIR                  What the stopped Firestore file holds, table by
                                                          table, and how much of it is free
  firenook state:compact --state-dir DIR [--no-copy]      Return the stopped file's free pages to the disk
                                                          (copied first; every document stays as it is)

Advanced
  firenook binary-path                                    Verified packaged native binary location
  firenook native ARGS...                                 Explicit native CLI (no adapter safeguards)

Common options: -P/--project ID, -c/--config firebase.json, --json (doctor, export, delete, init),
  --debug (engine log in .firenook/runs/session-*/firenook-debug.log), --log-verbosity LEVEL,
  --non-interactive (accepted; only init asks, in a terminal; destructive commands need --force).
Start/exec: --only auth,functions,firestore,storage,pubsub (extensions=functions; eventarc/tasks/hub/ui/
  logging follow their parent), --import DIR, --export-on-exit[=DIR], --keep-data (keep the data between
  runs in .firenook/state, with or without --import), --state-dir DIR, --resume-state,
  --storage-bucket target=bucket (repeatable), --host HOST, --allowed-hosts NAME,..., --ui,
  --minimum-functions N, --inspect-functions[=PORT], --offline, --durability write-behind|per-commit,
  --no-diagnostics, --firestore-websocket-port N, --hub-port N, --logging-port N, --eventarc-port N,
  --tasks-port N, --plain (the log a pipe or CI gets), --build (each Functions codebase's build:watch first).

firebase.json service subsets, storage {rules} or targets, several Firestore databases, ui.enabled and
singleProjectMode are honoured; database/hosting/dataconnect/apphosting entries are skipped with a
warning. Any lowercase project id is accepted; demo-* ids never reach cloud services. Functions run on
the owned runtime with Node workers (22, 24, 26); Storage rules are evaluated natively. Not provided:
functions:shell (Firenook never starts a second Functions runtime; use functions:invoke), and every
deploy/login command (never intercepted). Disk/WAL state by default; runs are kept, never deleted.
`;

const common = ['project', 'config', 'help', 'non-interactive', 'json', 'debug', 'log-verbosity'];
const launch = [...common, 'import', 'export-on-exit', 'only', 'state-dir', 'resume-state', 'keep-data', 'host', 'allowed-hosts', 'minimum-functions', 'storage-bucket', 'inspect-functions', 'offline', 'firestore-websocket-port', 'logging-port', 'eventarc-port', 'tasks-port', 'hub-port', 'durability', 'no-diagnostics', 'ui', 'plain', 'build'];
const accepted = {
  doctor:[...launch, 'instance'], 'emulators:start':launch, 'emulators:exec':launch, 'ext:vendor':[...common, 'instance', 'offline'],
  'emulators:export':[...common, 'force', 'only', 'hub-port'],
  'firestore:delete':[...common, 'recursive', 'shallow', 'all-collections', 'database', 'force', 'hub-port'],
  use:[...common, 'add', 'alias', 'unalias', 'clear'],
  'target:apply':common, 'target:clear':common,
  init:[...common, 'adopt', 'dry-run', 'force', 'functions', 'no-functions', 'language', 'only', 'agent', 'yes', 'no-install', 'no-pin'],
  'functions:invoke':[...common, 'data', 'event-data', 'params', 'auth', 'resource', 'event-type', 'region', 'method', 'hub-port'],
  mcp:[...common, 'only', 'hub-port'],
  'mcp add':[...common, 'agent', 'dry-run', 'force'],
  'state:adopt-seed':[...common, 'state-dir', 'import'],
  'state:inspect':[...common, 'state-dir'],
  'state:compact':[...common, 'state-dir', 'no-copy'],
};
function checkOptions(action, options) {
  for (const [name, value] of Object.entries(options)) {
    if (Array.isArray(value) ? !value.length : value === undefined) continue;
    if (!accepted[action].includes(name)) throw new Error(`--${name} is not an option of firenook ${action}; see --help`);
  }
}
function noPositionals(action, positionals) {
  if (positionals.length) throw new Error(`Unexpected argument ${positionals[0]}; firenook ${action} takes options only${action === 'emulators:start' ? ' (test commands belong to emulators:exec)' : ''}.`);
}

// emulators:exec accepts either an argv command after -- or one script string.
function execCommand(action, {command, positionals, flags}) {
  if (command !== undefined) {
    noPositionals(action, positionals);
    if (!command.length) throw new Error('emulators:exec requires a command after --');
    return command;
  }
  if (positionals.length === 1) {
    console.error('Firenook: running the script through the shell as the official CLI does; use -- for an argv command without shell interpretation');
    return positionals[0];
  }
  if (positionals.length > 1) throw new Error(`emulators:exec received ${positionals.length} arguments without --; run: firenook emulators:exec ${[...flags, '--', ...positionals].join(' ')}`);
  throw new Error('emulators:exec requires a script (one quoted string) or an argv command after --');
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h', 'help'].includes(action)) { console.log(help); return 0; }
  if (['--version', '-v'].includes(action)) { console.log(`${manifest.version} (engine source ${release.engineRevision})`); return 0; }
  if (action === 'binary-path') { if (args.length) throw new Error('binary-path takes no arguments'); console.log(binaryPath()); return 0; }
  // Until 0.2.0-next.3 this downloaded Google's Emulator UI. The console is
  // in the binary now, so there is nothing to fetch; scripts that run it pass.
  if (action === 'setup') { if (args.length) throw new Error('setup takes no arguments'); binaryPath(); console.log('Nothing to set up: the console is part of the engine, and Firenook downloads nothing.'); return 0; }
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
  if (action === 'mcp' && args[0] === 'add') return run('mcp add', args.slice(1));
  return run(action, args);
}

async function run(action, args) {
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
  if (action === 'init') {
    noPositionals(action, positionals);
    if (options.adopt) return adopt(options);
    // In a terminal init asks for its choices on a screen of its own, and
    // can start the emulators at the end; otherwise it takes the options.
    const asked = !options.yes && !options['dry-run'] && !options.json && !options['non-interactive'] && interactive({mode:'init'});
    if (asked) return initInTerminal(options, {version:manifest.version, start:(start, typed) => startInTerminal(start, typed, {version:manifest.version})});
    return scaffold(options, process.cwd(), console, {version:manifest.version});
  }
  if (action === 'mcp') { noPositionals(action, positionals); return serveMcp(options); }
  if (action === 'mcp add') { noPositionals(action, positionals); return mcpAdd(options); }
  if (action === 'state:adopt-seed') {
    noPositionals(action, positionals);
    if (!options['state-dir'] || !options.import) throw new Error('state:adopt-seed needs --state-dir (the saved data) and --import (its seed), as given to emulators:start');
    return adoptSeed(binaryPath(), resolve(process.cwd(), options['state-dir']), resolve(process.cwd(), options.import));
  }
  if (action === 'state:inspect' || action === 'state:compact') {
    noPositionals(action, positionals);
    if (!options['state-dir']) throw new Error(`${action} needs --state-dir (the saved data), as given to emulators:start; stop the emulator first`);
    const stateDir = resolve(process.cwd(), options['state-dir']);
    return action === 'state:inspect' ? inspectState(binaryPath(), stateDir) : compactState(binaryPath(), stateDir, {copy:!options['no-copy']});
  }
  const testCommand = action === 'emulators:exec' ? execCommand(action, parsed) : noPositionals(action, positionals);
  // In a terminal, emulators:start draws its own UI; everything else, and
  // any pipe, CI or log file, gets the plain line protocol.
  const drawn = action === 'emulators:start' && interactive({plain:Boolean(options.plain)});
  // doctor reports every check, a refused Node or a missing engine among
  // them, and exits 1 when any check found a problem.
  const diagnostic = await diagnose(options, process.cwd(), {quiet:drawn, report:action === 'doctor'});
  if (action === 'doctor') { console.log(JSON.stringify(diagnostic, null, 2)); return diagnostic.problems.length ? 1 : 0; }
  if (action === 'ext:vendor') return vendorExtensions(diagnostic.binary, diagnostic.project, options.instance);
  if (drawn) {
    const project = diagnostic.project;
    return runInteractive(prepareLaunch(diagnostic, options, 'start', args, {quiet:true}),
      {version:manifest.version, projectId:project.project, demo:project.demo, warnings:project.warnings, cwd:process.cwd()});
  }
  return supervise(prepareLaunch(diagnostic, options, action === 'emulators:exec' ? 'exec' : 'start', args), testCommand);
}
try { process.exitCode = await main(); }
catch (error) { console.error(`Firenook: ${error.message}`); process.exitCode = 1; }
