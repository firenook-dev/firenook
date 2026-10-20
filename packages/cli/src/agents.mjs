// firenook mcp add: writes the MCP server entry into the project files of
// the coding agents a project uses, so every teammate's agent has it once the
// files are committed. The entry is `npx firenook mcp` with no project id
// (the server reads firebase.json, or finds the one running suite). Only
// files inside the project are written; an agent configured in the home
// folder gets the line printed instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const found = (directory, ...names) => names.some(name => existsSync(join(directory, name)));

// A program on PATH, without running it.
export function onPath(program, env = process.env, platform = process.platform) {
  const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH || '').split(delimiter).filter(Boolean).some(folder => extensions.some(extension => existsSync(join(folder, `${program}${extension}`))));
}

// The agents whose MCP configuration can live in the project, each with its
// file, the key that holds the servers and how a project shows it uses it.
export const PROJECT_AGENTS = [
  {id:'claude', name:'Claude Code', file:'.mcp.json', key:'mcpServers', stdio:false,
    detect:(directory, env) => found(directory, '.claude', '.mcp.json', 'CLAUDE.md') || onPath('claude', env)},
  {id:'cursor', name:'Cursor', file:join('.cursor', 'mcp.json'), key:'mcpServers', stdio:false,
    detect:directory => found(directory, '.cursor', '.cursorrules')},
  {id:'vscode', name:'VS Code', file:join('.vscode', 'mcp.json'), key:'servers', stdio:true,
    detect:directory => found(directory, '.vscode')},
];
// Agents configured only in the home folder: the line to use, never a file
// edited outside the project.
const HOME_AGENTS = [
  {name:'Codex', detect:env => onPath('codex', env), line:args => `codex mcp add firenook -- ${args.join(' ')}`},
  {name:'Windsurf', detect:(env, home) => Boolean(home) && existsSync(join(home, '.codeium', 'windsurf')),
    line:args => `add to ~/.codeium/windsurf/mcp_config.json: ${JSON.stringify({mcpServers:{firenook:{command:args[0], args:args.slice(1)}}})}`},
];

// The command the agents run: `npx firenook mcp`, plus --config when the
// files go somewhere other than beside firebase.json.
export function serverCommand(directory, config) {
  const args = ['npx', 'firenook', 'mcp'];
  if (config && dirname(config) !== directory) args.push('--config', relative(directory, config).split('\\').join('/'));
  return args;
}
const entryFor = (agent, command) => ({...(agent.stdio ? {type:'stdio'} : {}), command:command[0], args:command.slice(1)});

// What `mcp add` would do in `directory`: one step per agent, each `add`,
// `keep` (already set), `differs` (another firenook entry; --force replaces
// it) or `unreadable` (not plain JSON, such as a file with comments).
export function planAgents(directory, {agents, config, force = false, env = process.env} = {}) {
  let selected;
  if (agents?.length) {
    const unknown = agents.filter(id => !PROJECT_AGENTS.some(agent => agent.id === id));
    if (unknown.length) throw new Error(`Unknown agent ${unknown[0]}; --agent takes ${PROJECT_AGENTS.map(agent => agent.id).join(', ')}`);
    selected = PROJECT_AGENTS.filter(agent => agents.includes(agent.id));
  } else selected = PROJECT_AGENTS.filter(agent => agent.detect(directory, env));
  const command = serverCommand(directory, config);
  return selected.map(agent => {
    const path = join(directory, agent.file);
    const entry = entryFor(agent, command);
    if (!existsSync(path)) return {agent:agent.id, name:agent.name, path, action:'add', content:json({[agent.key]:{firenook:entry}})};
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { data = undefined; }
    const servers = data?.[agent.key];
    if (!data || typeof data !== 'object' || Array.isArray(data) || (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers)))) {
      return {agent:agent.id, name:agent.name, path, action:'unreadable', snippet:JSON.stringify({[agent.key]:{firenook:entry}})};
    }
    const current = servers?.firenook;
    if (current !== undefined && isDeepStrictEqual(current, entry)) return {agent:agent.id, name:agent.name, path, action:'keep'};
    if (current !== undefined && !force) return {agent:agent.id, name:agent.name, path, action:'differs', current};
    return {agent:agent.id, name:agent.name, path, action:current === undefined ? 'add' : 'replace', content:json({...data, [agent.key]:{...servers, firenook:entry}})};
  });
}

export function applyAgents(plan) {
  for (const step of plan) {
    if (!step.content) continue;
    mkdirSync(dirname(step.path), {recursive:true});
    writeFileSync(step.path, step.content);
  }
}

export function homeAgentLines(directory, config, {env = process.env, home = env.HOME || env.USERPROFILE} = {}) {
  const command = serverCommand(directory, config);
  return HOME_AGENTS.filter(agent => agent.detect(env, home)).map(agent => ({name:agent.name, line:agent.line(command)}));
}

const VERB = {add:'add    ', replace:'replace', keep:'keep   ', differs:'keep   ', unreadable:'skip   '};
export function describeStep(step, directory) {
  const path = relative(directory, step.path) || step.path;
  if (step.action === 'keep') return `${VERB.keep} ${path} (${step.name}: already set)`;
  if (step.action === 'differs') return `${VERB.differs} ${path} (${step.name}: it has another firenook entry; --force replaces it)`;
  if (step.action === 'unreadable') return `${VERB.unreadable} ${path} (${step.name}: not plain JSON; add this by hand: ${step.snippet})`;
  return `${VERB[step.action]} ${path} (${step.name})`;
}

// firenook mcp add [--agent claude,cursor,vscode] [--dry-run] [--force] [--json]
export function mcpAdd(options, cwd = process.cwd(), log = console, env = process.env) {
  const directory = resolve(cwd);
  const config = options.config ? resolve(cwd, options.config) : existsSync(join(directory, 'firebase.json')) ? join(directory, 'firebase.json') : undefined;
  const agents = options.agent ? String(options.agent).split(',').map(item => item.trim()).filter(Boolean) : undefined;
  const plan = planAgents(directory, {agents, config, force:Boolean(options.force), env});
  const home = homeAgentLines(directory, config, {env});
  const dry = Boolean(options['dry-run']);
  if (!dry) applyAgents(plan);
  if (options.json) {
    log.log(JSON.stringify({directory, command:serverCommand(directory, config), files:plan.map(({agent, path, action}) => ({agent, path, action})), home, applied:!dry}));
    return 0;
  }
  log.error(`Firenook mcp add: ${directory}${dry ? ' (dry run, nothing written)' : ''}`);
  if (!config) log.error('  note    no firebase.json here: the server will use the one running suite, or pass --config');
  for (const step of plan) log.error(`  ${describeStep(step, directory)}`);
  for (const agent of home) log.error(`  ${agent.name}: ${agent.line}`);
  if (!plan.length) {
    const command = serverCommand(directory, config);
    log.error(`  No coding agent found here (looked for ${PROJECT_AGENTS.map(agent => agent.file.split(/[\\/]/)[0]).join(', ')} and claude on the PATH).`);
    log.error(`  Pass --agent ${PROJECT_AGENTS.map(agent => agent.id).join(',')} to write one anyway, or give your agent this server:`);
    log.error(`  ${JSON.stringify({mcpServers:{firenook:{command:command[0], args:command.slice(1)}}})}`);
  } else if (!dry && plan.some(step => step.content)) log.error('Commit these files so every teammate\'s agent has the server; restart the agent to load it.');
  return 0;
}
