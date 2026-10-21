// init: scaffold a new project, or (--adopt) adapt an existing firebase.json
// with the same checks the launcher applies. In a terminal the screen in
// `init-screen.mjs` asks first; the files are the same either way.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_PORTS, inspectProject, readJson, validProjectId } from './options.mjs';
import { PROJECT_AGENTS, applyAgents, planAgents } from './agents.mjs';
import { enclosingPackage, nextSteps, setUpSteps } from './setup.mjs';
import { manifest } from './binary.mjs';

// The official `firebase init` port defaults, written explicitly.
export const INIT_PORTS = Object.fromEntries(['auth', 'functions', 'firestore', 'pubsub', 'storage', 'eventarc', 'tasks', 'hub', 'logging', 'ui'].map(name => [name, DEFAULT_PORTS[name]]));
const FUNCTIONS_IGNORE = ['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local'];
const GITIGNORE_LINES = ['.firenook/', '*-debug.log'];

// The official `firebase init firestore` template: open for thirty days, then
// closed until real rules are written.
export function firestoreRules(now = new Date()) {
  const date = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const stamp = `${date.getFullYear()}, ${date.getMonth() + 1}, ${date.getDate()}`;
  return `rules_version='2'

service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      // This rule allows anyone with your database reference to view, edit,
      // and delete all data in your database. It is useful for getting
      // started, but it is configured to expire after 30 days because it
      // leaves your app open to attackers. At that time, all client
      // requests to your database will be denied.
      //
      // Make sure to write security rules for your app before that time, or
      // else all client requests to your database will be denied until you
      // update your rules.
      allow read, write: if request.time < timestamp.date(${stamp});
    }
  }
}
`;
}
// The official `firebase init storage` template: locked.
export const STORAGE_RULES = `rules_version = '2';

// Craft rules based on data in your Firestore database
// allow write: if firestore.get(
//    /databases/(default)/documents/users/$(request.auth.uid)).data.isAdmin;
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
`;
export const INDEXES = '{\n  "indexes": [],\n  "fieldOverrides": []\n}\n';
const FUNCTIONS_INDEX = `const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");

// https://firebase.google.com/docs/functions/get-started
exports.helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});
`;
const FUNCTIONS_TS_INDEX = `import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";

// https://firebase.google.com/docs/functions/typescript
export const helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});
`;
// The official `firebase init functions` TypeScript configuration.
const TSCONFIG = {compilerOptions:{module:'NodeNext', esModuleInterop:true, moduleResolution:'nodenext', noImplicitReturns:true, noUnusedLocals:true,
  outDir:'lib', rootDir:'src', sourceMap:true, strict:true, target:'es2017'}, compileOnSave:true, include:['src']};
const DEPENDENCIES = {'firebase-admin':'^13.0.0', 'firebase-functions':'^7.0.0'};
const functionsPackage = typescript => `${JSON.stringify(typescript
  ? {name:'functions', description:'Cloud Functions for Firebase', main:'lib/index.js',
    scripts:{build:'tsc', 'build:watch':'tsc --watch', serve:'firenook emulators:start --only functions --build'},
    engines:{node:'24'}, dependencies:DEPENDENCIES, devDependencies:{typescript:'^7.0.0'}, private:true}
  : {name:'functions', description:'Cloud Functions for Firebase', main:'index.js',
    scripts:{serve:'firenook emulators:start --only functions'},
    engines:{node:'24'}, dependencies:DEPENDENCIES, private:true}, null, 2)}\n`;

export const sanitizeProjectId = name => {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return /^demo-[a-z0-9]/.test(cleaned) ? cleaned : `demo-${cleaned || 'project'}`;
};
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function gitignoreAddition(directory) {
  const path = join(directory, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map(line => line.trim()));
  const missing = GITIGNORE_LINES.filter(line => !present.has(line));
  if (!missing.length) return undefined;
  const content = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  return {path, content:`${content}${missing.join('\n')}\n`, description:`append ${missing.join(', ')}`};
}

function writePlan(plan, log, quiet) {
  for (const file of plan) {
    if (file.skip) { if (!quiet) log.error(`  keep    ${file.path} (exists)`); continue; }
    mkdirSync(dirname(file.path), {recursive:true});
    writeFileSync(file.path, file.content);
    if (!quiet) log.error(`  wrote   ${file.path}`);
  }
}

// The coding agents a new project uses, as one sentence: "Claude Code and Cursor".
export const agentNames = steps => steps.map(step => step.name).join(steps.length > 2 ? ', ' : ' and ').replace(/, ([^,]+)$/, ' and $1');

// What a new project's Functions are written in.
export const LANGUAGES = ['typescript', 'javascript', 'none'];
// The emulators init sets up besides Functions, which the language decides;
// Cloud Tasks and Eventarc come with Functions, the hub and the console log
// always.
export const INIT_EMULATORS = ['firestore', 'auth', 'storage', 'pubsub', 'ui'];
// --only names the data services; as with emulators:start, the console and
// what follows Functions come along.
const ONLY = ['firestore', 'auth', 'functions', 'storage', 'pubsub'];
const FOLLOWERS = ['extensions', 'tasks', 'eventarc', 'hub', 'logging', 'ui'];

// The project id a new project gets: --project, an existing .firebaserc
// default (the file is never overwritten), or demo-<folder>.
export function projectFor(options, directory) {
  const rcPath = join(directory, '.firebaserc');
  let recorded;
  if (existsSync(rcPath)) { try { recorded = readJson(rcPath)?.projects?.default; } catch { recorded = undefined; } }
  return options.project || (validProjectId(recorded) ? recorded : sanitizeProjectId(basename(directory)));
}
export const invalidProjectId = project => `Invalid project id ${project}: use lowercase letters, digits and hyphens (6 to 30 characters, starting with a letter), or a demo- prefix.`;

// What init sets up, from the options: the project id, the Functions
// language, the emulators, the coding agents given the MCP server (those it
// finds), and whether to install the packages and pin Firenook in
// package.json (with --yes; the terminal asks). The screen starts from
// these and lets each be changed.
export function initChoices(options, directory, {env = process.env, home} = {}) {
  const project = projectFor(options, directory);
  let language = options.language ?? (options['no-functions'] ? 'none' : 'typescript');
  if (!LANGUAGES.includes(language)) throw new Error(`--language takes ${LANGUAGES.join(', ')}, not ${language}`);
  if (options['no-functions'] && options.language && options.language !== 'none') throw new Error('--no-functions and --language are exclusive');
  let emulators = new Set(INIT_EMULATORS);
  if (options.only !== undefined) {
    const names = String(options.only).split(',').map(name => name.trim()).filter(Boolean);
    emulators = new Set([...names.filter(name => INIT_EMULATORS.includes(name)), 'ui']);
    const unknown = names.find(name => !ONLY.includes(name) && !FOLLOWERS.includes(name));
    if (unknown) throw new Error(`${unknown} is not an emulator firenook init sets up; --only takes ${ONLY.join(', ')}`);
    if (!names.some(name => name === 'functions' || name === 'extensions')) {
      if (options.language && options.language !== 'none') throw new Error(`--language ${options.language} needs functions in --only`);
      language = 'none';
    }
  }
  if (![...emulators].some(name => name !== 'ui') && language === 'none') throw new Error('Nothing to set up: --only names no emulator and there are no Functions');
  let agents;
  if (options.agent) {
    agents = String(options.agent).split(',').map(item => item.trim()).filter(Boolean);
    const unknown = agents.find(id => !PROJECT_AGENTS.some(agent => agent.id === id));
    if (unknown) throw new Error(`Unknown agent ${unknown}; --agent takes ${PROJECT_AGENTS.map(agent => agent.id).join(', ')}`);
  } else agents = planAgents(directory, {env}).filter(step => step.action !== 'keep').map(step => step.agent);
  const setUp = Boolean(options.yes);
  return {project, language, emulators, agents, install:setUp && !options['no-install'], pin:setUp && !options['no-pin'] && !enclosingPackage(directory, home)};
}

// The files a scaffold writes for these choices, and the firebase.json it
// holds. Existing files are kept, unless --force.
export function scaffoldPlan(choices, config, {force = false} = {}) {
  const directory = dirname(config);
  if (!validProjectId(choices.project)) throw new Error(invalidProjectId(choices.project));
  const functions = choices.language !== 'none';
  const typescript = choices.language === 'typescript';
  const has = name => choices.emulators.has(name);
  const emulators = {};
  for (const name of ['auth', 'functions', 'firestore', 'pubsub', 'storage']) if (name === 'functions' ? functions : has(name)) emulators[name] = {port:INIT_PORTS[name]};
  for (const name of ['eventarc', 'tasks']) if (functions) emulators[name] = {port:INIT_PORTS[name]};
  emulators.hub = {port:INIT_PORTS.hub};
  emulators.logging = {port:INIT_PORTS.logging};
  emulators.ui = {enabled:has('ui'), port:INIT_PORTS.ui};
  emulators.singleProjectMode = true;
  const firebase = {};
  if (has('firestore')) firebase.firestore = {rules:'firestore.rules', indexes:'firestore.indexes.json'};
  if (has('storage')) firebase.storage = {rules:'storage.rules'};
  // A deploy builds a TypeScript codebase first, as the official init sets it up.
  if (functions) firebase.functions = {source:'functions', codebase:'default', ignore:FUNCTIONS_IGNORE, ...(typescript ? {predeploy:['npm --prefix "$RESOURCE_DIR" run build']} : {})};
  firebase.emulators = emulators;
  const file = (path, content) => ({path:join(directory, path), content, skip:existsSync(join(directory, path)) && !force});
  // An existing .firebaserc keeps everything it holds; only a project chosen
  // other than its default becomes the default.
  let rc = file('.firebaserc', json({projects:{default:choices.project}}));
  if (rc.skip) {
    let data;
    try { data = readJson(rc.path); } catch { data = undefined; }
    if (data && typeof data === 'object' && !Array.isArray(data) && data.projects?.default !== choices.project) {
      rc = {path:rc.path, content:json({...data, projects:{...(data.projects && typeof data.projects === 'object' ? data.projects : {}), default:choices.project}}), skip:false};
    }
  }
  const plan = [{path:config, content:json(firebase), skip:false}, rc];
  if (has('firestore')) plan.push(file('firestore.rules', firestoreRules()), file('firestore.indexes.json', INDEXES));
  if (has('storage')) plan.push(file('storage.rules', STORAGE_RULES));
  if (typescript) {
    plan.push(file('functions/package.json', functionsPackage(true)), file('functions/tsconfig.json', json(TSCONFIG)), file('functions/src/index.ts', FUNCTIONS_TS_INDEX),
      file('functions/.gitignore', 'node_modules/\nlib/\n*.local\n'));
  } else if (functions) plan.push(file('functions/package.json', functionsPackage(false)), file('functions/index.js', FUNCTIONS_INDEX), file('functions/.gitignore', 'node_modules/\n*.local\n'));
  const gitignore = gitignoreAddition(directory);
  if (gitignore) plan.push({path:gitignore.path, content:gitignore.content, skip:false});
  return {directory, firebase, plan};
}
export const writeScaffold = (plan, log = console, quiet = true) => writePlan(plan, log, quiet);

// init [--force] [--dry-run] [--project ID] [--language typescript|javascript|none]
//   [--only firestore,auth,functions,...] [--agent claude,cursor,vscode] [--yes [--no-install] [--no-pin]]
// Without a terminal this writes the files, and with --yes sets the project
// up the way the terminal screen (`init-screen.mjs`) does once its choices
// are made: the coding agents' MCP files, Firenook pinned in package.json,
// the packages installed and a TypeScript codebase built. Otherwise the
// commands that do so are printed.
export function scaffold(options, cwd = process.cwd(), log = console, {env = process.env, home, version = manifest.version, platform = process.platform, spawner} = {}) {
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  if (existsSync(config) && !options.force) throw new Error(`${config} exists; use firenook init --adopt to adapt it, or --force to overwrite the scaffold files`);
  const choices = initChoices(options, directory, {env, home});
  if (!validProjectId(choices.project)) throw new Error(invalidProjectId(choices.project));
  const {plan} = scaffoldPlan(choices, config, {force:Boolean(options.force)});
  const functions = choices.language !== 'none';
  const dry = Boolean(options['dry-run']);
  const offered = planAgents(directory, {agents:choices.agents, config, env}).filter(step => step.content);
  const setUp = setUpSteps(choices, directory, {version, config, env, platform, spawner});
  const next = () => {
    const lines = nextSteps(choices, setUp.steps, {manager:setUp.manager, platform}).map(line => line.command);
    if (offered.length && !options.yes) lines.push(`npx firenook mcp add   (gives ${agentNames(offered)} the Firenook MCP server)`);
    return lines;
  };
  if (options.json) log.log(JSON.stringify({directory, project:choices.project, functions, language:choices.language, emulators:[...choices.emulators],
    files:plan.map(item => ({path:item.path, action:item.skip ? 'keep' : 'write'})), agents:offered.map(({agent, path}) => ({agent, path})),
    install:choices.install, pin:choices.pin, applied:!dry, next:next()}));
  else {
    log.error(`Firenook init: project ${choices.project} in ${directory}${dry ? ' (dry run, nothing written)' : ''}`);
    if (dry) for (const item of plan) log.error(`  ${item.skip ? 'keep ' : 'write'}   ${item.path}`);
    if (dry) for (const step of offered) log.error(`  offer   ${step.path} (${step.name}: the Firenook MCP server)`);
  }
  if (dry) return 0;
  writePlan(plan, log, Boolean(options.json));
  const finish = ok => {
    if (!options.json) { log.error('Next steps:'); for (const step of next()) log.error(`  ${step}`); }
    return ok ? 0 : 1;
  };
  if (!options.yes) return finish(true);
  // --yes: the set-up, one line a step as each ends.
  const quiet = Boolean(options.json);
  return setUp.run(step => {
    if (quiet || !step || step.state === 'running' || step.state === 'waiting') return;
    const verb = {done:'done   ', failed:'failed ', skipped:'skipped'}[step.state];
    log.error(`  ${verb} ${step.label}: ${step.detail}${step.ms != null ? ` (${(step.ms / 1000).toFixed(1)} s)` : ''}`);
    for (const note of step.notes ?? []) log.error(`          ${note}`);
    if (step.state === 'failed') for (const line of step.tail ?? []) log.error(`          ${line}`);
  }).then(({ok}) => finish(ok));
}

// Adds a rules/indexes file referenced by firebase.json when it is missing.
function referencedFiles(data, directory) {
  const files = [];
  const seen = new Set();
  const add = (path, content, kind) => {
    if (typeof path !== 'string' || !path) return;
    const absolute = resolve(directory, path);
    if (existsSync(absolute) || seen.has(absolute)) return;
    seen.add(absolute);
    files.push({path:absolute, content, description:`write ${kind} (official init template)`});
  };
  for (const entry of Array.isArray(data.firestore) ? data.firestore : [data.firestore]) {
    if (!entry || typeof entry !== 'object') continue;
    add(entry.rules, firestoreRules(), 'Firestore rules');
    add(entry.indexes, INDEXES, 'Firestore indexes');
  }
  for (const entry of Array.isArray(data.storage) ? data.storage : [data.storage]) {
    if (!entry || typeof entry !== 'object') continue;
    add(entry.rules, STORAGE_RULES, 'Storage rules');
  }
  return files;
}

// init --adopt [--dry-run] [--project ID]: collect every launcher finding, then
// apply only additions (never rewriting existing keys) when nothing blocks.
export function adopt(options, cwd = process.cwd(), log = console, {env = process.env} = {}) {
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  if (!existsSync(config)) throw new Error(`${config} does not exist; run firenook init without --adopt to scaffold a project`);
  const inspection = inspectProject(options, cwd);
  const errors = inspection.errors.filter(error => error.code !== 'project-missing').map(error => error.message);
  const warnings = inspection.warnings;
  const additions = [];
  const data = readJson(config);
  const emulators = data.emulators && typeof data.emulators === 'object' && !Array.isArray(data.emulators) ? data.emulators : undefined;
  const emulatorEntries = {};
  for (const name of inspection.configured) {
    if (emulators && Object.hasOwn(emulators, name)) continue;
    emulatorEntries[name] = {port:INIT_PORTS[name]};
    additions.push({kind:'firebase.json', target:`emulators.${name}`, value:emulatorEntries[name], description:`add emulators.${name} {port: ${INIT_PORTS[name]}}`});
  }
  // A missing .firebaserc default is an addition even when --project is given.
  const rcExists = existsSync(inspection.rc);
  const rcData = rcExists ? readJson(inspection.rc) : {};
  const projectMissing = !(rcData.projects && typeof rcData.projects === 'object' && typeof rcData.projects.default === 'string' && rcData.projects.default);
  const project = projectMissing ? (options.project || sanitizeProjectId(basename(directory))) : inspection.project;
  if (projectMissing) additions.push({kind:'.firebaserc', target:'projects.default', value:project, description:`set .firebaserc projects.default = ${project}${rcExists ? '' : ' (create the file)'}`});
  const files = referencedFiles(data, directory);
  for (const file of files) additions.push({kind:'file', target:file.path, description:`${file.description}: ${file.path}`});
  // The coding agents the project uses get the MCP server, as firenook mcp add does.
  const agents = planAgents(directory, {config, env});
  for (const step of agents.filter(step => step.content)) additions.push({kind:'agent', target:step.path, agent:step.agent, description:`give ${step.name} the Firenook MCP server: ${step.path}`});
  for (const step of agents.filter(step => step.action === 'differs')) warnings.push(`${step.path} already has another firenook entry for ${step.name}; firenook mcp add --force replaces it`);
  for (const step of agents.filter(step => step.action === 'unreadable')) warnings.push(`${step.path} is not plain JSON, so ${step.name} gets no MCP server from init; add this by hand: ${step.snippet}`);
  const apply = !options['dry-run'] && !options.json && !errors.length;
  if (options.json) {
    log.log(JSON.stringify({config, project, services:inspection.services, errors, warnings, additions:additions.map(({description, ...rest}) => rest), applied:false}));
  } else {
    log.error(`Firenook init --adopt: ${config}`);
    for (const message of errors) log.error(`  error   ${message}`);
    for (const message of warnings) log.error(`  skip    ${message}`);
    for (const addition of additions) log.error(`  add     ${addition.description}`);
    if (!errors.length && !additions.length) log.error(`  ok      nothing to change; services: ${inspection.services.join(', ')}`);
  }
  if (apply && additions.length) {
    if (Object.keys(emulatorEntries).length) {
      if (!data.emulators || typeof data.emulators !== 'object' || Array.isArray(data.emulators)) data.emulators = {};
      Object.assign(data.emulators, emulatorEntries);
      writeFileSync(config, json(data));
      log.error(`  wrote   ${config}`);
    }
    if (projectMissing) {
      if (!rcData.projects || typeof rcData.projects !== 'object' || Array.isArray(rcData.projects)) rcData.projects = {};
      rcData.projects.default = project;
      writeFileSync(inspection.rc, json(rcData));
      log.error(`  wrote   ${inspection.rc}`);
    }
    for (const file of files) { mkdirSync(dirname(file.path), {recursive:true}); writeFileSync(file.path, file.content); log.error(`  wrote   ${file.path}`); }
    const written = agents.filter(step => step.content);
    applyAgents(written);
    for (const step of written) log.error(`  wrote   ${step.path}`);
  } else if (!options.json && errors.length) log.error('Fix the errors above, then re-run firenook init --adopt; nothing was written.');
  else if (!options.json && options['dry-run'] && additions.length) log.error('Dry run: nothing was written.');
  return errors.length ? 1 : 0;
}
