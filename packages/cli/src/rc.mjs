// .firebaserc edits: project aliases (`use`) and Storage deploy targets
// (`target:apply`, `target:clear`). Pure file edits in the configuration
// directory; no network, no login.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UNIMPLEMENTED, validProjectId } from './options.mjs';

const TARGET_TYPES = {storage:'bucket', database:'instance', hosting:'site'};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const rcPath = (options, cwd = process.cwd()) => join(dirname(resolve(cwd, options.config || 'firebase.json')), '.firebaserc');

export function readRc(path) {
  if (!existsSync(path)) return {};
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`${path} is not valid JSON: ${error.message}`); }
  if (!isObject(data)) throw new Error(`${path} must contain a JSON object`);
  return data;
}
export const writeRc = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

const projects = rc => (isObject(rc.projects) ? rc.projects : (rc.projects = {}));
const assertId = id => { if (!validProjectId(id)) throw new Error(`Invalid project id ${id}: use lowercase letters, digits and hyphens (6 to 30 characters, starting with a letter), or a demo- prefix.`); };

function listAliases(rc, path, log) {
  const entries = Object.entries(projects(rc));
  const active = projects(rc).default;
  if (!entries.length) { log.log(`No project aliases in ${path}.`); }
  else {
    log.log(`Project aliases in ${path}:`);
    for (const [alias, id] of entries) log.log(`${id === active ? '*' : ' '} ${alias} (${id})`);
  }
  log.log(active ? `Active project: ${active}` : 'No active project (projects.default is unset).');
  log.log('Run firenook use --add <projectId> --alias <name> to define an alias, firenook use <alias|projectId> to activate one.');
}

// use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]
export function use(selection, options, cwd = process.cwd(), log = console) {
  const path = rcPath(options, cwd);
  const rc = readRc(path);
  const table = projects(rc);
  const modes = ['add', 'unalias', 'clear'].filter(name => options[name] !== undefined);
  if (modes.length > 1 || (modes.length && selection)) throw new Error('use takes one of: an alias or project id, --add, --unalias, --clear');
  if (options.alias !== undefined && !selection && options.add === undefined) throw new Error('--alias needs the project id: firenook use --add <projectId> --alias <name>');
  if (options.add !== undefined) {
    assertId(options.add);
    const alias = options.alias || 'default';
    table[alias] = options.add;
    writeRc(path, rc);
    log.log(`Created alias ${alias} for ${options.add} in ${path}.`);
    if (alias === 'default') log.log(`Now using project ${options.add}`);
    return 0;
  }
  if (options.unalias !== undefined) {
    if (!Object.hasOwn(table, options.unalias)) { log.log(`No alias ${options.unalias} in ${path}; nothing changed.`); return 0; }
    delete table[options.unalias];
    writeRc(path, rc);
    log.log(`Removed alias ${options.unalias}`);
    listAliases(rc, path, log);
    return 0;
  }
  if (options.clear) {
    delete table.default;
    writeRc(path, rc);
    log.log('Cleared active project.');
    listAliases(rc, path, log);
    return 0;
  }
  if (selection) {
    const aliased = Object.hasOwn(table, selection);
    const id = aliased ? table[selection] : selection;
    assertId(id);
    if (options.alias !== undefined) { table[options.alias] = id; log.log(`Created alias ${options.alias} for ${id}.`); }
    table.default = id;
    writeRc(path, rc);
    log.log(aliased ? `Now using alias ${selection} (${id})` : `Now using project ${id} (recorded as a project id, not an alias)`);
    return 0;
  }
  if (options.json) { log.log(JSON.stringify({path, projects:table, active:table.default ?? null})); return 0; }
  listAliases(rc, path, log);
  return 0;
}

// The project key targets are stored under: --project or the active default.
function targetProject(rc, options) {
  const table = projects(rc);
  const selection = options.project || table.default;
  const id = (selection !== undefined && table[selection]) || selection;
  if (!id) throw new Error('Must have an active project to set deploy targets. Try firenook use --add <projectId>, or pass --project');
  assertId(id);
  return id;
}
function assertType(type) {
  if (!TARGET_TYPES[type]) throw new Error(`Unrecognized target type ${type}. Must be one of ${Object.keys(TARGET_TYPES).join(', ')}`);
  if (UNIMPLEMENTED.includes(type)) throw new Error(`${type} targets are not implemented by Firenook (roadmap); only storage targets are consulted.`);
}
const targetsOf = (rc, project, type) => {
  if (!isObject(rc.targets)) rc.targets = {};
  if (!isObject(rc.targets[project])) rc.targets[project] = {};
  if (!isObject(rc.targets[project][type])) rc.targets[project][type] = {};
  return rc.targets[project][type];
};

// Mirrors the official applyTarget: a resource leaves any other target of the
// same type first; the target's list is deduplicated and sorted.
export function applyTarget(rc, project, type, name, resources) {
  const table = targetsOf(rc, project, type);
  const changed = [];
  for (const resource of resources) {
    for (const [other, list] of Object.entries(table)) {
      if (other === name || !Array.isArray(list) || !list.includes(resource)) continue;
      const remaining = list.filter(item => item !== resource);
      if (remaining.length) table[other] = remaining; else delete table[other];
      changed.push({resource, target:other});
    }
  }
  table[name] = [...new Set([...(Array.isArray(table[name]) ? table[name] : []), ...resources])].sort();
  return changed;
}
export function clearTarget(rc, project, type, name) {
  const table = targetsOf(rc, project, type);
  if (!Array.isArray(table[name]) || !table[name].length) return false;
  delete table[name];
  return true;
}

// target:apply <type> <name> <resource...>
export function targetApply([type, name, ...resources], options, cwd = process.cwd(), log = console) {
  if (!type || !name || !resources.length) throw new Error('target:apply needs a type, a target name and at least one resource: firenook target:apply storage <target> <bucket>...');
  assertType(type);
  const path = rcPath(options, cwd);
  const rc = readRc(path);
  const project = targetProject(rc, options);
  const changed = applyTarget(rc, project, type, name, resources);
  writeRc(path, rc);
  log.log(`Applied ${type} target ${name} to ${resources.join(', ')} for ${project}`);
  for (const change of changed) log.log(`Previous target ${change.target} removed from ${change.resource}`);
  log.log(`Updated: ${name} (${rc.targets[project][type][name].join(',')})`);
  return 0;
}
// target:clear <type> <name>
export function targetClear([type, name, ...extra], options, cwd = process.cwd(), log = console) {
  if (!type || !name || extra.length) throw new Error('target:clear needs a type and a target name: firenook target:clear storage <target>');
  assertType(type);
  const path = rcPath(options, cwd);
  const rc = readRc(path);
  const project = targetProject(rc, options);
  const existed = clearTarget(rc, project, type, name);
  if (existed) { writeRc(path, rc); log.log(`Cleared ${type} target ${name} for ${project}`); }
  else log.log(`No action taken. No ${type} target found named ${name} for ${project}`);
  return 0;
}
