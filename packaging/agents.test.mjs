// firenook mcp add, and the offer init makes with the same code: which agents
// a project uses, the files written for them, and what is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { homeAgentLines, mcpAdd, planAgents, serverCommand } from '../packages/cli/src/agents.mjs';
import { adopt, scaffold } from '../packages/cli/src/init.mjs';

const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs', import.meta.url));
const options = {'storage-bucket':[], instance:[]};
const log = () => { const out = [], err = []; return {out, err, log:(...a) => out.push(a.join(' ')), error:(...a) => err.push(a.join(' '))}; };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
// No agent is found through this machine's PATH or home folder.
const env = {};
const folder = (...markers) => {
  const dir = mkdtempSync(join(tmpdir(), 'firenook-agents-'));
  for (const marker of markers) {
    if (marker.endsWith('/')) mkdirSync(join(dir, marker), {recursive:true});
    else writeFileSync(join(dir, marker), '');
  }
  return dir;
};
const SERVER = {command:'npx', args:['firenook', 'mcp']};

test('mcp add finds the agents a project uses and writes each one\'s project file', () => {
  assert.deepEqual(planAgents(folder(), {env}), []);
  assert.deepEqual(planAgents(folder('.claude/'), {env}).map(step => step.agent), ['claude']);
  assert.deepEqual(planAgents(folder('CLAUDE.md'), {env}).map(step => step.agent), ['claude']);
  assert.deepEqual(planAgents(folder('.cursorrules'), {env}).map(step => step.agent), ['cursor']);
  // `claude` on the PATH counts as Claude Code.
  const bin = mkdtempSync(join(tmpdir(), 'firenook-agents-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755);
  assert.deepEqual(planAgents(folder(), {env:{PATH:bin}}).map(step => step.agent), process.platform === 'win32' ? [] : ['claude']);

  const dir = folder('.claude/', '.cursor/', '.vscode/');
  writeFileSync(join(dir, 'firebase.json'), '{}');
  const output = log();
  assert.equal(mcpAdd(options, dir, output, env), 0);
  assert.deepEqual(readJson(join(dir, '.mcp.json')), {mcpServers:{firenook:SERVER}});
  assert.deepEqual(readJson(join(dir, '.cursor/mcp.json')), {mcpServers:{firenook:SERVER}});
  assert.deepEqual(readJson(join(dir, '.vscode/mcp.json')), {servers:{firenook:{type:'stdio', ...SERVER}}});
  const text = output.err.join('\n');
  assert.match(text, /add\s+\.mcp\.json \(Claude Code\)/);
  assert.match(text, /add\s+\.cursor\/mcp\.json \(Cursor\)/);
  assert.match(text, /add\s+\.vscode\/mcp\.json \(VS Code\)/);
  assert.match(text, /Commit these files/);
  assert.doesNotMatch(text, /no firebase\.json/);

  // A second run changes nothing.
  const before = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'].map(file => readFileSync(join(dir, file), 'utf8'));
  const again = log();
  mcpAdd(options, dir, again, env);
  assert.deepEqual(['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'].map(file => readFileSync(join(dir, file), 'utf8')), before);
  assert.equal(again.err.filter(line => /keep\s+.*already set/.test(line)).length, 3);
  assert.doesNotMatch(again.err.join('\n'), /Commit these files/);
});

test('mcp add keeps every other server, never replaces another firenook entry without --force, and skips files it cannot read', () => {
  const dir = folder('.vscode/', '.cursor/');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers:{other:{command:'other'}}, extra:true}, null, 2));
  writeFileSync(join(dir, '.cursor/mcp.json'), JSON.stringify({mcpServers:{firenook:{command:'node', args:['custom.mjs']}}}));
  writeFileSync(join(dir, '.vscode/mcp.json'), '{\n  // servers\n  "servers": {}\n}\n');
  const output = log();
  mcpAdd(options, dir, output, env);
  const claude = readJson(join(dir, '.mcp.json'));
  assert.deepEqual(Object.keys(claude), ['mcpServers', 'extra'], 'key order is kept');
  assert.deepEqual(claude.mcpServers, {other:{command:'other'}, firenook:SERVER});
  assert.deepEqual(readJson(join(dir, '.cursor/mcp.json')).mcpServers.firenook, {command:'node', args:['custom.mjs']});
  assert.equal(readFileSync(join(dir, '.vscode/mcp.json'), 'utf8'), '{\n  // servers\n  "servers": {}\n}\n');
  const text = output.err.join('\n');
  assert.match(text, /keep\s+\.cursor\/mcp\.json \(Cursor: it has another firenook entry; --force replaces it\)/);
  assert.match(text, /skip\s+\.vscode\/mcp\.json \(VS Code: not plain JSON; add this by hand: \{"servers":\{"firenook":\{"type":"stdio","command":"npx","args":\["firenook","mcp"\]\}\}\}\)/);
  mcpAdd({...options, force:true}, dir, log(), env);
  assert.deepEqual(readJson(join(dir, '.cursor/mcp.json')).mcpServers.firenook, SERVER);
});

test('mcp add: --agent, --dry-run, --json, a project in a subfolder and an agent configured only in the home folder', () => {
  const dir = folder();
  const output = log();
  mcpAdd(options, dir, output, env);
  assert.match(output.err.join('\n'), /no firebase\.json here[\s\S]*No coding agent found here[\s\S]*--agent claude,cursor,vscode[\s\S]*\{"mcpServers":\{"firenook":\{"command":"npx","args":\["firenook","mcp"\]\}\}\}/);
  assert.throws(() => mcpAdd({...options, agent:'zed'}, dir, log(), env), /Unknown agent zed; --agent takes claude, cursor, vscode/);

  const dry = log();
  mcpAdd({...options, agent:'cursor,vscode', 'dry-run':true}, dir, dry, env);
  assert.match(dry.err[0], /dry run, nothing written/);
  assert.ok(!existsSync(join(dir, '.cursor')) && !existsSync(join(dir, '.vscode')));
  const report = log();
  mcpAdd({...options, agent:'cursor', json:true}, dir, report, env);
  const parsed = JSON.parse(report.out[0]);
  assert.deepEqual(parsed.files, [{agent:'cursor', path:join(dir, '.cursor', 'mcp.json'), action:'add'}]);
  assert.equal(parsed.applied, true);
  assert.deepEqual(parsed.command, ['npx', 'firenook', 'mcp']);
  assert.ok(existsSync(join(dir, '.cursor/mcp.json')));

  // The files go where the agent opens the repository; the server is told
  // where firebase.json is.
  mkdirSync(join(dir, 'apps', 'backend'), {recursive:true});
  writeFileSync(join(dir, 'apps', 'backend', 'firebase.json'), '{}');
  assert.deepEqual(serverCommand(dir, join(dir, 'apps', 'backend', 'firebase.json')), ['npx', 'firenook', 'mcp', '--config', 'apps/backend/firebase.json']);
  mcpAdd({...options, agent:'claude', config:'apps/backend/firebase.json'}, dir, log(), env);
  assert.deepEqual(readJson(join(dir, '.mcp.json')).mcpServers.firenook.args, ['firenook', 'mcp', '--config', 'apps/backend/firebase.json']);

  const bin = mkdtempSync(join(tmpdir(), 'firenook-agents-bin-'));
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n'); chmodSync(join(bin, 'codex'), 0o755);
  const home = mkdtempSync(join(tmpdir(), 'firenook-agents-home-'));
  mkdirSync(join(home, '.codeium', 'windsurf'), {recursive:true});
  const lines = homeAgentLines(dir, undefined, {env:{PATH:bin}, home});
  assert.deepEqual(lines.map(line => line.name), process.platform === 'win32' ? ['Windsurf'] : ['Codex', 'Windsurf']);
  if (process.platform !== 'win32') assert.equal(lines[0].line, 'codex mcp add firenook -- npx firenook mcp');
  assert.ok(!existsSync(join(home, '.codeium', 'windsurf', 'mcp_config.json')), 'a home folder file is never written');
});

test('init prints --keep-data, and gives the agents it finds the MCP server with --yes or prints how', async () => {
  const plain = folder();
  const output = log();
  assert.equal(scaffold({...options, project:'demo-plain'}, plain, output, {env}), 0);
  assert.match(output.err.join('\n'), /Next steps:[\s\S]*npx firenook emulators:start --keep-data --build/);
  assert.doesNotMatch(output.err.join('\n'), /mcp add/, 'no agent, no offer');

  // Without --yes: the command is printed, nothing is written.
  const found = folder('.claude/', '.cursor/');
  const printed = log();
  assert.equal(scaffold({...options, project:'demo-found'}, found, printed, {env}), 0);
  assert.match(printed.err.join('\n'), /npx firenook mcp add\s+\(gives Claude Code and Cursor the Firenook MCP server\)/);
  assert.ok(!existsSync(join(found, '.mcp.json')));

  // --yes writes them, as the screen does once its choices are made.
  const yes = folder('.claude/', '.cursor/', '.vscode/');
  const accepted = log();
  assert.equal(await scaffold({...options, project:'demo-yes', yes:true, 'no-install':true, 'no-pin':true}, yes, accepted, {env}), 0);
  assert.deepEqual(readJson(join(yes, '.mcp.json')), {mcpServers:{firenook:SERVER}});
  assert.ok(existsSync(join(yes, '.vscode/mcp.json')) && existsSync(join(yes, '.cursor/mcp.json')));
  assert.match(accepted.err.join('\n'), /done {4}Agents: \.mcp\.json for Claude Code, \.cursor\/mcp\.json for Cursor, \.vscode\/mcp\.json for VS Code/);
  assert.doesNotMatch(accepted.err.join('\n'), /firenook mcp add/);
  // --agent picks them; an empty pick asks for none.
  const picked = folder('.cursor/');
  await scaffold({...options, project:'demo-picked', yes:true, 'no-install':true, 'no-pin':true, agent:'vscode'}, picked, log(), {env});
  assert.ok(existsSync(join(picked, '.vscode/mcp.json')) && !existsSync(join(picked, '.cursor/mcp.json')));
  assert.throws(() => scaffold({...options, agent:'emacs'}, folder(), log(), {env}), /Unknown agent emacs/);

  // Dry runs and JSON plans list the offer and write nothing.
  const dry = folder('.vscode/');
  const plan = log();
  scaffold({...options, project:'demo-dry', 'dry-run':true}, dry, plan, {env});
  assert.match(plan.err.join('\n'), /offer\s+\S+mcp\.json \(VS Code: the Firenook MCP server\)/);
  const json = log();
  scaffold({...options, project:'demo-json', json:true}, folder('.vscode/'), json, {env});
  const parsed = JSON.parse(json.out[0]);
  assert.deepEqual(parsed.agents.map(agent => agent.agent), ['vscode']);
  assert.ok(parsed.next.includes('npx firenook emulators:start --keep-data --build'));
});

test('init --adopt lists the MCP server as one more addition and applies it with the rest', () => {
  const dir = folder('.claude/', '.cursor/');
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({firestore:{}, emulators:{firestore:{port:8080}}}));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-adopt'}}));
  writeFileSync(join(dir, '.cursor/mcp.json'), JSON.stringify({mcpServers:{firenook:{command:'node', args:['mine.mjs']}}}));
  let output = log();
  assert.equal(adopt({...options, 'dry-run':true}, dir, output, {env}), 0);
  assert.match(output.err.join('\n'), /add\s+give Claude Code the Firenook MCP server: \S+\.mcp\.json/);
  assert.match(output.err.join('\n'), /skip\s+\S+mcp\.json already has another firenook entry for Cursor; firenook mcp add --force replaces it/);
  assert.ok(!existsSync(join(dir, '.mcp.json')));
  output = log();
  adopt({...options, json:true}, dir, output, {env});
  assert.deepEqual(JSON.parse(output.out[0]).additions.filter(item => item.kind === 'agent'), [{kind:'agent', target:join(dir, '.mcp.json'), agent:'claude'}]);
  output = log();
  assert.equal(adopt(options, dir, output, {env}), 0);
  assert.deepEqual(readJson(join(dir, '.mcp.json')), {mcpServers:{firenook:SERVER}});
  assert.deepEqual(readJson(join(dir, '.cursor/mcp.json')).mcpServers.firenook, {command:'node', args:['mine.mjs']});
  output = log();
  adopt(options, dir, output, {env});
  assert.match(output.err.join('\n'), /ok\s+nothing to change/);
});

test('the command line routes mcp add and checks its options', () => {
  const dir = folder('.cursor/');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {cwd:dir, encoding:'utf8', env:{...process.env, PATH:''}});
  const help = spawnSync(process.execPath, [cli, '--help'], {encoding:'utf8'}).stdout;
  assert.match(help, /firenook mcp add \[--agent claude,cursor,vscode\] \[--dry-run\] \[--force\]/);
  assert.match(help, /--keep-data/);
  const added = run('mcp', 'add', '--dry-run');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stderr, /add\s+\.cursor\/mcp\.json \(Cursor\)/);
  assert.ok(!existsSync(join(dir, '.cursor/mcp.json')));
  assert.match(run('mcp', 'add', '--only', 'auth').stderr, /--only is not an option of firenook mcp add/);
  assert.match(run('mcp', 'add', 'extra').stderr, /Unexpected argument extra/);
  assert.match(run('mcp', '--agent', 'cursor').stderr, /--agent is not an option of firenook mcp/);
});
