// The terminal UI's session: runs the engine with `--terminal-events`, turns
// its events into the start-up card, the ready summary, the log and the
// footer, and answers the keys. Only `emulators:start` in a terminal comes
// here; everything else gets the plain line protocol (`supervise`).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  BODY, INSET, ago, capabilities, clock, count, createInk, createLayout, createScreen, pad, spread, took, width, wrap,
} from './terminal.mjs';
import { requestNativeStop } from './processes.mjs';
import { errorPlace, startBuild } from './build.mjs';
import { diagnose, prepareLaunch } from './runtime.mjs';
import { pendingUpdate, refreshUpdates } from './updates.mjs';

export const EVENT_PREFIX = 'FIRENOOK_EVENT ';
const RELEASES = 'https://github.com/firenook-dev/firenook/releases';

const LABELS = {data: 'Saved data', build: 'Build', firestore: 'Firestore', auth: 'Auth', storage: 'Storage', functions: 'Functions', pubsub: 'Pub/Sub'};
const ROWS = ['data', 'build', 'firestore', 'auth', 'storage', 'functions', 'pubsub'];
// What a running row counts, when it says how far it has got.
const UNITS = {firestore: 'documents', auth: 'users', storage: 'objects', functions: 'codebases'};
const PORTS = [['firestore', 'Firestore'], ['auth', 'Auth'], ['storage', 'Storage'], ['functions', 'Functions'], ['pubsub', 'Pub/Sub'], ['hub', 'Hub']];
// The service a listener belongs to, for its row and its firebase.json key.
const LISTENERS = {
  firestore: {row: 'firestore', label: 'Firestore', key: '"firestore": { "port": PORT }'},
  'firestore.websocket': {row: 'firestore', label: 'the Firestore websocket', key: '"firestore": { "websocketPort": PORT }'},
  auth: {row: 'auth', label: 'Auth', key: '"auth": { "port": PORT }'},
  storage: {row: 'storage', label: 'Storage', key: '"storage": { "port": PORT }'},
  functions: {row: 'functions', label: 'Functions', key: '"functions": { "port": PORT }'},
  eventarc: {row: 'functions', label: 'Eventarc', key: '"eventarc": { "port": PORT }'},
  tasks: {row: 'functions', label: 'Cloud Tasks', key: '"tasks": { "port": PORT }'},
  pubsub: {row: 'pubsub', label: 'Pub/Sub', key: '"pubsub": { "port": PORT }'},
  hub: {label: 'the hub', key: '"hub": { "port": PORT }'},
  ui: {label: 'the console', key: '"ui": { "port": PORT }'},
  logging: {label: 'the console log', key: '"logging": { "port": PORT }'},
};
// A function's level from its logger's severity.
const SEVERITY = {DEBUG: 'debug', INFO: 'info', NOTICE: 'info', WARNING: 'warn', WARN: 'warn', ERROR: 'error', CRITICAL: 'error', ALERT: 'error', EMERGENCY: 'error'};
// A call shows once it ends; one still running after this long shows its
// lines as they come.
const HOLD = 2000;
// A start that says nothing for this long is stopped (keeping the data); one
// that keeps reporting, such as a long repair, is not.
const QUIET_LIMIT = 20 * 60 * 1000;

// A path as the developer would type it: under the project, relative to it;
// under the home directory, with ~.
export function shortPath(path, cwd = process.cwd()) {
  if (!path) return '';
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const inside = relative(cwd, absolute);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside;
  if (!inside) return '.';
  const home = homedir();
  const fromHome = relative(home, absolute);
  if (fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)) return join('~', fromHome);
  return absolute;
}

// A function's name as its developer wrote it: no region, and an
// extension's instance prefix moved out to its codebase.
export function functionName(id = '', codebase = '') {
  let name = String(id).replace(/^[a-z]+-[a-z]+\d+-/, '');
  if (codebase && name.startsWith(`ext-${codebase}-`)) name = name.slice(`ext-${codebase}-`.length);
  return name;
}

// A line a function's logger wrote as JSON: its level, message and fields.
export function structured(message, level = 'info') {
  const text = String(message ?? '');
  if (!text.startsWith('{')) return {level, text};
  try {
    const entry = JSON.parse(text);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {level, text};
    const {severity, message: said, ...rest} = entry;
    const fields = Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith('logging.googleapis.com/')));
    return {
      level: SEVERITY[String(severity ?? '').toUpperCase()] ?? level,
      text: typeof said === 'string' ? said : said === undefined ? '' : JSON.stringify(said),
      fields: Object.keys(fields).length ? fields : undefined,
    };
  } catch { return {level, text}; }
}

// A codebase as its developer named it: firebase.json's unnamed codebases
// are `default-0`, `default-1` … inside the engine.
export const codebaseName = id => (id === 'default-0' ? 'default' : String(id ?? ''));

// A load error as Node reports it: where it is (`file:line`), the code
// frame under it, and the error itself (`SyntaxError: …`), which says more
// than the runtime's own first line.
export function loadError(error) {
  const first = String(error?.message ?? '').trim();
  const lines = String(error?.detail ?? '').replace(/\r/g, '').split('\n');
  const at = lines.findIndex(line => /^\S+:\d+(?::\d+)?$/.test(line.trim()));
  const named = lines.findIndex((line, i) => i > at && /^[A-Z][A-Za-z]*(Error|Exception)\b[^:]*:/.test(line.trim()));
  const frame = [];
  for (const line of lines.slice(at + 1, named === -1 ? undefined : named)) {
    if (/^\s+at /.test(line)) break;
    if (line.trim() === first) continue;
    frame.push(line.replace(/\s+$/, ''));
  }
  while (frame.length && !frame[0].trim()) frame.shift();
  while (frame.length && !frame.at(-1).trim()) frame.pop();
  return {message: named === -1 ? first : lines[named].trim(), where: at === -1 ? undefined : lines[at].trim().replace(/^\.\//, ''), frame: frame.slice(0, 8)};
}

// How the data starts, as the wrapper can tell before the engine says:
// saved state with a complete receipt is picked up, a seed is imported,
// otherwise it is a fresh start.
export function expectedOpening(args) {
  const value = flag => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
  const state = value('--state-dir');
  const seed = value('--import');
  if (args.includes('--resume-state') && state) {
    try {
      const receipt = JSON.parse(readFileSync(join(state, 'native-state.json'), 'utf8'));
      if (receipt?.complete) {
        const files = ['firestore/firenook.redb', 'firestore/firenook.wal', 'auth-state.json', 'storage/metadata.redb'];
        const savedAtMs = Math.max(0, ...files.map(file => { try { return statSync(join(state, file)).mtimeMs; } catch { return 0; } }));
        return {kind: 'resume', seed, savedAtMs: savedAtMs || undefined};
      }
    } catch { /* not saved state: an import or a fresh start */ }
  }
  if (seed) return {kind: 'import', seed};
  return {kind: 'fresh'};
}

// The program listening on a port, from the system's socket table: `lsof`
// (macOS, most Linux), `ss` (Linux), `netstat` and `tasklist` (Windows).
export function portHolder(port, platform = process.platform) {
  const run = (command, args) => {
    try {
      const result = spawnSync(command, args, {encoding: 'utf8', timeout: 2000, windowsHide: true});
      return result.status === 0 ? result.stdout : '';
    } catch { return ''; }
  };
  let pid;
  if (platform === 'win32') {
    const line = run('netstat', ['-ano', '-p', 'TCP']).split(/\r?\n/).find(row => new RegExp(`:${port}\\s.*LISTENING`).test(row));
    pid = line?.trim().split(/\s+/).at(-1);
    if (!pid) return undefined;
    const name = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).split(',')[0]?.replace(/"/g, '').trim();
    return {pid: Number(pid), program: name || undefined, command: name || ''};
  }
  pid = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0]?.trim();
  if (!pid) pid = run('ss', ['-ltnpH', `sport = :${port}`]).match(/pid=(\d+)/)?.[1];
  if (!pid) return undefined;
  const command = run('ps', ['-o', 'command=', '-p', pid]).trim();
  const program = run('ps', ['-o', 'comm=', '-p', pid]).trim().split('/').at(-1);
  return {pid: Number(pid), program: program || undefined, command};
}

// Who a port's holder is, when its command line says.
export function holderName(command = '') {
  if (/cloud-firestore-emulator|firebase-database-emulator|pubsub-emulator|cloud-storage-rules-runtime/.test(command)) return 'an official Firebase emulator';
  if (/firebase-tools|firebase(\.js)? emulators/.test(command)) return "the Firebase CLI's emulators";
  if (/firenook/.test(command)) return 'another Firenook';
  return undefined;
}

// The first port from `port + 1` that nothing listens on at `host` and the
// launch gives no other service.
async function freePort(host, port, taken = new Set()) {
  for (let next = port + 1; next < port + 50 && next < 65536; next += 1) {
    if (taken.has(next)) continue;
    const free = await new Promise(done => {
      const server = createServer();
      server.once('error', () => done(false));
      server.listen(next, host, () => server.close(() => done(true)));
    });
    if (free) return next;
  }
  return port + 1;
}

export function opener(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  return ['xdg-open', [url]];
}

// ── The session ──────────────────────────────────────────────────────────

export async function runInteractive(launch, {version, projectId, demo, cwd = process.cwd(), warnings = [], out = process.stdout, input = process.stdin,
  env = process.env, platform = process.platform, spawner = spawn, holder = portHolder} = {}) {
  const caps = capabilities({env, platform});
  const ink = createInk(caps);
  const size = {columns: () => Math.max(48, out.columns || 80), rows: () => Math.max(10, out.rows || 24)};
  const t = createLayout(ink, size);
  const screen = createScreen(out, ink, size);
  const {G, bold, dim, green, yellow, red, blue, magenta, DOT, link, spinner} = ink;
  const {cells, open, timed, inside, section, divider, rule, flow, field, space, top, bottom, air} = t;
  const tally = figures => figures.map(([figure, words]) => `${count(figure)} ${dim(words)}`).join(DOT);
  const value = flag => { const at = launch.args.indexOf(flag); return at === -1 ? undefined : launch.args[at + 1]; };
  const stateDir = value('--state-dir');
  // A start without --state-dir keeps its data in its own run directory,
  // which no later start reads.
  const ephemeral = !stateDir || /[\\/]\.firenook[\\/]runs[\\/]session-[^\\/]+[\\/]state$/.test(stateDir);
  const exportDir = value('--export-on-exit');
  const host = value('--host') || '127.0.0.1';
  const update = pendingUpdate(version, cwd, {env, platform});
  // The next start's answer; this one never waits for it.
  void refreshUpdates({env, platform});

  const model = {
    began: Date.now(),
    opening: expectedOpening(launch.args),
    steps: new Map(),
    failure: undefined,
    ready: undefined,
    codebases: new Map(),
    calls: new Map(),
    stats: {calls: 0, failed: 0},
    warnings: [...warnings],
    stopping: undefined,
    stopped: undefined,
    raw: [],
    loadedAt: undefined,
    task: undefined,
  };
  const selected = new Set(launch.services);
  for (const id of ROWS) {
    if (id === 'data' ? model.opening.kind === 'resume' : selected.has(id)) model.steps.set(id, {id, state: 'waiting'});
  }
  // --build: the codebases whose own build runs first, and then beside the
  // engine; each one's latest errors, and what a build said before the
  // emulators were ready.
  const builds = (launch.builds ?? []).filter(entry => entry.script);
  for (const entry of (launch.builds ?? []).filter(entry => !entry.script)) model.warnings.push(`${entry.shown} has no build or build:watch script, so --build builds nothing there`);
  if (builds.length) model.steps.set('build', {id: 'build', state: 'waiting'});
  const compiled = new Map();
  const heldBuildLines = [];

  // ── Drawing ─────────────────────────────────────────────────────────
  const bannerWords = () => {
    const opening = model.opening;
    const how = opening.kind === 'resume' ? `picking up the data saved ${opening.savedAtMs ? ago(opening.savedAtMs) : 'before'}`
      : opening.kind === 'import' ? `first start, importing the seed "${basename(opening.seed ?? '')}"`
        : 'a fresh start';
    const project = demo ? projectId : `${projectId} ${yellow('(a real project id)')}`;
    // A start without --state-dir keeps its data in its own run directory.
    const where = ephemeral ? `data in ${shortPath(dirname(stateDir ?? ''), cwd)}, for this run` : `data in ${shortPath(stateDir, cwd)}`;
    return [`${bold('firenook')}  ${dim(version)}`, `${project}${DOT}${dim(how)}`, dim([`Node ${process.versions.node}`, where].join(G.dot))];
  };
  const banner = () => t.banner(bannerWords());

  function functionsProgress() {
    const all = [...model.codebases.values()];
    const loading = all.find(codebase => codebase.state === 'loading');
    return {done: all.filter(codebase => codebase.state !== 'loading').length, total: all.length || undefined, detail: loading ? codebaseName(loading.id) : undefined};
  }
  const compileErrors = () => [...compiled.values()].reduce((sum, errors) => sum + errors.length, 0);
  function buildRow(step) {
    const row = (marker, ms, about) => cells(LABELS.build, marker, timed(ms, about));
    const where = dim(builds.map(entry => entry.shown).join(', '));
    if (step.state === 'running') return row(spinner(), Date.now() - step.began, `${dim('compiling')}  ${where}`);
    if (step.state === 'waiting') return row(dim(G.wait), null, dim('waiting'));
    if (step.state === 'stopped') return row(dim(G.wait), null, dim('stopped'));
    const errors = compileErrors();
    if (errors) return row(red(G.fail), step.ms, `${red(`${count(errors)} ${errors === 1 ? 'error' : 'errors'}`)}${DOT}${where}`);
    if (step.failed) return row(red(G.fail), step.ms, `${red(step.failed)}${DOT}${where}`);
    return row(green(G.ok), step.ms, `${where}${DOT}${dim([...new Set(builds.map(entry => entry.script))].join(', '))}${step.slow ? `${DOT}${yellow('still compiling')}` : ''}`);
  }
  function serviceRow(step) {
    if (step.id === 'build') return buildRow(step);
    const label = LABELS[step.id];
    const row = (marker, ms, about) => cells(label, marker, timed(ms, about));
    if (step.state === 'done') {
      if (step.id === 'functions' && broken().length) {
        return row(red(G.fail), step.ms, `${red(broken().length === codebaseCount('user') ? 'your functions did not load' : `${broken().length} of your codebases did not load`)}${step.figures?.length ? `${DOT}${tally(step.figures)}` : ''}`);
      }
      const figures = step.figures?.length ? tally(step.figures) : dim('ready');
      return row(green(G.ok), step.ms, `${figures}${step.note ? `${DOT}${dim(step.note)}` : ''}`);
    }
    if (step.state === 'failed') return row(red(G.fail), step.ms, red(step.message || 'failed'));
    if (step.state === 'stopped') return row(dim(G.wait), null, dim('not started'));
    if (step.state === 'waiting') return row(dim(G.wait), null, dim('waiting'));
    // An import runs Firestore's, then Auth's, then Storage's: the later
    // rows wait their turn rather than spin.
    const firestore = model.steps.get('firestore');
    if (step.verb === 'importing' && step.id !== 'firestore' && firestore?.state === 'running') return row(dim(G.wait), null, dim('waits for Firestore'));
    const spent = Date.now() - step.began;
    let {done, total, detail} = step;
    if (step.id === 'functions') ({done, total, detail} = functionsProgress());
    if (step.id === 'data') detail = 'the seed it came from';
    const verb = dim(step.verb || 'starting');
    // A step that finishes quickly shows only its spinner: a bar appears
    // once it has run for 400 ms, so a resumed start never flashes one.
    if (spent < 400 || done == null) return row(spinner(), spent, `${verb}${detail ? `  ${dim(detail)}` : ''}`);
    if (!total) return row(spinner(), spent, `${verb}  ${count(done)} ${dim(UNITS[step.id] ?? '')}`);
    const figure = step.unit === 'percent' ? `${step.verb}  ${Math.floor((done / total) * 100)}%` : `${count(done)} / ${count(total)}`;
    // A narrow window drops the step's name before the bar shrinks too far.
    const room = t.bodyRoom() - 6 - 4 - figure.length;
    const named = detail && room - width(detail) - 2 >= 12;
    const bar = Math.max(8, Math.min(32, named ? room - width(detail) - 2 : room));
    return row(spinner(), spent, `${t.track(done / total, bar)}  ${figure}${named ? `  ${dim(detail)}` : ''}`);
  }
  const shownSteps = () => [...model.steps.values()].filter(step => step.id !== 'data' || step.state !== 'done')
    .sort((a, b) => ROWS.indexOf(a.id) - ROWS.indexOf(b.id));
  const startupRows = () => shownSteps().map(step => inside(serviceRow(step)));
  const startup = right => divider(bold('Start-up'), right);

  const codebaseCount = kind => [...model.codebases.values()].filter(codebase => codebase.kind === kind).length;
  // Your codebases that never loaded (a reload that failed keeps serving
  // the version before it, and is said in the log instead).
  const broken = () => [...model.codebases.values()].filter(codebase => codebase.kind === 'user' && codebase.state === 'failed' && !codebase.servingPrevious);

  function readyRows(room) {
    const ready = model.ready;
    const rows = [cells(dim('Console'), '', ready.console ? link(ready.console) : dim('off (firebase.json sets emulators.ui.enabled to false)'))];
    const ports = PORTS.filter(([name]) => ready.ports?.[name]).map(([name, label]) => `${dim(label)} ${ready.ports[name]}`);
    if (ports.length) rows.push(...flow(dim('Ports'), ports, room));
    const warned = model.warnings.length;
    if (warned === 1 && width(model.warnings[0]) <= room) rows.push(cells(yellow('Warning'), '', model.warnings[0]));
    else if (warned) rows.push(cells(yellow('Warnings'), '', `${count(warned)} start-up warnings${DOT}${dim('press')} ${bold('w')} ${dim('to list them')}`));
    // Magenta is the update's own colour: nothing else on the page uses it.
    if (update) rows.push(cells(magenta('Update'), '', `${bold(magenta(update.version))} is out${DOT}${bold(update.command)}${DOT}${link(RELEASES, "what's new")}`));
    return rows;
  }
  function readySection() {
    // In a terminal the ready line is a title: tools that watch a terminal
    // (mprocs, VS Code tasks) look for the phrase anywhere on a line, so it
    // only has to stay whole. Pipes, CI and log files get the plain output,
    // where the line is exact and alone.
    const heading = broken().length
      ? divider(`${yellow(G.warn)} ${bold(yellow('All emulators ready'))}${yellow(', except your functions')}`)
      : divider(`${green(G.ok)} ${bold(green('All emulators ready'))}`);
    return [...section(heading, readyRows(t.bodyRoom()).map(inside)), bottom()];
  }

  // What the compiler said, under the line that says how many.
  const compileLines = errors => [
    ...errors.slice(0, 8).flatMap(error => {
      const place = errorPlace(error);
      const [first, ...rest] = wrap(error.message, Math.max(20, t.streamRoom() - width(place) - 4));
      return [under(red(G.thread), `${dim(place)}  ${red(first)}`), ...rest.map(part => under(red(G.thread), `${' '.repeat(width(place) + 2)}${red(part)}`))];
    }),
    ...(errors.length > 8 ? [under(red(G.thread), dim(`+ ${count(errors.length - 8)} more`))] : []),
  ];
  function compileSection() {
    const failing = [...compiled.entries()].filter(([, errors]) => errors.length);
    return failing.flatMap(([shown, errors]) => section(divider(`${red(G.fail)} ${bold(red(failing.length > 1 ? `${shown} did not compile` : 'Your code did not compile'))}`), [
      ...errors.slice(0, 6).flatMap((error, at) => wrap(`${errorPlace(error)}  ${error.message}`, t.bodyRoom()).map((part, i) => cells(at === 0 && i === 0 ? dim('Errors') : '', '', i === 0 ? `${dim(errorPlace(error))}  ${red(part.slice(errorPlace(error).length + 2))}` : red(part)))),
      ...(errors.length > 6 ? [cells('', '', dim(`+ ${count(errors.length - 6)} more`))] : []),
      ...space(),
      ...field(dim('Next'), 'fix it and save: Firenook compiles it and loads it again by itself, and every emulator keeps running', dim),
    ].map(inside)));
  }

  // The code frame Node prints: the source line, and a caret under the spot.
  const frameLines = frame => frame.map(line => (/^\s*\^+\s*$/.test(line) ? red(line) : dim(line)));
  function brokenSection() {
    return broken().flatMap(codebase => {
      const error = loadError(codebase.error);
      return section(divider(`${red(G.fail)} ${bold(red(codebaseCount('user') > 1 ? `${codebaseName(codebase.id)} did not load` : 'Your functions did not load'))}`), [
      ...field(dim('Error'), error.message || 'the codebase did not load', red),
      cells(dim('Where'), '', error.where ?? codebase.directory),
      ...(error.frame.length ? [...space(), ...frameLines(error.frame).map(line => cells('', '', line))] : []),
      ...space(),
      ...field(dim('Next'), `fix it and save: Firenook loads it again by itself.${codebaseCount('extension') ? ` The ${codebaseCount('extension')} extension codebase${codebaseCount('extension') === 1 ? '' : 's'} and` : ''} every emulator keep running`, dim),
      ].map(inside));
    });
  }

  // ── Problems ────────────────────────────────────────────────────────
  // A failure says what went wrong, what to do about it and what became of
  // the data, in that order, and Firenook exits with code 1.
  const problem = lines => section(divider(`${red(G.fail)} ${bold(red('Firenook could not start'))}`), lines.map(inside));
  // A command to type, never cut: on one line when it fits, else one part a
  // line, joined the way the shell continues a line.
  const command = parts => {
    const whole = parts.join(' ');
    if (width(whole) <= t.bodyRoom()) return [cells('', '', bold(whole))];
    const more = platform === 'win32' ? ' ^' : ' \\';
    return parts.map((part, at) => cells('', '', bold(`${at ? '  ' : ''}${part}${at < parts.length - 1 ? more : ''}`)));
  };
  // The seed the saved data came from changed: the files that did (or why
  // they cannot be named), then both ways on, as commands to type.
  const seedProblem = change => {
    const seed = value('--import');
    const typed = path => (/[\s"'$`]/.test(path) ? JSON.stringify(path) : path);
    const lines = [...field(dim('Problem'), `the seed ${shortPath(seed, cwd)} changed after it was imported, so Firenook will not pick up ${shortPath(stateDir, cwd)}`), ...space()];
    const [changed, added, removed] = change.counts ?? [0, 0, 0];
    const listed = [];
    for (const [what, names, total] of [['changed', change.changed, changed], ['added', change.added, added], ['removed', change.removed, removed]]) {
      for (const name of names ?? []) listed.push(cells(listed.length ? '' : dim('Changed'), '', `${name}  ${dim(what)}`));
      if (total > (names ?? []).length) listed.push(cells('', '', dim(`and ${total - names.length} more ${what}`)));
    }
    if (change.whole) {
      listed.push(...field(dim('Changed'), 'which files cannot be said: the data was saved by an earlier Firenook, which kept one fingerprint for the whole seed', dim));
      for (const name of change.finder ?? []) listed.push(cells('', '', `${shortPath(join(seed, name), cwd)}  ${dim('(Finder writes this file)')}`));
    }
    lines.push(...listed, ...space());
    lines.push(...field(dim('Fix'), 'to import the changed seed, start with a new --state-dir; this one stays as it is', dim));
    lines.push(...field('', 'to keep this data with the seed as it is now:', dim));
    lines.push(...command(['firenook state:adopt-seed', `--state-dir ${typed(shortPath(stateDir, cwd))}`, `--import ${typed(shortPath(seed, cwd))}`]));
    lines.push(...space(), ...field(dim('Data'), `nothing was deleted: ${shortPath(stateDir, cwd)} is untouched`, dim));
    return lines;
  };
  // What became of the data. Before readiness nothing was served, so
  // nothing of the developer's was written; once ready, anything may have
  // been, and is kept.
  const dataLine = () => (model.ready ? (ephemeral ? `this run's data stays in ${shortPath(dirname(stateDir ?? ''), cwd)}` : `everything is kept in ${shortPath(stateDir, cwd)}`)
    : model.opening.kind === 'resume' ? `nothing was changed: ${shortPath(stateDir, cwd)} is as you left it`
      : model.opening.kind === 'import' && launch.args.includes('--resume-state') ? `the seed was imported into ${shortPath(stateDir, cwd)}; the next start picks it up`
        : ephemeral ? 'nothing of yours was changed'
          : model.opening.kind === 'fresh' && launch.args.includes('--resume-state') ? `the data is saved in ${shortPath(stateDir, cwd)}; the next start picks it up`
            : `the data in ${shortPath(stateDir, cwd)} is kept`);
  // An engine that ended without finishing a stop (killed, or crashed) may
  // have left the files open: the next start checks them first.
  const uncheckedLine = () => (stateDir && !ephemeral ? `the next start checks ${shortPath(stateDir, cwd)} first, and repairs it if it needs to` : dataLine());
  async function problemLines(failure) {
    if (failure.kind === 'port') {
      const listener = LISTENERS[failure.service] ?? {label: failure.service, key: `"${failure.service}": { "port": PORT }`};
      const held = failure.port ? holder(failure.port, platform) : undefined;
      const who = held ? `${held.program ?? 'a program'} (PID ${held.pid})${holderName(held.command) ? `: ${holderName(held.command)}` : ''}` : undefined;
      const taken = new Set(launch.args.flatMap((arg, i) => (/^--[a-z-]+-port$/.test(arg) ? [Number(launch.args[i + 1])] : [])));
      const free = failure.port ? await freePort(failure.host || host, failure.port, taken) : undefined;
      const why = String(failure.error ?? '').replace(/\s*\(os error \d+\)$/, '').replace(/^./, first => first.toLowerCase());
      const lines = [...field(dim('Problem'), `port ${failure.port} for ${listener.label} is ${who ? `held by ${who}` : `taken${why ? `: ${why}` : ''}`}`), ...space()];
      if (held) lines.push(cells(dim('Fix'), '', `${dim('stop it:')}  ${bold(platform === 'win32' ? `taskkill /PID ${held.pid}` : `kill ${held.pid}`)}`));
      lines.push(...field(held ? '' : dim('Fix'), `${held ? 'or give' : 'give'} ${listener.label} a free port in firebase.json:`, dim));
      lines.push(cells('', '', bold(`"emulators": { ${listener.key.replace('PORT', free)} }`)));
      lines.push(...space(), ...field(dim('Data'), dataLine(), dim));
      return lines;
    }
    if (failure.kind === 'state' && model.seed) return seedProblem(model.seed);
    if (failure.kind === 'state') {
      const seed = value('--import');
      let reason = String(failure.reason ?? failure.message);
      // Paths as the developer types them, and the Finder note as a row.
      const finder = reason.match(/ \(it holds (.+?), which Finder writes[^)]*\)/);
      if (finder) reason = reason.replace(finder[0], '');
      if (seed) reason = reason.replaceAll(resolve(cwd, seed), shortPath(seed, cwd));
      const lines = [...field(dim('Problem'), `${reason}, so Firenook will not pick up ${shortPath(stateDir, cwd)}`), ...space()];
      const changed = finder && seed ? shortPath(join(dirname(resolve(cwd, seed)), finder[1]), cwd) : undefined;
      if (changed) lines.push(cells(dim('Changed'), '', `${changed}  ${dim('(Finder writes this file)')}`), ...space());
      // Data kept without a seed, and data kept from one, say which way on.
      const seeded = reason.match(/it was imported from (.+?): pass --import/);
      if (/suite state is locked/.test(reason)) {
        lines.push(...field(dim('Fix'), `another Firenook is using ${shortPath(stateDir, cwd)}: stop it first, or start this one with another --state-dir`, dim));
      } else if (/started without a seed, so it cannot take the seed/.test(reason)) {
        lines.push(...field(dim('Fix'), 'to keep using it, start without --import; to start from the seed, give it a new --state-dir', dim));
      } else if (seeded) {
        lines.push(...field(dim('Fix'), 'to keep using it, start with its seed again:', dim));
        lines.push(cells('', '', bold(`--import ${/[\s"'$]/.test(shortPath(seeded[1], cwd)) ? JSON.stringify(shortPath(seeded[1], cwd)) : shortPath(seeded[1], cwd)}`)));
      } else if (/started without a seed: pass --resume-state/.test(reason)) {
        lines.push(...field(dim('Fix'), 'to keep using it, add --keep-data (or --resume-state); a fresh start needs a new --state-dir', dim));
      } else if (changed) {
        lines.push(...field(dim('Fix'), 'if nothing else changed, delete it and start again:', dim));
        lines.push(cells('', '', bold(`rm ${/[\s"'$]/.test(changed) ? JSON.stringify(changed) : changed}`)));
        lines.push(...field('', 'if you changed the seed on purpose, start with a new --state-dir to import it', dim));
      } else {
        lines.push(...field(dim('Fix'), 'start with a new --state-dir to import the seed again; the old one stays as it is', dim));
      }
      lines.push(...space(), ...field(dim('Data'), `nothing was deleted: ${shortPath(stateDir, cwd)} is untouched`, dim));
      return lines;
    }
    const lines = [...field(dim('Problem'), failure.message), ...space()];
    const raw = model.raw.slice(-6);
    if (raw.length) lines.push(...raw.flatMap(line => field('', line, dim)), ...space());
    lines.push(...field(dim('Data'), dataLine(), dim));
    return lines;
  }

  // ── The log ─────────────────────────────────────────────────────────
  // The name column is as wide as the longest name it has shown, so every
  // duration after it sits in one column.
  let nameWidth = 16;
  const nameCell = name => {
    nameWidth = Math.min(24, Math.max(nameWidth, width(name) + 2));
    return pad(ink.fit(name, nameWidth - 1), nameWidth);
  };
  const stream = (at, marker, name, ms, about) => open(cells(dim(at), marker, `${nameCell(name)}${timed(ms, about)}`));
  const under = (thread, text) => open(cells('', thread, text));
  const LEVELS = {debug: dim, info: text => text, warn: yellow, error: red};
  const THREADS = {debug: dim, info: dim, warn: yellow, error: red};
  // A function's own output keeps its level: info in full ink, warnings
  // yellow, errors red, debug dimmed; its logger's fields follow it.
  // A line of output longer than this many screen lines shows its start and
  // a count of the rest: the whole of it is in the console.
  const LONGEST = 30;
  function entryLines({level = 'info', text, fields}) {
    const room = t.streamRoom();
    const paint = LEVELS[level] ?? LEVELS.info;
    let parts = wrap(text, room);
    if (parts.length > LONGEST) parts = [...parts.slice(0, LONGEST), dim(`+ ${count(parts.length - LONGEST)} more lines`)];
    const lines = parts.map(part => paint(part));
    if (fields) {
      const listed = Object.entries(fields).map(([key, field]) => `${dim(key)} ${typeof field === 'string' ? field : JSON.stringify(field)}`).join(DOT);
      if (width(lines.at(-1)) + 3 + width(listed) <= room) lines[lines.length - 1] += `   ${listed}`;
      else lines.push(...wrap(listed, room));
    }
    const thread = (THREADS[level] ?? THREADS.info)(G.thread);
    return lines.map(part => under(thread, part));
  }
  // An error's stack: the message, the first frames from your own code, and
  // a count of the rest (Node internals, node_modules) with where to see it.
  // Paths under the project as the developer types them.
  const roots = [...new Set([cwd, (() => { try { return realpathSync(cwd); } catch { return cwd; } })()])].map(root => `${root.replace(/[\\/]+$/, '')}/`);
  const local = text => roots.reduce((line, root) => line.replaceAll(root, ''), String(text));
  function stackLines(text, consoleLink) {
    const [message, ...frames] = local(text).split('\n');
    const own = frames.filter(frame => /^\s*at /.test(frame) && !/node_modules|node:|\(internal/.test(frame)).slice(0, 3);
    const hidden = frames.filter(frame => frame.trim()).length - own.length;
    return [
      ...wrap(message, t.streamRoom()).map(part => under(red(G.thread), red(part))),
      ...own.map(frame => under(red(G.thread), dim(`  ${frame.trim()}`))),
      ...(hidden > 0 || consoleLink ? [under(red(G.thread), `${hidden > 0 ? `${dim(`+ ${hidden} more lines`)}${consoleLink ? DOT : ''}` : ''}${consoleLink ? link(consoleLink, 'open in console') : ''}`)] : []),
    ];
  }
  const lineOf = event => {
    const parsed = structured(event.message, event.level === 'warning' ? 'warn' : event.level);
    // A thrown error's stack arrives as one multi-line message.
    if (parsed.level === 'error' && /\n\s+at /.test(parsed.text)) return {stack: parsed.text};
    return parsed;
  };
  const consoleUrl = path => (model.ready?.console ? `${model.ready.console}${path}` : undefined);

  function callLines(call, lines, at) {
    const name = functionName(call.functionId, call.codebase);
    const failed = call.outcomeClass === 'failed';
    const marker = failed ? red(G.fail) : call.outcomeClass === 'skipped' ? dim(G.wait) : green(G.ok);
    const status = call.status && (call.kind === 'http' || call.kind === 'callable') ? `${DOT}${call.status >= 500 ? red(call.status) : call.status >= 400 ? yellow(call.status) : dim(call.status)}` : '';
    const where = call.kind === 'http' || call.kind === 'callable' ? '' : call.codebase && call.functionId?.includes(`ext-${call.codebase}-`) ? `${DOT}${dim(call.codebase)}` : '';
    const about = `${dim(call.kind ?? '')}${call.summary ? `${DOT}${call.summary}` : ''}${status}${where}`;
    const body = lines.flatMap(line => (line.stack ? stackLines(line.stack, consoleUrl(`/functions/invocations?invocation=${call.id}`)) : entryLines(line)));
    const said = lines.some(line => line.stack || line.level === 'error');
    const error = failed && call.error && !said ? stackLines(call.error, consoleUrl(`/functions/invocations?invocation=${call.id}`)) : [];
    return [stream(at, marker, name, call.durationMs, about), ...body, ...error];
  }
  function callFinished(call) {
    const held = model.calls.get(call.id);
    model.calls.delete(call.id);
    model.stats.calls += 1;
    if (call.outcomeClass === 'failed') model.stats.failed += 1;
    const at = clock();
    if (held?.shown) {
      // Its lines are already on screen under its first line.
      screen.emit(() => [stream(at, call.outcomeClass === 'failed' ? red(G.fail) : green(G.ok), functionName(call.functionId, call.codebase), call.durationMs, dim('finished'))]);
      return;
    }
    const lines = held?.lines ?? [];
    screen.emit(() => callLines(call, lines, at));
  }
  // Calls still running after HOLD, or that have printed a lot already, show
  // their first line and their output so far, and later output as it comes.
  function releaseHeld() {
    const now = Date.now();
    for (const held of model.calls.values()) {
      if (held.shown || (now - held.since < HOLD && held.lines.length < 200)) continue;
      held.shown = true;
      const at = clock();
      const call = held.call;
      const lines = held.lines;
      held.lines = [];
      screen.emit(() => [stream(at, spinnerStill(), functionName(call.functionId, call.codebase), null, `${dim(call.kind ?? '')}${call.summary ? `${DOT}${call.summary}` : ''}${DOT}${dim('still running')}`),
        ...lines.flatMap(line => (line.stack ? stackLines(line.stack) : entryLines(line)))]);
    }
  }
  const spinnerStill = () => blue(G.spin[0]);

  function logEvent(event) {
    if (!model.ready) {
      // Before readiness the log is the start-up card's business; a line
      // printed then shows only if the start fails.
      model.raw.push(`${event.source}: ${event.message}`);
      return;
    }
    const line = lineOf(event);
    if (event.execution) {
      const held = model.calls.get(event.execution);
      if (held && !held.shown) {
        held.lines.push(line);
        if (held.lines.length >= 200) releaseHeld();
        return;
      }
      if (held?.shown) {
        screen.emit(() => (line.stack ? stackLines(line.stack) : entryLines(line)));
        return;
      }
    }
    const at = clock();
    const marker = line.level === 'error' || line.stack ? red(G.fail) : line.level === 'warn' ? yellow(G.warn) : dim(G.wait);
    const source = event.function ? functionName(event.function, event.codebase) : String(event.source ?? 'firenook').replace(/^functions$/, 'functions').replace(/^extensions\[(.+)\]$/, '$1');
    if (line.stack) {
      screen.emit(() => [stream(at, marker, source, null, ''), ...stackLines(line.stack)]);
      return;
    }
    const room = t.streamRoom() - nameWidth - 8;
    const [first, ...rest] = wrap(line.text, Math.max(20, room));
    const paint = LEVELS[line.level] ?? LEVELS.info;
    screen.emit(() => [stream(at, marker, source, null, paint(first ?? '')), ...rest.map(part => under('', `${' '.repeat(nameWidth + 8)}${paint(part)}`))]);
  }
  function rawLine(text) {
    if (!text.trim()) return;
    if (!model.ready || model.stopping) {
      model.raw.push(text);
      if (model.raw.length > 200) model.raw.shift();
      return;
    }
    const at = clock();
    screen.emit(() => [stream(at, dim(G.wait), 'firenook', null, dim(text))]);
  }

  function codebaseEvent(codebase) {
    const before = model.codebases.get(codebase.id);
    model.codebases.set(codebase.id, codebase);
    if (!model.ready) return;
    if (codebase.state === 'loading') {
      model.task = {label: 'reloading', detail: codebaseName(codebase.id), since: Date.now()};
      return;
    }
    if (model.task?.detail === codebaseName(codebase.id)) model.task = undefined;
    if (!before || codebase.loads === before.loads) return;
    const at = clock();
    if (codebase.state === 'ready') {
      model.loadedAt = clock();
      screen.emit(() => [stream(at, blue(G.reload), 'reloaded', codebase.loadMs, [`${count(codebase.functionCount)} ${dim(codebase.functionCount === 1 ? 'function' : 'functions')}`, dim(codebaseName(codebase.id))].join(DOT))]);
      return;
    }
    // A save that does not load: the error where it is, and the reassurance
    // that the version from before the save is still the one answering.
    const since = before.loadedAt ? clock(new Date(before.loadedAt)) : model.loadedAt;
    screen.emit(() => [
      stream(at, red(G.fail), 'reload failed', codebase.loadMs, dim(codebaseName(codebase.id))),
      ...wrap(`${loadError(codebase.error).message || 'the codebase did not load'}${loadError(codebase.error).where ? `  ${dim(loadError(codebase.error).where)}` : ''}`, t.streamRoom()).map(part => under(red(G.thread), red(part))),
      ...frameLines(loadError(codebase.error).frame).map(line => under(red(G.thread), line)),
      under(red(G.thread), `${dim(codebase.servingPrevious && since ? `still running the version loaded at ${since}` : 'not running')}${consoleUrl('/functions') ? `${DOT}${link(consoleUrl(`/functions?codebase=${encodeURIComponent(codebase.id)}`), 'open in console')}` : ''}`),
    ]);
  }

  // ── Running ─────────────────────────────────────────────────────────
  function uptime() {
    const s = Math.floor((Date.now() - model.readyAt) / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  const keyList = () => [
    ...(model.ready?.console ? [['o', 'console']] : []),
    ...(selected.has('functions') && model.ready?.console ? [['r', 'reload']] : []),
    ['?', 'keys'], ['q', 'quit'],
  ];
  function footer() {
    const m = t.measure();
    const state = [`${green(G.live)} running ${dim(uptime())}`];
    if (selected.has('functions')) state.push(`${count(model.stats.calls)} ${model.stats.calls === 1 ? 'call' : 'calls'}`);
    if (model.stats.failed) state.push(red(`${count(model.stats.failed)} failed`));
    if (compileErrors()) state.push(red(`${G.fail} build errors`));
    if (broken().length) state.push(red(`${G.fail} functions not loaded`));
    else if ([...model.codebases.values()].some(codebase => codebase.servingPrevious)) state.push(yellow(`${G.warn} last save failed`));
    const left = state.join(DOT);
    const keys = keyList().map(([key, label]) => `${bold(key)} ${dim(label)}`).join('   ');
    const room = m - INSET;
    const line = `  ${dim(G.h.repeat(m - 2))}`;
    // Room is kept for a failure count, so the footer never jumps to two
    // lines the moment one appears.
    if (width(left) + (model.stats.failed ? 0 : 12) + width(keys) + 6 <= room) return [line, open(spread(left, keys, room))];
    return [line, open(left), open(keys)];
  }
  const taskLines = () => {
    const task = model.task;
    if (!task) return [];
    return ['', open(cells('', spinner(), `${nameCell(task.label)}${timed(Date.now() - task.since, task.detail ? dim(task.detail) : '')}`))];
  };
  const runningLive = () => [...taskLines(), '', ...footer()];

  // ── Keys ────────────────────────────────────────────────────────────
  const happened = (marker, name, ms, about) => { const at = clock(); screen.emit(() => [stream(at, marker, name, ms, about)]); };
  const KEYS = [
    ['o', 'open the console in your browser'],
    ['r', 'reload your functions'],
    ['e', 'export a snapshot of the data'],
    ['w', 'list the start-up warnings'],
    ['?', 'show these keys'],
    ['q', 'stop Firenook, keeping your data (Ctrl-C does the same)'],
  ];
  function showKeys() {
    const at = clock();
    screen.emit(() => [stream(at, blue(G.help), 'keys', null, ''), ...KEYS.map(([key, text]) => under('', `${bold(key)}   ${dim(text)}`)),
      under('', dim(`coding agent: run ${bold('npx firenook mcp add')} in the project to give it the MCP server`))]);
  }
  function showWarnings() {
    const at = clock();
    if (!model.warnings.length) {
      happened(green(G.ok), 'warnings', null, dim('none at start-up'));
      return;
    }
    screen.emit(() => model.warnings.flatMap((text, i) => wrap(text, t.streamRoom()).map((part, j) => open(cells(i === 0 && j === 0 ? dim(at) : '', j === 0 ? yellow(G.warn) : '', j === 0 ? part : dim(part))))));
  }
  function openConsole() {
    const url = model.ready?.console;
    if (!url) return;
    const [command, args] = opener(url, platform);
    try {
      const child = spawner(command, args, {detached: true, stdio: 'ignore', windowsHide: true});
      child.on?.('error', () => happened(yellow(G.warn), 'open', null, `${dim('no browser opened; the console is at')} ${link(url)}`));
      child.unref?.();
      happened(blue(G.open), 'opened', null, link(url));
    } catch { happened(yellow(G.warn), 'open', null, `${dim('no browser opened; the console is at')} ${link(url)}`); }
  }
  const consoleApi = path => `${model.ready.console}/api/v1${path}`;
  const consoleHeaders = {'content-type': 'application/json', 'x-firenook-console': '1', authorization: 'Bearer owner'};
  async function reloadFunctions() {
    if (!model.ready?.console || model.task) return;
    const ids = [...model.codebases.values()].filter(codebase => codebase.kind === 'user').map(codebase => codebase.id);
    if (!ids.length) return happened(dim(G.wait), 'reload', null, dim('no codebase of yours to reload'));
    model.task = {label: 'reloading', detail: ids.map(codebaseName).join(', '), since: Date.now()};
    for (const id of ids) {
      try {
        const response = await fetch(consoleApi(`/functions/codebases/${encodeURIComponent(id)}/reload`), {method: 'POST', headers: consoleHeaders, body: '{}', signal: AbortSignal.timeout(120_000)});
        if (!response.ok && response.status !== 409) happened(red(G.fail), 'reload', null, red(`${id}: HTTP ${response.status}`));
      } catch (error) { happened(red(G.fail), 'reload', null, red(`${id}: ${error.message}`)); }
    }
    model.task = undefined;
  }
  async function exportSnapshot() {
    if (!model.ready || model.task) return;
    const hub = model.ready.ports?.hub;
    const targets = ['firestore', 'auth', 'storage'].filter(name => selected.has(name));
    if (!hub || !targets.length) return;
    const now = new Date();
    const two = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const destination = join(cwd, '.firenook', 'exports', stamp);
    const began = Date.now();
    model.task = {label: 'exporting', detail: shortPath(destination, cwd), since: began};
    try {
      mkdirSync(destination, {recursive: true});
      // No Origin header: the hub refuses requests that carry one.
      const response = await fetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host}:${hub}/_admin/export`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({path: destination, targets, initiatedBy: 'firenook terminal'}), signal: AbortSignal.timeout(30 * 60_000)});
      model.task = undefined;
      if (response.ok) happened(green(G.ok), 'exported', Date.now() - began, dim(shortPath(destination, cwd)));
      else happened(red(G.fail), 'export failed', Date.now() - began, red(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`));
    } catch (error) {
      model.task = undefined;
      happened(red(G.fail), 'export failed', Date.now() - began, red(error.message));
    }
  }

  // ── The engine ──────────────────────────────────────────────────────
  const args = [...launch.args, '--terminal-events'];
  // Spawned once the builds are done.
  let child;
  const running = [];
  let requestedStop = false;
  let lastHeard = Date.now();
  const stop = signal => {
    if (requestedStop) return;
    requestedStop = true;
    model.stopping = {since: Date.now()};
    for (const build of running) build.stop();
    try { if (child && child.exitCode === null) requestNativeStop(child, signal, platform); } catch { /* already gone */ }
    if (!screen.closed) screen.live(stoppingLive);
  };
  const stoppingWhat = () => (!child ? 'stopping the build' : !model.ready ? 'closing the data cleanly first'
    : exportDir ? `exporting to ${shortPath(exportDir, cwd)}` : 'saving your data');
  const stoppingLive = () => ['', open(cells('', spinner(), `${nameCell('stopping')}${timed(Date.now() - model.stopping.since, dim(stoppingWhat()))}`))];

  // A build's news: its errors as they change, its other lines in the log,
  // and the build itself ending while the emulators run.
  function buildEvent(entry, event) {
    if (event.type === 'compiling') {
      if (model.ready && !model.task) model.task = {label: 'compiling', detail: entry.shown, since: Date.now()};
      return;
    }
    if (event.type === 'compiled' || (event.type === 'ended' && !entry.watch)) {
      if (model.task?.label === 'compiling') model.task = undefined;
      const before = compiled.get(entry.shown)?.length ?? 0;
      const errors = event.errors ?? [];
      compiled.set(entry.shown, errors);
      if (!model.ready) return;
      const at = clock();
      if (errors.length) screen.emit(() => [stream(at, red(G.fail), 'build', null, `${red(`${count(errors.length)} ${errors.length === 1 ? 'error' : 'errors'}`)}${DOT}${dim(entry.shown)}`), ...compileLines(errors)]);
      else if (before) screen.emit(() => [stream(at, green(G.ok), 'build', null, dim(`no errors${G.dot}${entry.shown}`))]);
      return;
    }
    if (event.type === 'text') {
      if (!model.ready) { heldBuildLines.push([entry, event.text, event.error]); return; }
      const at = clock();
      screen.emit(() => [stream(at, event.error ? red(G.fail) : dim(G.wait), 'build', null, event.error ? red(event.text) : dim(event.text))]);
      return;
    }
    if (event.type === 'ended' && entry.watch && !requestedStop && model.ready) {
      const at = clock();
      screen.emit(() => [stream(at, red(G.fail), 'build', null, red(`${entry.script} ended${event.code ? ` (exit code ${event.code})` : ''}`)),
        under(red(G.thread), dim('saves are no longer compiled; stop Firenook and start it again to compile them'))]);
    }
  }

  let resolveFailure;
  const failureShown = new Promise(done => { resolveFailure = done; });
  async function handle(event) {
    lastHeard = Date.now();
    switch (event.type) {
      case 'opening':
        model.opening = {...model.opening, ...event};
        return;
      case 'seed':
        model.seed = event;
        return;
      case 'step': {
        const step = model.steps.get(event.id) ?? {id: event.id};
        if (!model.steps.has(event.id)) model.steps.set(event.id, step);
        if (event.state === 'running' && step.state !== 'running') step.began = Date.now();
        Object.assign(step, Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type' && key !== 'id')));
        if (step.state === 'running' && !step.began) step.began = Date.now();
        return;
      }
      case 'codebase': return codebaseEvent(event.codebase);
      case 'call':
        if (event.state === 'started') model.calls.set(event.call.id, {call: event.call, lines: [], since: Date.now(), shown: false});
        else callFinished(event.call);
        return;
      case 'log': return logEvent(event);
      case 'ready': return becomeReady(event);
      case 'failed':
        model.failure = event;
        await showFailure(event);
        resolveFailure();
        return;
      case 'stopping':
        if (!model.stopping) model.stopping = {since: Date.now()};
        return;
      case 'stopped':
        model.stopped = event.outcome ?? {};
        return;
      default:
    }
  }

  function becomeReady(event) {
    model.ready = event;
    model.readyAt = Date.now();
    model.loadedAt = clock();
    model.warnings = [...model.warnings, ...(event.warnings ?? [])];
    for (const step of model.steps.values()) if (step.state === 'running' || step.state === 'waiting') Object.assign(step, {state: 'done'});
    clearInterval(startupTicker);
    const tookAll = model.readyAt - model.began;
    screen.emit(() => [...section(startup(dim(took(tookAll))), startupRows()), ...compileSection(), ...brokenSection(), ...readySection(), '', rule(bold('Logs')), ...space()]);
    // What a build printed before the emulators were ready.
    for (const [entry, text, error] of heldBuildLines.splice(0)) buildEvent(entry, {type: 'text', text, error});
    screen.pin(true);
    screen.live(runningLive);
    runningTicker = setInterval(() => { releaseHeld(); screen.frame(); }, 250);
  }

  async function showFailure(failure) {
    clearInterval(startupTicker);
    if (model.ready) {
      // Running, not starting: a service failed under it. The log keeps its
      // place; the card says what stopped and what became of the data.
      clearInterval(runningTicker);
      const lines = await problemLines(failure);
      screen.live(() => []);
      screen.emit(() => ['', top(), ...air(), inside(`${red(G.fail)} ${bold(red('Firenook stopped'))}`), ...air(), ...lines.map(inside), ...air(), bottom()]);
      return;
    }
    const row = failure.kind === 'port' ? LISTENERS[failure.service]?.row : failure.kind === 'state' ? 'data' : undefined;
    for (const step of model.steps.values()) {
      if (step.id === row) Object.assign(step, {state: 'failed', message: failure.kind === 'port' ? `port ${failure.port} is taken` : step.message ?? 'refused'});
      else if (step.state === 'running' || step.state === 'waiting') step.state = 'stopped';
    }
    if (failure.kind === 'state' && !model.steps.has('data')) model.steps.set('data', {id: 'data', state: 'failed', message: 'refused'});
    const lines = await problemLines(failure);
    screen.live(() => []);
    screen.emit(() => [...section(startup(red('stopped')), startupRows()), ...problem(lines), bottom()]);
  }

  // The card is as wide as what it will hold, worked out before its top
  // border is printed: the banner, and the ready rows as the launch's own
  // ports and console address foretell them.
  const port = name => Number(value(`--${name}-port`)) || undefined;
  const foretold = {console: launch.args.includes('--no-ui') ? undefined : `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port('ui') ?? 4000}/console`,
    ports: Object.fromEntries(PORTS.map(([name]) => [name, selected.has(name) || name === 'hub' ? port(name) : undefined]).filter(([, number]) => number)), ms: 0};
  model.ready = foretold;
  for (const row of readyRows(Infinity)) t.claim(row);
  model.ready = undefined;
  for (const text of bannerWords()) t.claim(`${' '.repeat(BODY - INSET)}${text}`);
  t.freeze();
  // The start-up card stays open underneath the rows as they fill.
  screen.begin();
  screen.emit(banner);
  screen.live(() => [...section(startup(dim(took(Date.now() - model.began))), startupRows()), bottom()]);
  const startupTicker = setInterval(() => screen.frame(), 80);
  let runningTicker;

  // ── Keys and signals ────────────────────────────────────────────────
  const onKey = key => {
    const k = key.toString();
    if (k === '\x03' || k === 'q' || k === 'Q') return void stop('SIGINT');
    if (!model.ready || model.stopping) return;
    if (k === 'o') openConsole();
    else if (k === 'r') void reloadFunctions();
    else if (k === 'e') void exportSnapshot();
    else if (k === 'w') showWarnings();
    else if (k === '?' || k === 'h') showKeys();
  };
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) {
    input.setRawMode(true);
    input.resume();
    input.on('data', onKey);
  }
  const restore = () => {
    if (raw && input.isRaw) input.setRawMode(false);
    if (!screen.closed) out.write('\x1b[?25h');
  };
  const onSignal = signal => () => stop(signal);
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  // A closed window or pane: stop without drawing to a terminal that is gone.
  const onHup = () => { screen.end(); stop('SIGTERM'); };
  const onResize = () => screen.relayout();
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  process.on('exit', restore);
  out.on?.('resize', onResize);
  out.on?.('error', () => { screen.end(); stop('SIGTERM'); });
  const timeout = setInterval(() => {
    if (!model.ready && Date.now() - lastHeard > QUIET_LIMIT) {
      model.raw.push('The engine said nothing for 20 minutes while starting; requesting graceful shutdown and preserving state.');
      stop('SIGTERM');
    }
  }, 60 * 1000);

  // Lines from the engine: events, and anything else it prints as it is.
  const reader = () => {
    let buffered = '';
    return chunk => {
      buffered += chunk.toString();
      let at;
      while ((at = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, at).replace(/\r$/, '');
        buffered = buffered.slice(at + 1);
        if (line.startsWith(EVENT_PREFIX)) {
          let event;
          try { event = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { rawLine(line); continue; }
          queue = queue.then(() => handle(event)).catch(error => rawLine(`terminal: ${error.message}`));
        } else rawLine(line);
      }
    };
  };
  let queue = Promise.resolve();

  try {
    // The builds come first, so the engine loads what they wrote.
    if (builds.length) {
      const step = model.steps.get('build');
      Object.assign(step, {state: 'running', began: Date.now()});
      running.push(...builds.map(entry => startBuild(entry, {env, platform, spawner, onEvent: event => buildEvent(entry, event)})));
      const firsts = await Promise.all(running.map(build => build.first));
      const failed = firsts.findIndex(first => first.ended && first.code !== 0 && !first.count);
      Object.assign(step, {state: requestedStop ? 'stopped' : 'done', ms: Date.now() - step.began, slow: firsts.some(first => first.slow),
        failed: failed === -1 ? undefined : `${running[failed].command} failed${firsts[failed].code == null ? '' : ` (exit code ${firsts[failed].code})`}`});
    }
    if (requestedStop) {
      clearInterval(startupTicker);
      screen.live(() => []);
      const at = clock();
      screen.emit(() => [...section(startup(red('stopped')), startupRows()), bottom(), open(cells(dim(at), green(G.ok), `${nameCell('stopped')}${timed(Date.now() - model.stopping.since, dim('before the emulators started; nothing of yours was changed'))}`)), '']);
      screen.end();
      return 130;
    }
    child = spawner(launch.binary, args, {cwd: launch.cwd, env: launch.env, detached: platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.stdin?.on('error', () => {});
    child.stdout.on('data', reader());
    child.stderr.on('data', reader());
    const outcome = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({code, signal}));
    });
    await queue;
    clearInterval(startupTicker);
    clearInterval(runningTicker);
    if (model.failure) {
      await failureShown;
      screen.end();
      return 1;
    }
    const at = clock();
    // Stopped as asked: the engine finished its own stop and exited 0, or a
    // stop signal ended it before it was listening for one, which it is
    // before it opens any data. A kill, or any other end, is no stop.
    const stopSignal = outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM';
    if (requestedStop && (outcome.code === 0 || (!model.ready && stopSignal))) {
      const ms = model.stopping ? Date.now() - model.stopping.since : null;
      const kept = (model.stopped?.beforeReady ?? !model.ready) ? (ephemeral ? 'nothing of yours was changed' : `the data in ${shortPath(stateDir, cwd)} is as it was`)
        : exportDir ? `exported to ${shortPath(exportDir, cwd)}`
          : ephemeral ? `this run's data stays in ${shortPath(dirname(stateDir ?? ''), cwd)}` : `everything is kept in ${shortPath(stateDir, cwd)}`;
      // Before readiness, what it did comes first: the place may not fit.
      const said = model.ready ? dim(kept) : `${dim('before it was ready')}${DOT}${dim(kept)}`;
      screen.live(() => []);
      screen.emit(() => [open(cells(dim(at), green(G.ok), `${nameCell('stopped')}${timed(ms, said)}`)), '']);
      screen.end();
      return outcome.code === 0 ? 0 : 130;
    }
    // The engine ended on its own, or on a failure it could not describe,
    // or was ended before it finished the stop asked of it.
    screen.live(() => []);
    const lines = model.raw.slice(-12);
    const title = requestedStop ? 'Firenook did not finish stopping' : model.ready ? 'Firenook stopped unexpectedly' : 'Firenook could not start';
    // Ended by a signal, or by itself with no stop and nothing it could
    // describe: either way it may not have closed the data.
    const data = requestedStop || outcome.signal || model.ready ? uncheckedLine() : dataLine();
    screen.emit(() => ['', ...section(divider(`${red(G.fail)} ${bold(red(title))}`, dim(outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`)),
      [...lines.flatMap(line => field('', line, dim)), ...field(dim('Data'), data, dim)].map(inside)), bottom(), '']);
    screen.end();
    return outcome.code === 0 ? 1 : (outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 1));
  } finally {
    for (const build of running) build.stop();
    clearInterval(timeout);
    clearInterval(startupTicker);
    clearInterval(runningTicker);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
    out.off?.('resize', onResize);
    if (raw) {
      input.off('data', onKey);
      if (input.isRaw) input.setRawMode(false);
      input.pause();
    }
    restore();
    process.off('exit', restore);
  }
}

// emulators:start in a terminal, as `firenook emulators:start` runs it and
// `firenook init` hands over to it.
export async function startInTerminal(options, typed, {version, cwd = process.cwd()} = {}) {
  const diagnostic = await diagnose(options, cwd, {quiet: true});
  const project = diagnostic.project;
  return runInteractive(prepareLaunch(diagnostic, options, 'start', typed, {quiet: true}),
    {version, projectId: project.project, demo: project.demo, warnings: project.warnings, cwd});
}
