import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, release } from '../packages/cli/src/binary.mjs';
import { cliFiles } from './public-artifacts.mjs';
import { channelNote, publishTag, releaseLatest } from './release-channel.mjs';
import { syntheticArchive } from './synthetic-archive.mjs';

const platforms = Object.keys(release.platforms);
const natives = platforms.map(platform => ({name:`@firenook/cli-${platform}`, version:'0.2.0-next.6'}));
const cli = {name:'firenook', version:'0.2.0-next.6'};

test('every package goes to next by default; only the CLI goes to latest, only when asked', () => {
  for (const options of [undefined, {}, {latest:false}]) {
    for (const record of [...natives, cli]) assert.equal(publishTag(record, options), 'next');
  }
  for (const record of natives) assert.equal(publishTag(record, {latest:true}), 'next');
  // A prerelease CLI takes latest like a stable one: npm 12 refuses a
  // prerelease publish only when it has no explicit --tag.
  assert.equal(publishTag(cli, {latest:true}), 'latest');
  assert.equal(publishTag({...cli, version:'1.0.0'}, {latest:true}), 'latest');
});

test('the dispatch input is off unless exactly true, and anything else stops', () => {
  for (const env of [{}, {RELEASE_LATEST:''}, {RELEASE_LATEST:'false'}]) assert.equal(releaseLatest(env), false);
  assert.equal(releaseLatest({RELEASE_LATEST:'true'}), true);
  for (const value of ['TRUE', '1', 'yes', 'latest']) assert.throws(() => releaseLatest({RELEASE_LATEST:value}), /true or false/);
});

test('the approver and the publish log are told the channel and what happens to next', () => {
  assert.equal(channelNote('0.2.0-next.6'), 'This run publishes the CLI to `next` (default): firenook@0.2.0-next.6 and the five native packages → next.');
  assert.equal(channelNote('0.2.0-next.6', {latest:true}), 'This run publishes the CLI to `latest`: firenook@0.2.0-next.6 → latest, ' +
    'the five native packages → next. The CLI\'s `next` stays on the previous release: npm sets one tag per publish and OIDC cannot move tags.');
});

test('the release workflow hands the choice to the authorize summary and to the publish step', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-npm.yml', import.meta.url), 'utf8');
  const [authorize, publish, ...rest] = [...workflow.matchAll(/RELEASE_LATEST: \$\{\{ inputs\.latest \}\}/g)].map(match => match.index);
  assert.deepEqual(rest, []);
  assert.ok(authorize < workflow.indexOf('node packaging/check-release.mjs --release'));
  assert.ok(workflow.indexOf('environment: npm-release') < publish && publish < workflow.indexOf('node packaging/publish-packages.mjs dist --publish'));
  const check = readFileSync(new URL('./check-release.mjs', import.meta.url), 'utf8');
  assert.match(check, /appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY, `### \$\{tag\}\\n\\n\$\{note\}\\n`\)/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|dist-tag/);
  const publisher = readFileSync(new URL('./publish-packages.mjs', import.meta.url), 'utf8');
  assert.match(publisher, /\['publish', record\.path, '--provenance', '--access', 'public', '--tag', record\.tag, '--ignore-scripts'\]/);
  const note = publisher.indexOf("mode === '--publish' ? channelNote(manifest.version, {latest})");
  assert.ok(note > 0 && note < publisher.indexOf('await verifyMissingPublishingAuth(ordered,'), 'The publish log names the channel before any upload');
  assert.doesNotMatch(publisher, /'dist-tag'/, 'OIDC cannot move tags; never fall back to another credential');
});

// The release identity's artifact set, constructed for the verifier only:
// placeholder bytes, never platform evidence or a publishable package.
function artifactSet(root) {
  const cliBytes = syntheticArchive(Object.fromEntries(cliFiles.map(path => [path,
    path === 'package.json' ? JSON.stringify({name:manifest.name, version:manifest.version})
      : path === 'release.json' ? JSON.stringify(release) : 'synthetic'])));
  for (const platform of platforms) {
    const directory = join(root, platform); mkdirSync(directory);
    const native = `@firenook/cli-${platform}`;
    const nativeBytes = syntheticArchive({'package.json':JSON.stringify({name:native, version:manifest.version}), LICENSE:'synthetic', NOTICE:'synthetic',
      'receipt.json':JSON.stringify({engineRevision:release.engineRevision}), [platform.startsWith('win32') ? 'bin/firenook.exe' : 'bin/firenook']:'placeholder'});
    const packages = [[native, 'native.tgz', nativeBytes], [manifest.name, 'cli.tgz', cliBytes]].map(([name, filename, bytes]) => {
      writeFileSync(join(directory, filename), bytes);
      return {name, version:manifest.version, filename, sha256:createHash('sha256').update(bytes).digest('hex'),
        integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`};
    });
    writeFileSync(join(directory, 'artifacts.json'), JSON.stringify({platform, version:manifest.version, engineRevision:release.engineRevision, packages}));
    for (const smoke of ['npm-smoke.json', 'bun-smoke.json', 'suite-smoke.json']) {
      writeFileSync(join(directory, smoke), JSON.stringify({passed:true, version:manifest.version, engineRevision:release.engineRevision}));
    }
  }
}

// While the version is a preview, as now, this is also the prerelease case.
test('a dry run of the publisher prints the same plan unset and off, and the CLI on latest only when on', () => {
  const root = mkdtempSync(join(tmpdir(), 'firenook-release-plan-'));
  try {
    artifactSet(root);
    const script = fileURLToPath(new URL('./publish-packages.mjs', import.meta.url));
    const dryRun = latest => spawnSync(process.execPath, [script, root, '--check'],
      {encoding:'utf8', env:{...process.env, RELEASE_RESUME:'false', RELEASE_LATEST:latest}});
    const [unset, off, on, invalid] = [undefined, 'false', 'true', 'yes'].map(dryRun);
    for (const run of [unset, off, on]) assert.equal(run.status, 0, run.stderr);
    assert.equal(off.stdout, unset.stdout);
    const plan = run => run.stdout.split('\n').filter(line => line.startsWith('Plan: '));
    const expected = tag => [...platforms.map(platform => `Plan: @firenook/cli-${platform}@${manifest.version} --tag next`),
      `Plan: firenook@${manifest.version} --tag ${tag}`];
    assert.deepEqual(plan(off), expected('next'));
    assert.deepEqual(plan(on), expected('latest'));
    assert.ok(off.stdout.endsWith(`--tag next\nPlan for RELEASE_LATEST=false; a release run's own choice is in its authorize summary.\n`));
    assert.ok(on.stdout.endsWith(`--tag latest\nPlan for RELEASE_LATEST=true; a release run's own choice is in its authorize summary.\n`));
    assert.deepEqual(JSON.parse(on.stdout.slice(0, on.stdout.indexOf('\nPlan: '))).packages.map(record => record.tag),
      [...platforms.map(() => 'next'), 'latest']);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /RELEASE_LATEST must be true or false/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
