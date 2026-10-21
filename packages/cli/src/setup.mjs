// What init does after writing the files, when it is asked to set the
// project up (in a terminal, or with --yes): the coding agents' MCP files,
// Firenook pinned in the project's package.json, the packages installed and
// a TypeScript codebase's first build. Each is a step the caller draws as it
// goes; nothing here prints.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { applyAgents, planAgents, shown } from './agents.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[c78]/g;

const MANAGERS = {
  npm: {install: ['npm', ['install']], run: script => `npm run ${script}`},
  pnpm: {install: ['pnpm', ['install']], run: script => `pnpm ${script}`},
  yarn: {install: ['yarn', ['install']], run: script => `yarn ${script}`},
  bun: {install: ['bun', ['install']], run: script => `bun run ${script}`},
};
// The package manager a folder uses: its lockfile, else the one that ran
// this command (npx, pnpm dlx, yarn dlx and bunx each say so), else npm.
export function packageManager(directory, env = process.env) {
  const has = name => existsSync(join(directory, name));
  const locked = has('bun.lock') || has('bun.lockb') ? 'bun' : has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('package-lock.json') ? 'npm' : undefined;
  const name = locked ?? /^(npm|pnpm|yarn|bun)\//.exec(env.npm_config_user_agent ?? '')?.[1] ?? 'npm';
  return {name, ...MANAGERS[name]};
}

// The package.json of a folder above this one (below the home folder), whose
// package Firenook would better be added to than a new one beside it.
export function enclosingPackage(directory, home = homedir()) {
  for (let folder = dirname(directory); folder !== dirname(folder); folder = dirname(folder)) {
    if (folder === home) return undefined;
    if (existsSync(join(folder, 'package.json'))) return join(folder, 'package.json');
  }
  return undefined;
}

// npm's rules for a package name, from a folder's name.
export const packageName = folder => folder.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[._-]+|-+$/g, '') || 'firebase-project';

// The script every start runs, and what pinning writes into package.json:
// Firenook as an exact devDependency and that script as `emulators`. A
// script or a pin already there is kept.
export const startScript = ({build = false} = {}) => `firenook emulators:start --keep-data${build ? ' --build' : ''}`;
export function pinPlan(directory, {version, build = false}) {
  const path = join(directory, 'package.json');
  const exists = existsSync(path);
  let original = '';
  let data;
  if (exists) {
    original = readFileSync(path, 'utf8');
    try { data = JSON.parse(original); } catch (error) { throw new Error(`${path} is not valid JSON: ${error.message}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path} must contain a JSON object`);
  } else data = {name: packageName(basename(directory)), private: true};
  const command = startScript({build});
  const kept = [];
  const scripts = {...(data.scripts ?? {})};
  if (scripts.emulators === undefined) scripts.emulators = command;
  else if (scripts.emulators !== command) kept.push('your emulators script');
  const devDependencies = {...(data.devDependencies ?? {})};
  const pinned = devDependencies.firenook ?? data.dependencies?.firenook;
  if (pinned === undefined) devDependencies.firenook = version;
  else if (pinned !== version) kept.push(`firenook ${pinned}`);
  const content = json({...data, scripts, devDependencies});
  return {path, exists, content, changed: content !== original, pinned: pinned ?? version, kept};
}

// npm, npx and their kin hand their own settings to what they run as
// npm_* variables; an install they start should read the project's, as it
// would in a fresh terminal.
export function childEnvironment(env = process.env) {
  const copy = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_/.test(key)));
  return {...copy, npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false'};
}

// Stops a command and whatever it started (npm runs the script in a shell,
// the shell runs the compiler).
export function stopTree(child, platform = process.platform) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}).on('error', () => {}); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
}

// Runs a command in its own process group, line by line; `done` resolves
// with its exit and the last lines it printed.
export function runCommand([command, args], {cwd, env = process.env, platform = process.platform, onLine, spawner = spawn} = {}) {
  const tail = [];
  let child;
  try {
    child = spawner(command, args, {cwd, env: childEnvironment(env), shell: platform === 'win32', windowsHide: true,
      detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    return {child: undefined, stop: () => {}, done: Promise.resolve({code: null, error, tail})};
  }
  const reader = () => {
    let buffered = '';
    return chunk => {
      buffered += chunk.toString();
      let at;
      while ((at = buffered.search(/[\r\n]/)) !== -1) {
        const line = buffered.slice(0, at).replace(ANSI, '').trimEnd();
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line);
      }
    };
  };
  child.stdout?.on('data', reader());
  child.stderr?.on('data', reader());
  const done = new Promise(resolve => {
    child.once('error', error => resolve({code: null, error, tail}));
    child.once('close', (code, signal) => resolve({code, signal, tail}));
  });
  return {child, stop: () => stopTree(child, platform), done};
}

// A command as it is typed.
const said = ([command, args]) => [command, ...args].join(' ');

// The set-up steps for these choices, each {id, label, state, detail}:
// waiting, running, done, failed or skipped. `run` starts them, calling
// `onStep` after every change, and resolves once all have ended; `stop`
// ends the commands still running.
export function setUpSteps(choices, directory, {version, config, env = process.env, platform = process.platform, spawner = spawn} = {}) {
  const functions = choices.language !== 'none';
  const typescript = choices.language === 'typescript';
  const functionsDir = join(directory, 'functions');
  const manager = packageManager(directory, env);
  // Functions are installed with npm, as the official init does: the
  // codebase is deployed on its own, from its own package-lock.json.
  const npm = {name: 'npm', ...MANAGERS.npm};
  const steps = [];
  const step = (id, label, detail) => { const item = {id, label, state: 'waiting', detail}; steps.push(item); return item; };
  const agents = choices.agents.length ? step('agents', 'Agents', '') : undefined;
  const pin = choices.pin ? step('firenook', 'Firenook', choices.install ? `${said(manager.install)} here` : 'package.json') : undefined;
  const packages = choices.install && functions ? step('packages', 'Packages', 'npm install in functions/') : undefined;
  const build = choices.install && typescript ? step('build', 'Build', 'npm run build') : undefined;
  const running = new Set();
  let stopped = false;

  async function run(onStep = () => {}) {
    const update = (item, fields) => { Object.assign(item, fields); onStep(item, steps); };
    const command = (item, argv, cwd, detail) => {
      if (stopped) { update(item, {state: 'skipped', detail: 'stopped'}); return Promise.resolve({code: null}); }
      const began = Date.now();
      let added;
      update(item, {state: 'running', began, detail});
      const handle = runCommand(argv, {cwd, env, platform, spawner, onLine: line => { added = /\badded (\d+) packages?\b/.exec(line)?.[1] ?? added; }});
      running.add(handle);
      return handle.done.then(outcome => {
        running.delete(handle);
        const ms = Date.now() - began;
        if (outcome.code === 0) return {...outcome, ms, added};
        const why = stopped ? 'stopped' : outcome.error ? (outcome.error.code === 'ENOENT' ? `${argv[0]} is not installed` : outcome.error.message) : `${said(argv)} failed${outcome.code === null ? '' : ` (exit code ${outcome.code})`}`;
        update(item, {state: stopped ? 'skipped' : 'failed', ms, detail: why, tail: outcome.tail.slice(-12), cwd});
        return {...outcome, ms, failed: true};
      });
    };
    onStep(undefined, steps);
    if (agents) {
      const began = Date.now();
      const plan = planAgents(directory, {agents: choices.agents, config, env});
      applyAgents(plan);
      const files = plan.filter(item => item.content || item.action === 'keep').map(item => `${shown(directory, item.path)} for ${item.name}${item.action === 'keep' ? ' (already set)' : ''}`);
      const skipped = plan.filter(item => !item.content && item.action !== 'keep');
      update(agents, {state: skipped.length && !files.length ? 'failed' : 'done', ms: Date.now() - began,
        detail: files.join(', '), notes: skipped.map(item => (item.action === 'differs' ? `${shown(directory, item.path)} has another firenook entry; firenook mcp add --force replaces it` : `${shown(directory, item.path)} is not plain JSON; add the server by hand`))});
    }
    let pinned;
    if (pin) {
      const began = Date.now();
      try {
        const plan = pinPlan(directory, {version, build: typescript});
        if (plan.changed) writeFileSync(plan.path, plan.content);
        pinned = plan;
        pin.written = true;
        if (!choices.install) update(pin, {state: 'done', ms: Date.now() - began, detail: `${plan.pinned} in package.json`, notes: plan.kept.map(item => `kept ${item}`)});
      } catch (error) {
        update(pin, {state: 'failed', ms: Date.now() - began, detail: error.message});
      }
    }
    const work = [];
    if (pin && pinned && choices.install) {
      work.push(command(pin, manager.install, directory, `${said(manager.install)} here`).then(outcome => {
        if (!outcome.failed && pin.state !== 'skipped') update(pin, {state: 'done', installed: true, ms: outcome.ms, detail: `${pinned.pinned} in package.json`, notes: pinned.kept.map(item => `kept ${item}`)});
      }));
    }
    if (packages) {
      work.push(command(packages, npm.install, functionsDir, packages.detail).then(async outcome => {
        if (outcome.failed || packages.state === 'skipped') { if (build) update(build, {state: 'skipped', detail: stopped ? 'stopped' : 'not run, as the packages did not install'}); return; }
        update(packages, {state: 'done', ms: outcome.ms, detail: `${packages.detail}${outcome.added ? `, ${outcome.added} packages` : ''}`});
        if (!build) return;
        const built = await command(build, ['npm', ['run', 'build']], functionsDir, 'npm run build');
        if (!built.failed && build.state !== 'skipped') update(build, {state: 'done', ms: built.ms, detail: 'tsc, into functions/lib'});
      }));
    }
    await Promise.all(work);
    return {ok: !steps.some(item => item.state === 'failed'), steps};
  }
  return {steps, manager, run, stop: () => { stopped = true; for (const handle of running) handle.stop(); }};
}

// The commands still to type once init is done, each with what it is for.
export function nextSteps(choices, steps, {manager, node = process.versions.node} = {}) {
  const find = id => steps.find(item => item.id === id);
  const typescript = choices.language === 'typescript';
  const lines = [];
  if (Number(node.split('.')[0]) !== 24) lines.push({label: 'Node', command: 'nvm use 24', why: `the emulators need Node 24, and this is ${node} (nvm install 24 if you have no Node 24)`});
  if (choices.language !== 'none' && find('packages')?.state !== 'done') {
    // --prefix rather than cd: one command every shell runs as it is.
    lines.push({label: 'Packages', command: 'npm install --prefix functions', why: 'installs the Functions codebase\'s packages'});
  }
  const pin = find('firenook');
  if (pin?.written && !pin.installed) lines.push({label: 'Firenook', command: said(manager.install), why: 'installs Firenook, as package.json pins it'});
  const why = typescript ? 'starts the emulators and compiles your TypeScript as you save' : 'starts the emulators; your data stays between runs';
  lines.push({label: 'Start', command: pin?.written ? manager.run('emulators') : `npx firenook emulators:start --keep-data${typescript ? ' --build' : ''}`, why});
  return lines;
}
