// init: scaffold a new project, or (--adopt) adapt an existing firebase.json
// with the same checks the launcher applies. Nothing is installed or fetched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_PORTS, inspectProject, readJson, validProjectId } from './options.mjs';

// The official `firebase init` port defaults, written explicitly.
export const INIT_PORTS = Object.fromEntries(['auth', 'functions', 'firestore', 'pubsub', 'storage', 'eventarc', 'tasks', 'hub', 'logging', 'ui'].map(name => [name, DEFAULT_PORTS[name]]));
const FUNCTIONS_IGNORE = ['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local'];
const GITIGNORE_LINES = ['.fireside/', '*-debug.log'];

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
const functionsPackage = () => `${JSON.stringify({
  name:'functions', description:'Cloud Functions for Firebase', main:'index.js',
  scripts:{serve:'fireside emulators:start --only functions'},
  engines:{node:'24'},
  dependencies:{'firebase-admin':'^13.0.0', 'firebase-functions':'^7.0.0'},
  private:true,
}, null, 2)}\n`;

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

// init [--force] [--dry-run] [--project ID] [--no-functions]
export function scaffold(options, cwd = process.cwd(), log = console) {
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  if (existsSync(config) && !options.force) throw new Error(`${config} exists; use fireside init --adopt to adapt it, or --force to overwrite the scaffold files`);
  // An existing .firebaserc default is kept (the file is never overwritten).
  const rcPath = join(directory, '.firebaserc');
  let recorded;
  if (existsSync(rcPath)) { try { recorded = readJson(rcPath)?.projects?.default; } catch { recorded = undefined; } }
  const project = options.project || (validProjectId(recorded) ? recorded : sanitizeProjectId(basename(directory)));
  if (!validProjectId(project)) throw new Error(`Invalid project id ${project}: use lowercase letters, digits and hyphens (6 to 30 characters, starting with a letter), or a demo- prefix.`);
  const functions = !options['no-functions'];
  const emulators = {};
  for (const name of ['auth', 'functions', 'firestore', 'pubsub', 'storage']) if (functions || name !== 'functions') emulators[name] = {port:INIT_PORTS[name]};
  for (const name of ['eventarc', 'tasks']) if (functions) emulators[name] = {port:INIT_PORTS[name]};
  emulators.hub = {port:INIT_PORTS.hub};
  emulators.logging = {port:INIT_PORTS.logging};
  emulators.ui = {enabled:true, port:INIT_PORTS.ui};
  emulators.singleProjectMode = true;
  const firebase = {firestore:{rules:'firestore.rules', indexes:'firestore.indexes.json'}, storage:{rules:'storage.rules'}};
  if (functions) firebase.functions = {source:'functions', codebase:'default', ignore:FUNCTIONS_IGNORE};
  firebase.emulators = emulators;
  const file = (path, content) => ({path:join(directory, path), content, skip:existsSync(join(directory, path)) && !options.force});
  const plan = [
    {path:config, content:json(firebase), skip:false},
    file('.firebaserc', json({projects:{default:project}})),
    file('firestore.rules', firestoreRules()),
    file('firestore.indexes.json', INDEXES),
    file('storage.rules', STORAGE_RULES),
  ];
  if (functions) plan.push(file('functions/package.json', functionsPackage()), file('functions/index.js', FUNCTIONS_INDEX), file('functions/.gitignore', 'node_modules/\n*.local\n'));
  const gitignore = gitignoreAddition(directory);
  if (gitignore) plan.push({path:gitignore.path, content:gitignore.content, skip:false});
  const next = [...(functions ? ['cd functions && npm install'] : []), 'fireside setup', `fireside emulators:start --project ${project}`];
  const dry = Boolean(options['dry-run']);
  if (options.json) log.log(JSON.stringify({directory, project, functions, files:plan.map(item => ({path:item.path, action:item.skip ? 'keep' : 'write'})), applied:!dry, next}));
  else {
    log.error(`Fireside init: project ${project} in ${directory}${dry ? ' (dry run, nothing written)' : ''}`);
    if (dry) for (const item of plan) log.error(`  ${item.skip ? 'keep ' : 'write'}   ${item.path}`);
  }
  if (dry) return 0;
  writePlan(plan, log, Boolean(options.json));
  if (!options.json) { log.error('Next steps:'); for (const step of next) log.error(`  ${step}`); }
  return 0;
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
export function adopt(options, cwd = process.cwd(), log = console) {
  const config = resolve(cwd, options.config || 'firebase.json');
  const directory = dirname(config);
  if (!existsSync(config)) throw new Error(`${config} does not exist; run fireside init without --adopt to scaffold a project`);
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
  const apply = !options['dry-run'] && !options.json && !errors.length;
  if (options.json) {
    log.log(JSON.stringify({config, project, services:inspection.services, errors, warnings, additions:additions.map(({description, ...rest}) => rest), applied:false}));
  } else {
    log.error(`Fireside init --adopt: ${config}`);
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
  } else if (!options.json && errors.length) log.error('Fix the errors above, then re-run fireside init --adopt; nothing was written.');
  else if (!options.json && options['dry-run'] && additions.length) log.error('Dry run: nothing was written.');
  return errors.length ? 1 : 0;
}
