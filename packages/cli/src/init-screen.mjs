// firenook init in a terminal: the start screen's card, with every choice
// already made (Enter takes them all), then the set-up drawn as it runs,
// and the emulators started in the same terminal, or the commands still to
// type. In a folder that already has a firebase.json it shows what
// `init --adopt` would add, and adds it on a yes. Pipes, CI, --json,
// --dry-run and --yes get the plain lines of `init.mjs` instead.
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROJECT_AGENTS, planAgents, shown } from './agents.mjs';
import { manifest, nodeCheck } from './binary.mjs';
import { choiceField, createForm, formKeys, formRows, keyLines, keys, press, textField } from './form.mjs';
import { INIT_EMULATORS, INIT_PORTS, adopt, agentNames, initChoices, scaffoldPlan, writeScaffold } from './init.mjs';
import { isDemoProject, parseOptions, validProjectId } from './options.mjs';
import { holderName, portHolder } from './session.mjs';
import { enclosingPackage, nextSteps, setUpSteps } from './setup.mjs';
import { BODY, INSET, capabilities, createInk, createLayout, createScreen, took, wrap } from './terminal.mjs';

const NAMES = {firestore: 'Firestore', auth: 'Auth', storage: 'Storage', pubsub: 'Pub/Sub', ui: 'Console', functions: 'Functions', tasks: 'Cloud Tasks', eventarc: 'Eventarc', hub: 'Hub', logging: 'Console log'};
const LANGUAGE_NAMES = {typescript: 'TypeScript', javascript: 'JavaScript', none: 'None'};

// Whether something listens on a port of this machine now.
export function portInUse(port, host = '127.0.0.1') {
  return new Promise(done => {
    const socket = createConnection({host, port});
    const end = used => { socket.destroy(); done(used); };
    socket.setTimeout(300, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

// A folder as people say it: under the home folder, with ~.
function homePath(path) {
  const fromHome = relative(homedir(), path);
  return fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome) ? join('~', fromHome) : path;
}

// A project id as it is typed: lowercase, and a space or another separator
// becomes a hyphen.
const idCharacters = text => text.toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '');

export async function initInTerminal(options, {cwd = process.cwd(), out = process.stdout, input = process.stdin, env = process.env, platform = process.platform,
  version = manifest.version, home, spawner, holder = portHolder, probe = portInUse, start, node = process.versions.node} = {}) {
  const caps = capabilities({env, platform});
  const ink = createInk(caps);
  const size = {columns: () => Math.max(48, out.columns || 80), rows: () => Math.max(10, out.rows || 24)};
  const t = createLayout(ink, size);
  const screen = createScreen(out, ink, size);
  const {G, bold, dim, green, yellow, red, DOT, spinner} = ink;
  const {cells, inside, section, divider, field, bottom, open} = t;
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  const runtime = nodeCheck(node);
  const existing = existsSync(config) && !options.force;

  // ── Keys, signals and the end ───────────────────────────────────────
  let onKey = () => {};
  const onData = chunk => { for (const key of keys(chunk)) onKey(key); };
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) { input.setRawMode(true); input.resume(); }
  input.on('data', onData);
  // A closed window, or a stop from outside, is the same as Ctrl-C.
  const onSignal = () => onKey({name: 'ctrl-c'});
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  const onResize = () => screen.relayout();
  out.on?.('resize', onResize);
  let tickers = [];
  const release = () => {
    for (const ticker of tickers) clearInterval(ticker);
    tickers = [];
    input.off('data', onData);
    if (raw && input.isRaw) input.setRawMode(false);
    input.pause();
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    out.off?.('resize', onResize);
  };
  const finish = (lines, code) => {
    screen.live(() => []);
    if (lines.length) screen.emit(() => lines);
    screen.end();
    release();
    return code;
  };
  // Lines under the card, wrapped to the window.
  const room = () => t.measure() - INSET;
  const note = (text, paint = dim) => wrap(text, room()).map(part => open(paint(part)));
  const tick = () => { const ticker = setInterval(() => screen.frame(), 80); tickers.push(ticker); return ticker; };
  // One question, as a choice between two answers on the line under the card.
  const ask = (question, {yes = 'Yes', no = 'No', hint, above = []}) => new Promise(done => {
    let answer = true;
    const draw = () => {
      const pick = (on, text) => (on ? `${ink.blue(caps.ascii ? '(*)' : '●')} ${ink.underline(bold(text))}` : `${dim(caps.ascii ? '( )' : '○')} ${dim(text)}`);
      return [...above, '', ...keyLines([bold(question), `${pick(answer, yes)}   ${pick(!answer, no)}`], room()).map(open), ...(hint ? note(hint) : []), '',
        ...keyLines([`${bold(caps.ascii ? 'left/right' : '←→')} ${dim('choose')}`, `${bold('enter')} ${dim('answer')}`, `${bold('y')} ${dim(yes.toLowerCase())}`, `${bold('n')} ${dim(no.toLowerCase())}`], room()).map(open)];
    };
    screen.live(draw);
    onKey = key => {
      if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || key.name === 'space') answer = !answer;
      else if (key.name === 'text' && /^y$/i.test(key.text)) return done(true);
      else if (key.name === 'text' && /^n$/i.test(key.text)) return done(false);
      else if (key.name === 'enter') return done(answer);
      else if (key.name === 'escape' || key.name === 'ctrl-c' || key.name === 'ctrl-d') return done(undefined);
      screen.frame();
      return undefined;
    };
  });

  // ── The card's opening ──────────────────────────────────────────────
  const detected = planAgents(directory, {env});
  const words = () => [
    `${bold('firenook')}  ${dim(version)}`,
    `${existing ? 'a project' : 'a new project'} in ${homePath(directory)}`,
    [runtime.problem ? yellow(`Node ${node}: the emulators need Node 22, 24 or 26`) : runtime.note ? yellow(`Node ${node}: not tested with the emulators`) : dim(`Node ${node}`),
      dim(detected.length ? `${agentNames(detected)} found` : 'no coding agent found')].join(DOT),
  ];
  for (const text of words()) t.claim(`${' '.repeat(BODY - INSET)}${text}`);
  screen.begin();
  if (existing) return adoptScreen();

  // ── The form ────────────────────────────────────────────────────────
  let choices;
  try { choices = initChoices({...options, yes: true}, directory, {env, home}); } catch (error) { return finish([...t.banner(words()), inside(cells(red('Problem'), '', red(error.message))), bottom(), ''], 1); }
  const enclosing = enclosingPackage(directory, home);
  const taken = new Map();
  const portNote = port => (taken.has(port) ? `${port} in use` : String(port));
  const project = textField({id: 'project', label: 'Project ID', value: choices.project, filter: idCharacters,
    check: field => (validProjectId(field.value) ? undefined : 'use lowercase letters, digits and hyphens: 6 to 30 characters starting with a letter, or demo- and any length'),
    hint: field => (isDemoProject(field.value) ? {text: 'demo- keeps it on this machine: no request can reach a real Firebase project'}
      : validProjectId(field.value) ? {text: 'a real project ID: data stays here, but your Functions could still reach that project\'s live services', tone: 'warn'}
        : {text: 'lowercase letters, digits and hyphens; demo- in front keeps it local'})});
  const emulatorOptions = INIT_EMULATORS.map(id => ({id, label: NAMES[id], port: String(INIT_PORTS[id]), detail: String(INIT_PORTS[id])}));
  const emulators = choiceField({id: 'emulators', label: 'Emulators', many: true, options: emulatorOptions, value: choices.emulators,
    hint: () => {
      const busy = emulatorOptions.filter(option => taken.has(INIT_PORTS[option.id]));
      if (busy.length) return {text: `${busy.map(option => `${option.label} ${taken.get(INIT_PORTS[option.id])}`).join('; ')}: stop it before you start, or change the port in firebase.json`, tone: 'warn'};
      return {text: 'space turns one on or off; the official ports, kept in firebase.json'};
    }});
  const functionPorts = ['functions', 'tasks', 'eventarc'];
  const language = choiceField({id: 'functions', label: 'Functions', options: [
    {id: 'typescript', label: 'TypeScript'}, {id: 'javascript', label: 'JavaScript'}, {id: 'none', label: 'None'},
  ], value: choices.language, hint: field => {
    const busy = functionPorts.filter(id => taken.has(INIT_PORTS[id]));
    if (field.value !== 'none' && busy.length) return {text: `${busy.map(id => `${NAMES[id]} ${taken.get(INIT_PORTS[id])}`).join('; ')}: stop it before you start, or change the port in firebase.json`, tone: 'warn'};
    if (field.value === 'typescript') return {text: `functions/src/index.ts, compiled to lib/ as you save; ${functionPorts.map(id => `${NAMES[id]} ${INIT_PORTS[id]}`).join(', ')}`};
    if (field.value === 'javascript') return {text: `functions/index.js, loaded again as you save; ${functionPorts.map(id => `${NAMES[id]} ${INIT_PORTS[id]}`).join(', ')}`};
    return {text: 'no Functions codebase, so no Cloud Tasks or Eventarc either'};
  }});
  const agentOptions = PROJECT_AGENTS.map(agent => ({id: agent.id, label: agent.name, file: agent.file.split('\\').join('/')}));
  const agents = choiceField({id: 'agents', label: 'Agents', many: true, options: agentOptions, value: choices.agents, hint: field => {
    const chosen = agentOptions.filter(option => field.value.has(option.id));
    if (!chosen.length) return {text: 'none; npx firenook mcp add gives one Firenook\'s MCP tools later'};
    return {text: `${chosen.map(option => option.file).join(', ')}: Firenook's MCP tools for ${agentNames(chosen.map(option => ({name: option.label})))}`};
  }});
  const setUpOptions = [{id: 'install', label: 'Install packages', said: 'install packages'}, {id: 'pin', label: 'Pin Firenook', said: 'pin Firenook'}];
  const setUp = choiceField({id: 'setup', label: 'Set up', many: true, options: setUpOptions,
    value: [...(options['no-install'] ? [] : ['install']), ...(options['no-pin'] || enclosing ? [] : ['pin'])], hint: field => {
      const on = setUpOptions[field.cursor].id;
      if (on === 'pin') {
        if (enclosing) return {text: `${shown(directory, enclosing)} is the package here: add Firenook there instead (npm i -D -E firenook)`, tone: field.value.has('pin') ? 'warn' : 'dim'};
        return {text: `package.json gets firenook ${version}, exactly, and an emulators script`};
      }
      return {text: language.value === 'none' ? 'npm install for Firenook, here' : `npm install in functions/${language.value === 'typescript' ? ', then the first build' : ''}`};
    }});
  const form = createForm([project, emulators, language, agents, setUp], {
    check: () => (![...emulators.value].some(id => id !== 'ui') && language.value === 'none' ? {field: 'emulators', text: 'choose an emulator besides the console, or Functions'} : undefined),
  });
  // Ports something already listens on, said beside each and in the hints.
  void (async () => {
    const ports = [...new Set([...INIT_EMULATORS, ...functionPorts, 'hub', 'logging'].map(id => INIT_PORTS[id]))];
    const used = await Promise.all(ports.map(port => probe(port).then(inUse => [port, inUse])));
    for (const [port, inUse] of used) {
      if (!inUse) continue;
      const who = holder(port, platform);
      taken.set(port, who ? `${port} is held by ${holderName(who.command) ?? who.program ?? 'a program'}${who.pid ? ` (PID ${who.pid})` : ''}` : `${port} is in use`);
    }
    for (const option of emulatorOptions) if (taken.has(INIT_PORTS[option.id])) Object.assign(option, {note: true, detail: portNote(INIT_PORTS[option.id])});
    screen.frame();
  })();
  for (const line of formRows(form, t)) t.claim(line);
  t.claim(cells('Emulators', '', emulatorOptions.map(option => `${G.ok} ${option.label} ${option.detail}`).join('   ')));
  t.freeze();
  screen.emit(() => t.banner(words()));
  const heading = () => divider(bold('New project'));
  screen.live(() => [...section(heading(), formRows(form, t).map(inside)), bottom(), '', ...formKeys(ink, room()).map(open)]);
  const answered = await new Promise(done => {
    onKey = key => {
      const result = press(form, key);
      if (result) return done(result);
      screen.frame();
      return undefined;
    };
  });
  if (answered === 'cancel') return finish([...section(heading(), formRows(form, t, {still: true}).map(inside)), bottom(), '', ...note('Cancelled: nothing was written.'), ''], 130);
  screen.emit(() => section(heading(), formRows(form, t, {still: true}).map(inside)));
  choices = {project: project.value, language: language.value, emulators: new Set(emulators.value), agents: [...agents.value],
    install: setUp.value.has('install'), pin: setUp.value.has('pin')};
  const typescript = choices.language === 'typescript';

  // ── The set-up ──────────────────────────────────────────────────────
  const began = Date.now();
  const files = {id: 'files', label: 'Files', state: 'running', began, detail: 'writing'};
  try {
    const {plan} = scaffoldPlan(choices, config, {force: Boolean(options.force)});
    writeScaffold(plan);
    const kinds = [];
    for (const file of plan) {
      const name = shown(directory, file.path);
      const kind = name.startsWith('functions/') ? 'functions/' : /\.rules$|indexes\.json$/.test(name) ? 'rules' : name;
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    const kept = plan.filter(file => file.skip).length;
    Object.assign(files, {state: 'done', ms: Date.now() - began, detail: `${kinds.join(', ')}${kept ? `${DOT}${dim(`${kept} kept as they were`)}` : ''}`});
  } catch (error) {
    Object.assign(files, {state: 'failed', ms: Date.now() - began, detail: error.message});
    return finish([...section(divider(bold('Set-up')), [inside(row(files))]), bottom(), ''], 1);
  }
  const work = setUpSteps(choices, directory, {version, config, env, platform, spawner});
  const rows = [files, ...work.steps];
  const setUpSection = () => section(divider(bold('Set-up'), dim(took(Date.now() - began))), rows.map(item => inside(row(item))));
  screen.live(() => [...setUpSection(), bottom()]);
  const ticker = tick();
  let stopped = false;
  onKey = key => {
    if (key.name === 'ctrl-c' || key.name === 'escape' || key.name === 'ctrl-d') { stopped = true; work.stop(); }
  };
  const result = await work.run(() => screen.frame());
  clearInterval(ticker);
  const total = Date.now() - began;
  screen.live(() => []);
  screen.emit(() => section(divider(bold('Set-up'), dim(took(total))), rows.map(item => inside(row(item)))));
  for (const item of rows.filter(each => each.state === 'failed' && each.tail?.length)) {
    screen.emit(() => section(divider(`${red(G.fail)} ${bold(red(item.detail))}`), [
      ...item.tail.slice(-8).flatMap(line => field('', line, dim)),
      ...(item.cwd ? [cells(dim('Where'), '', homePath(item.cwd))] : []),
    ].map(inside)));
  }
  const pin = work.steps.find(item => item.id === 'firenook');
  const ready = !stopped && result.ok && !runtime.problem && (choices.language === 'none' || work.steps.find(item => item.id === 'packages')?.state === 'done');
  if (ready && start) {
    const yes = await ask('Start the emulators now?', {above: [bottom()],
      hint: `${pin?.written ? work.manager.run('emulators') : `npx firenook emulators:start --keep-data${typescript ? ' --build' : ''}`} starts them any time; your data stays between runs`});
    if (yes) {
      screen.live(() => []);
      screen.emit(() => [bottom(), '']);
      screen.end();
      release();
      const args = ['--keep-data', ...(typescript ? ['--build'] : []), ...(options.config ? ['--config', options.config] : [])];
      return start(parseOptions(args).options, args);
    }
  }
  const next = nextSteps(choices, work.steps, {manager: work.manager, node});
  const lines = [
    ...next.flatMap(step => [cells(dim(step.label), '', bold(step.command)), ...field('', step.why, dim)]),
    ...field(dim('Connect'), 'the console\'s Connect button has the lines that point your app at the emulators, for each SDK', dim),
  ];
  if (!choices.agents.length && detected.length) lines.push(cells(dim('Agent'), '', `${bold('npx firenook mcp add')}${DOT}${dim(`gives ${agentNames(detected)} the MCP tools`)}`));
  const said = stopped ? [...note('Stopped. What was done is kept; the steps above finish the rest.'), ''] : [''];
  return finish([...section(divider(bold('Next')), lines.map(inside)), bottom(), ...said], stopped ? 130 : result.ok ? 0 : 1);

  // A set-up step's row: its label, its marker, how long it took and what it did.
  function row(item) {
    const line = (marker, ms, about) => cells(item.label, marker, t.timed(ms, about));
    const notes = item.notes?.length ? `${DOT}${yellow(item.notes.join('; '))}` : '';
    if (item.state === 'done') return line(green(G.ok), item.ms, `${item.detail}${notes}`);
    if (item.state === 'failed') return line(red(G.fail), item.ms, `${red(item.detail)}${notes}`);
    if (item.state === 'skipped') return line(dim(G.wait), null, dim(item.detail));
    if (item.state === 'running') return line(spinner(), Date.now() - item.began, dim(item.detail));
    return line(dim(G.wait), null, dim(item.id === 'build' ? 'waits for the packages' : 'waiting'));
  }

  // ── A folder with a firebase.json ───────────────────────────────────
  // What `init --adopt` would add, and a yes adds it.
  async function adoptScreen() {
    t.freeze();
    screen.emit(() => t.banner(words()));
    const capture = () => {
      const lines = [];
      return {lines, log: {log: () => {}, error: text => lines.push(text)}};
    };
    const findings = lines => lines.flatMap(text => {
      const match = /^ {2}(error|skip|add|ok|wrote)\s+(.*)$/.exec(text);
      if (!match) return [];
      const [, verb, said] = match;
      // Paths as the project names them, and Firenook's own name dropped:
      // the whole card is Firenook's.
      const what = said.replace(/^Firenook: /, '').split(`${directory}${sep}`).join('').replace(/^(\S+)$/, name => (name === directory ? '.' : name));
      const marker = {error: red(G.fail), skip: yellow(G.warn), add: dim(G.wait), ok: green(G.ok), wrote: green(G.ok)}[verb];
      const paint = verb === 'error' ? red : verb === 'skip' ? yellow : text => text;
      return wrap(what, t.bodyRoom()).map((part, i) => cells('', i === 0 ? marker : '', paint(part)));
    });
    let dry;
    try { dry = capture(); adopt({...options, 'dry-run': true}, cwd, dry.log, {env}); } catch (error) {
      return finish([...section(divider(`${red(G.fail)} ${bold(red('This firebase.json cannot be read'))}`), field(dim('Problem'), error.message).map(inside)), bottom(), ''], 1);
    }
    const errors = dry.lines.some(text => /^ {2}error /.test(text));
    const additions = dry.lines.filter(text => /^ {2}add /.test(text)).length;
    const heading = divider(bold('This folder has a firebase.json'));
    const intro = field(dim('Check'), errors ? 'Firenook cannot start this project until these are fixed:' : additions ? 'Firenook can start it once these are added; nothing that is there changes:' : 'Firenook can start it as it is.', dim);
    const report = [heading, ...t.air(), ...[...intro, ...findings(dry.lines)].map(inside), ...t.air()];
    const startLine = `npx firenook emulators:start${options.config ? ` --config ${options.config}` : ''}`;
    if (errors || !additions) {
      return finish([...report, ...section(divider(bold('Next')), (errors ? field(dim('Fix'), 'fix firebase.json as each line says, then run npx firenook init again', dim)
        : [cells(dim('Start'), '', bold(startLine)), ...field('', '--keep-data keeps the data between runs', dim)]).map(inside)), bottom(), ''], errors ? 1 : 0);
    }
    screen.emit(() => report);
    const yes = await ask(`Add ${additions === 1 ? 'it' : `these ${additions}`}?`, {above: [bottom()], hint: 'npx firenook init --adopt adds them the same way'});
    if (!yes) return finish([bottom(), '', ...note('Nothing was changed.'), ''], yes === undefined ? 130 : 0);
    const applied = capture();
    const code = adopt(options, cwd, applied.log, {env});
    const wrote = findings(applied.lines.filter(text => /^ {2}(wrote|error) /.test(text)));
    return finish([...section(divider(bold(code ? 'Not added' : 'Added')), wrote.map(inside)),
      ...section(divider(bold('Next')), [cells(dim('Start'), '', bold(startLine)), ...field('', '--keep-data keeps the data between runs', dim)].map(inside)), bottom(), ''], code);
  }
}
