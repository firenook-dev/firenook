import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { release } from '../packages/cli/src/binary.mjs';
import { channelNote, publishTag, releaseLatest } from './release-channel.mjs';

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
