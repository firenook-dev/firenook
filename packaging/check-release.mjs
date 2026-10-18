import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { manifest, release } from '../packages/cli/src/binary.mjs';
import { recoveryReceipt, authorizeRecovery, validateRecoveryChannel } from './release-recovery.mjs';
import { channelNote, releaseLatest } from './release-channel.mjs';

assert.match(manifest.version,/^\d+\.\d+\.\d+(?:-(?:next|rc)\.\d+)?$/);
assert.equal(manifest.name,'firenook');
assert.equal(manifest.publishConfig.access,'public');
assert.equal(manifest.scripts,undefined,'No dependency lifecycle scripts');
assert.equal(manifest.repository.url,'git+https://github.com/firenook-dev/firenook.git');
assert.match(release.engineRevision,/^[a-f0-9]{40}$/);
assert.ok(!Object.hasOwn(release, 'acceptanceReport'), 'Keep private acceptance outside the public package');
assert.ok(!Object.hasOwn(release, 'acceptedBaselineRevision'), 'Keep private acceptance outside the public package');
for (const key of Object.keys(release.platforms)) assert.equal(manifest.optionalDependencies[`@firenook/cli-${key}`],manifest.version);
const workflow = readFileSync(new URL('../.github/workflows/release-npm.yml',import.meta.url),'utf8');
assert.match(workflow,/id-token: write/);
assert.match(workflow,/environment: npm-release/);
assert.doesNotMatch(workflow,/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
assert.match(workflow,/\n {6}latest:\r?\n {8}description: [^\r\n]+\r?\n {8}required: false\r?\n {8}default: false\r?\n {8}type: boolean\r?\n/,'Publishing the CLI to latest is off unless asked');
if (process.argv.includes('--release')) {
  const source = JSON.parse(readFileSync(new URL('./source-publication.json', import.meta.url)));
  assert.equal(source.reviewedCleanPublicHistory, true, 'Public source/history cutover must be reviewed before publication');
  const tag = process.env.RELEASE_TAG;
  assert.equal(tag,`npm-v${manifest.version}`);
  const tagged = execFileSync('git',['rev-parse',`refs/tags/${tag}^{commit}`],{encoding:'utf8'}).trim();
  const head = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  assert.equal(process.env.GITHUB_REF,'refs/heads/main');
  const latest = releaseLatest();
  if (process.env.RELEASE_RESUME === 'true') {
    const receipt = recoveryReceipt();
    validateRecoveryChannel(receipt, latest);
    authorizeRecovery(receipt, tagged);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `source_run=${receipt.sourceRun}\nartifact_ids=${receipt.artifacts.map(a=>a.id).join(',')}\n`);
  } else {
    assert.equal(tagged,head,'Tag must identify exactly this reviewed main commit');
  }
  // The run's summary, which the npm-release approver reads before approving.
  const note = channelNote(manifest.version, {latest});
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${tag}\n\n${note}\n`);
  console.log(note);
}
console.log(`Release contract validated: ${manifest.name}@${manifest.version}`);
