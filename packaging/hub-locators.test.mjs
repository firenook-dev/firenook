// Two suites for the same project id, from two folders: the official
// locator (hub-<project>.json) names one of them, so each Firenook suite
// also keeps a record of its own (firenook-hubs/hub-<project>-<pid>.json,
// with its folder). A command run in a folder reaches that folder's suite,
// --hub-port reaches the hub it names, and a command that cannot tell them
// apart says so instead of picking one.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { canonical, loadProject } from '../packages/cli/src/options.mjs';
import { discoverProject, findHub, locatorPath, recordPath, resolveProject, runningSuites } from '../packages/cli/src/hub.mjs';

const options = {'storage-bucket':[], instance:[]};
const PROJECT = 'demo-shop';
let root;
const suites = {};

// A hub that answers as a running suite's does, with its own pid.
async function hub(pid) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const {port} = server.address();
    if (request.url === '/') response.end(JSON.stringify({version:'15.22.0', origins:[`http://127.0.0.1:${port}`], pid, host:'127.0.0.1', port}));
    else if (request.url === '/emulators') response.end(JSON.stringify({hub:{name:'hub', host:'127.0.0.1', port}}));
    else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, pid, port:server.address().port, origin:`http://127.0.0.1:${server.address().port}`};
}
// A project folder whose firebase.json names `port` as its hub's.
function folder(name, port) {
  const dir = canonical(join(root, name));
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({firestore:{rules:'firestore.rules'}, emulators:{firestore:{}, hub:{port}}}));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:PROJECT}}));
  return dir;
}
// The record a Firenook suite writes of itself.
function record(suite, dir) {
  mkdirSync(join(root, 'tmp', 'firenook-hubs'), {recursive:true});
  writeFileSync(recordPath(PROJECT, suite.pid), JSON.stringify({version:'15.22.0', origins:[suite.origin], pid:suite.pid, projectId:PROJECT, projectDir:dir, config:join(dir, 'firebase.json')}));
}
async function deadPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  await new Promise(done => server.close(done));
  return port;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'firenook-hubs-'));
  mkdirSync(join(root, 'tmp'));
  process.env.FIRENOOK_LOCATOR_DIR = join(root, 'tmp');
  suites.first = await hub(70001);
  suites.second = await hub(70002);
  suites.firstDir = folder('first', suites.first.port);
  suites.secondDir = folder('second', suites.second.port);
  // The official locator names the suite that started first.
  writeFileSync(locatorPath(PROJECT), JSON.stringify({version:'15.22.0', origins:[suites.first.origin], pid:suites.first.pid}));
  record(suites.first, suites.firstDir);
  record(suites.second, suites.secondDir);
});
after(async () => {
  for (const suite of [suites.first, suites.second]) await new Promise(done => suite.server.close(done));
  delete process.env.FIRENOOK_LOCATOR_DIR;
  rmSync(root, {recursive:true, force:true});
});

test('a command in a project folder reaches that folder\'s suite, whichever the locator names', async () => {
  assert.equal((await findHub(loadProject(options, suites.firstDir), options)).origin, suites.first.origin);
  assert.equal((await findHub(loadProject(options, suites.secondDir), options)).origin, suites.second.origin);
});

test('--hub-port reaches the hub it names', async () => {
  const project = loadProject(options, suites.firstDir);
  const hubPort = {...options, 'hub-port':String(suites.second.port)};
  assert.equal((await findHub(project, hubPort)).origin, suites.second.origin);
  const nothing = {...options, 'hub-port':String(await deadPort())};
  await assert.rejects(findHub(project, nothing), /Did not find a running emulator hub/);
});

test('a folder whose own suite is not running never reaches another folder\'s', async () => {
  const third = folder('third', await deadPort());
  await assert.rejects(findHub(loadProject(options, third), options), error => {
    assert.match(error.message, /Did not find a running emulator hub for project demo-shop/);
    assert.match(error.message, /2 other suites for demo-shop run, from other folders/);
    return true;
  });
});

test('with only the project id, two suites are told apart by --hub-port', async () => {
  const outside = canonical(mkdtempSync(join(tmpdir(), 'firenook-outside-')));
  const project = resolveProject({...options, project:PROJECT}, outside);
  await assert.rejects(findHub(project, options), error => {
    assert.match(error.message, /2 suites run for demo-shop/);
    assert.ok(error.message.includes(suites.firstDir) && error.message.includes(suites.secondDir), error.message);
    assert.match(error.message, /--hub-port/);
    return true;
  });
  assert.equal((await findHub(project, {...options, 'hub-port':String(suites.second.port)})).origin, suites.second.origin);
  // Discovery sees both, and asks the same.
  const {answering} = await runningSuites();
  assert.deepEqual(answering.map(suite => suite.origin).sort(), [suites.first.origin, suites.second.origin].sort());
  await assert.rejects(discoverProject(outside, 'firenook mcp'), /2 running suites answer.*--hub-port/s);
  const found = await discoverProject(outside, 'firenook mcp', {'hub-port':String(suites.first.port)});
  assert.equal(found.project, PROJECT);
  assert.equal((await findHub(found, {'hub-port':String(suites.first.port)})).origin, suites.first.origin);
});

test('a suite with no record of its own (the official CLI\'s) is found through its locator', async () => {
  const official = await hub(70003);
  const dir = folder('official', await deadPort());
  writeFileSync(locatorPath('demo-official'), JSON.stringify({version:'15.34.0', origins:[official.origin], pid:official.pid}));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-official'}}));
  try {
    assert.equal((await findHub(loadProject(options, dir), options)).origin, official.origin);
  } finally {
    rmSync(locatorPath('demo-official'));
    await new Promise(done => official.server.close(done));
  }
});
