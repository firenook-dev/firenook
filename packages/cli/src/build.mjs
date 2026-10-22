// --build: each Functions codebase's own build, run by Firenook beside the
// emulators, so a TypeScript codebase is compiled before it loads and again
// on every save, and the engine loads what the compiler wrote. A start runs
// the codebase's `build:watch` script (its `build` when it has none), exec
// its `build`, once, before the tests. The build is the project's own, as
// `predeploy` runs it for a deploy: Firenook compiles nothing itself.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { packageManager, runCommand } from './setup.mjs';

// The codebases a firebase.json declares, with the script each would run.
// A codebase with neither script, or with no package.json (a Python
// codebase), has nothing to build and says so.
export function buildPlan(project, mode = 'start') {
  const data = project.data?.functions;
  const entries = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  return entries.filter(entry => entry && typeof entry === 'object').map(entry => {
    const directory = resolve(project.directory, typeof entry.source === 'string' && entry.source ? entry.source : 'functions');
    const codebase = typeof entry.codebase === 'string' && entry.codebase ? entry.codebase : 'default';
    const shown = relative(project.directory, directory).split('\\').join('/') || '.';
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}; } catch { return {codebase, directory, shown, script: undefined}; }
    const script = mode === 'start' && typeof scripts['build:watch'] === 'string' ? 'build:watch' : typeof scripts.build === 'string' ? 'build' : undefined;
    return {codebase, directory, shown, script, watch: script === 'build:watch', manager: script ? packageManager(directory).name : undefined};
  });
}

// One line of a build's output, as the screen shows it. TypeScript's own
// lines are known: a compile starting, an error with where it is, and the
// count that ends a compile in watch mode. Anything else is shown as it is.
export function buildLine(text) {
  const line = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1bc/g, '').trimEnd();
  // npm's own announcement of the script: `> name@1.0.0 build` until npm 11,
  // `npm notice run build` from npm 12.
  if (!line.trim() || /^> /.test(line) || /^npm notice run /.test(line)) return {kind: 'quiet'};
  if (/Starting compilation in watch mode|File change detected\. Starting incremental compilation/.test(line)) return {kind: 'compiling'};
  const found = /Found (\d+) errors?\b.*Watching for file changes/.exec(line);
  if (found) return {kind: 'compiled', count: Number(found[1])};
  // A one-shot compile's own count; its errors were each said already.
  if (/^Found \d+ errors?\b/.test(line.trim())) return {kind: 'quiet'};
  const error = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
  if (error) return {kind: 'error', file: error[1], line: Number(error[2]), column: Number(error[3]), code: error[4], message: error[5]};
  return {kind: 'text', text: line.trim(), error: /\berror\b/i.test(line)};
}

// Starts one codebase's build. `onEvent` hears `compiling`, `compiled`
// ({errors, count}, where errors are TypeScript's), `text` and `ended`
// ({code}). `first` resolves once the first build is done: a one-shot build
// when it exits, a watch when it says it is watching (TypeScript's count,
// or any line about watching), or when it ends; at the latest after
// `patience` milliseconds, with `slow` set, so a watch that never says so
// still lets the emulators start.
export function startBuild(entry, {env = process.env, platform = process.platform, onEvent = () => {}, spawner, patience = 120_000} = {}) {
  const manager = packageManager(entry.directory, env);
  const argv = manager.name === 'npm' || manager.name === 'bun' ? [manager.name, ['run', entry.script]] : [manager.name, [entry.script]];
  let errors = [];
  let resolveFirst;
  const first = new Promise(done => { resolveFirst = done; });
  let settled = false;
  const settle = value => { if (!settled) { settled = true; resolveFirst(value); } };
  const handle = runCommand(argv, {cwd: entry.directory, env, platform, spawner, onLine: text => {
    const line = buildLine(text);
    if (line.kind === 'quiet') return;
    if (line.kind === 'compiling') { errors = []; onEvent({type: 'compiling'}); return; }
    if (line.kind === 'error') { errors.push(line); return; }
    if (line.kind === 'compiled') {
      const event = {type: 'compiled', errors, count: line.count};
      errors = [];
      onEvent(event);
      settle({errors: event.errors, count: line.count});
      return;
    }
    onEvent({type: 'text', text: line.text, error: line.error});
    if (entry.watch && /\bwatching\b/i.test(line.text)) settle({errors: [], count: 0});
  }});
  const timer = setTimeout(() => settle({errors: [], count: 0, slow: true}), patience);
  timer.unref?.();
  handle.done.then(outcome => {
    clearTimeout(timer);
    onEvent({type: 'ended', code: outcome.code, error: outcome.error, tail: outcome.tail, errors});
    settle({errors, count: errors.length, code: outcome.code, error: outcome.error, tail: outcome.tail, ended: true});
  });
  return {entry, command: [argv[0], ...argv[1]].join(' '), first, done: handle.done, stop: handle.stop};
}

// An error as the screen shows it: where it is, as an editor opens it, and
// what the compiler said.
export const errorPlace = error => `${error.file}:${error.line}:${error.column}`;
