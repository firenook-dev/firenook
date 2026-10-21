// Commands run from a folder inside a project (its functions/, most of all,
// where `npm run serve` runs) find the project's firebase.json as the
// official CLI does: in the current directory or the nearest folder above
// it, up to the root of the file system.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { canonical, findConfig, loadProject } from '../packages/cli/src/options.mjs';
import { needsDiscovery } from '../packages/cli/src/hub.mjs';
import { rcPath, use } from '../packages/cli/src/rc.mjs';
import { adopt } from '../packages/cli/src/init.mjs';
import { mcpAdd } from '../packages/cli/src/agents.mjs';

const cli = fileURLToPath(new URL('../packages/cli/bin/firenook.mjs', import.meta.url));
const options = {'storage-bucket':[], instance:[]};
const quiet = {log() {}, error() {}};

// A project with a functions/ folder (and a folder inside it).
function project() {
  const dir = canonical(mkdtempSync(join(tmpdir(), 'firenook-root-')));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({firestore:{rules:'firestore.rules'}, functions:{source:'functions'},
    emulators:{firestore:{}, functions:{}}}));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-shop'}}));
  mkdirSync(join(dir, 'functions', 'src'), {recursive:true});
  writeFileSync(join(dir, 'functions', 'package.json'), '{}');
  return {dir, functions:join(dir, 'functions'), deeper:join(dir, 'functions', 'src')};
}

test('a command in a folder of the project finds its firebase.json above it', () => {
  const {dir, functions, deeper} = project();
  for (const cwd of [dir, functions, deeper]) {
    assert.equal(findConfig({}, cwd), join(dir, 'firebase.json'), cwd);
    const found = loadProject(options, cwd);
    assert.equal(found.config, join(dir, 'firebase.json'));
    assert.equal(found.directory, dir);
    // Its .firebaserc, next to it, names the project.
    assert.equal(found.project, 'demo-shop');
    assert.equal(needsDiscovery(options, cwd), false);
  }
  // --config is the current directory's, as the official --config is.
  writeFileSync(join(functions, 'other.json'), JSON.stringify({emulators:{auth:{}}}));
  assert.equal(loadProject({...options, config:'other.json', project:'demo-other'}, functions).config, join(functions, 'other.json'));
  // Nowhere above a folder outside every project: no firebase.json.
  const outside = canonical(mkdtempSync(join(tmpdir(), 'firenook-outside-')));
  assert.equal(findConfig({}, outside), undefined);
  assert.throws(() => loadProject(options, outside), /No firebase\.json/);
  assert.equal(needsDiscovery(options, outside), true);
});

test('use, init --adopt and mcp add work on the project above the folder', () => {
  const {dir, functions} = project();
  assert.equal(rcPath({}, functions), join(dir, '.firebaserc'));
  assert.equal(use(undefined, {add:'demo-staging', alias:'staging'}, functions, quiet), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.firebaserc'), 'utf8')).projects, {default:'demo-shop', staging:'demo-staging'});
  const output = [];
  assert.equal(adopt({...options, json:true}, functions, {log:line => output.push(line), error() {}}, {env:{}}), 0);
  assert.equal(JSON.parse(output[0]).config, join(dir, 'firebase.json'));
  const added = [];
  assert.equal(mcpAdd({agent:'claude', 'dry-run':true, json:true}, functions, {log:line => added.push(line), error() {}}, {}), 0);
  assert.equal(JSON.parse(added[0]).directory, dir);
  // The command line too.
  const run = spawnSync(process.execPath, [cli, 'init', '--adopt', '--json'], {cwd:functions, encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).config, join(dir, 'firebase.json'));
});
