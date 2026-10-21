// The packed Linux engine on old systems. On the runner: the binary in the
// platform tarball asks for glibc 2.28 at most and loads only glibc's and
// GCC's own libraries. Then, in containers of the oldest systems it claims
// (old-glibc.mjs), the installed launcher reports its version and finds the
// engine, which starts, and a Firestore it starts writes, stops cleanly and
// reopens what it wrote. Alpine's musl and a glibc older than 2.28 must be
// refused in plain words. Runs after smoke-packed.mjs (npm), whose installed
// consumer it mounts read-only; the containers have no network.
//
//   node packaging/smoke-glibc.mjs ARTIFACT_DIRECTORY
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loaderProblem } from '../packages/cli/src/binary.mjs';
import { GLIBC_REQUIRED, problems, refusals, requirements, systems } from './old-glibc.mjs';

const [mode, ...rest] = process.argv.slice(2);
const document = 'v1/projects/demo-glibc/databases/(default)/documents/glibc/one';
const text = '中文 😀 glibc';

// Run by emulators:exec inside a container: write the document, or read it back.
async function check(action, port) {
  const url = `http://127.0.0.1:${port}/${document}`;
  const headers = {'content-type': 'application/json', authorization: 'Bearer owner'};
  if (action === 'write') {
    const written = await fetch(url, {method: 'PATCH', headers, body: JSON.stringify({fields: {text: {stringValue: text}}})});
    assert.equal(written.status, 200, await written.text());
  }
  const read = await fetch(url, {headers});
  assert.equal(read.status, 200, 'the document was kept');
  assert.equal((await read.json()).fields.text.stringValue, text);
}

// Inside a container that should run the engine: the launcher, the engine,
// then a Firestore written and exported as it stops, and started again from
// the export and read.
function inside(version, expected) {
  const cli = '/consumer/node_modules/firenook/bin/firenook.mjs';
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  assert.equal(glibc, expected, 'the image has the glibc it is listed with');
  const launcher = args => execFileSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
  assert.ok(launcher(['--version']).includes(version), 'the launcher reports its version');
  // binary-path verifies the package and starts the engine once to see the loader accept it.
  const binary = launcher(['binary-path']).trim();
  const engine = execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim();
  const project = mkdtempSync('/tmp/project-');
  const port = 8080;
  writeFileSync(join(project, 'firebase.json'), JSON.stringify({firestore: {rules: 'firestore.rules'}, emulators: {firestore: {host: '127.0.0.1', port}}}));
  writeFileSync(join(project, 'firestore.rules'), "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }");
  for (const [action, data] of [['write', ['--export-on-exit', 'export']], ['read', ['--import', 'export']]]) {
    const started = Date.now();
    execFileSync(process.execPath, [cli, 'emulators:exec', '--only', 'firestore', '--project', 'demo-glibc', ...data,
      '--', process.execPath, fileURLToPath(import.meta.url), '--check', action, String(port)], {cwd: project, stdio: 'inherit'});
    console.log(JSON.stringify({glibc, action, ms: Date.now() - started}));
  }
  console.log(JSON.stringify({glibc, engine, passed: true}));
}

function outside(directoryArgument) {
  const directory = resolve(directoryArgument);
  const receipt = JSON.parse(readFileSync(join(directory, 'artifacts.json')));
  assert.match(receipt.platform, /^linux-/, 'smoke-glibc checks the Linux packages');
  const native = receipt.packages.find(pkg => pkg.name === `@firenook/cli-${receipt.platform}`);
  const unpacked = mkdtempSync(join(tmpdir(), 'firenook-glibc-'));
  execFileSync('tar', ['-xzf', join(directory, native.filename), '-C', unpacked]);
  const needs = requirements(execFileSync('readelf', ['-d', '-V', '-W', join(unpacked, 'package/bin/firenook')], {encoding: 'utf8'}));
  const found = problems(needs);
  assert.deepEqual(found, [], `the packed engine would not start on glibc ${GLIBC_REQUIRED}: ${found.join('; ')}`);
  console.log(`${native.filename} needs glibc ${needs.glibc} (at most ${GLIBC_REQUIRED}) and loads ${needs.needed.join(', ')}`);

  const smoke = JSON.parse(readFileSync(join(directory, 'npm-smoke.json')));
  const binary = join('/consumer', relative(smoke.consumer, smoke.binary));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const node = dirname(dirname(process.execPath));
  const docker = (image, command, {ownNode = false, capture = false} = {}) => {
    const args = ['run', '--rm', '--network', 'none', '-v', `${smoke.consumer}:/consumer:ro`, '-v', `${source}:/source:ro`,
      ...(ownNode ? [] : ['-v', `${node}:/opt/node:ro`]), '-e', 'FIRENOOK_NO_UPDATE_CHECK=1', image, ...command];
    console.log(`docker ${args.join(' ')}`);
    const result = spawnSync('docker', args, {encoding: 'utf8', timeout: 600_000, stdio: capture ? 'pipe' : 'inherit'});
    if (result.error) throw result.error;
    return result;
  };
  const started = [];
  for (const system of systems) {
    const result = docker(system.image, [system.node ? 'node' : '/opt/node/bin/node', '/source/packaging/smoke-glibc.mjs', '--inside', receipt.version, system.glibc],
      {ownNode: system.node});
    assert.equal(result.status, 0, `the engine did not start and stop on ${system.image}`);
    started.push(system.image.split('@')[0]);
  }

  // Alpine: the installed launcher refuses before any engine is started.
  const musl = docker(refusals.musl, ['node', '/consumer/node_modules/firenook/bin/firenook.mjs', 'binary-path'], {ownNode: true, capture: true});
  assert.equal(musl.status, 1, musl.stdout + musl.stderr);
  for (const words of [`needs glibc ${GLIBC_REQUIRED} or newer`, 'musl', 'node:24-slim']) assert.ok(musl.stderr.includes(words), `${words} in: ${musl.stderr}`);
  console.log(musl.stderr.trim());

  // Older glibc: no Node 24 starts there, so the engine is run bare and the
  // loader's own refusal is handed to the launcher's recogniser.
  const old = docker(refusals.old.image, ['sh', '-c', 'ldd --version | head -n 1; exec "$0" --version', binary], {ownNode: true, capture: true});
  assert.notEqual(old.status, 0, `the engine started on ${refusals.old.image}`);
  const has = /(\d+\.\d+)\s*$/.exec(old.stdout.split('\n')[0])?.[1];
  assert.equal(has, refusals.old.glibc);
  const said = loaderProblem({stderr: old.stderr}, {glibc: () => has});
  assert.ok(said?.includes(`needs glibc ${GLIBC_REQUIRED} or newer, and this system has glibc ${has}`), `the loader said: ${old.stderr}`);
  console.log(`${old.stderr.trim()}\n  -> Firenook: ${said}`);

  const result = {passed: true, version: receipt.version, engineRevision: receipt.engineRevision, platform: receipt.platform,
    glibc: needs.glibc, libraries: needs.needed, started, refused: [refusals.musl, refusals.old.image].map(image => image.split('@')[0]),
    completedAt: new Date().toISOString()};
  writeFileSync(join(directory, 'glibc-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (mode === '--check') await check(...rest);
else if (mode === '--inside') inside(...rest);
else if (mode && !rest.length) outside(mode);
else throw new Error('Usage: node packaging/smoke-glibc.mjs ARTIFACT_DIRECTORY');
