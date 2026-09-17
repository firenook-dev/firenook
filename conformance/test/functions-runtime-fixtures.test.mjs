import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../fixtures/functions-runtime-v1/', import.meta.url);
const gate = JSON.parse(readFileSync(new URL('../../benchmarks/phase-h-functions-runtime.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function frozen(name) {
  const bytes = readFileSync(new URL(name, root));
  const expected = gate.capture.frozenFixtureSha256[name];
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, `${name} must be frozen in the gate file`);
  assert.equal(digest(bytes), expected, `${name} digest must match the frozen gate`);
  return bytes;
}

test('SHA256SUMS lists every required fixture with its frozen digest', () => {
  const sums = readFileSync(new URL('SHA256SUMS', root), 'utf8').trim().split('\n');
  const listed = new Map(sums.map(line => {
    const [hash, name] = line.split(/\s+/);
    return [name, hash];
  }));
  for (const name of gate.capture.requiredFixtures) {
    if (name === 'SHA256SUMS') continue;
    assert.equal(listed.get(name), digest(readFileSync(new URL(name, root))), `${name} must match SHA256SUMS`);
    assert.equal(listed.get(name), gate.capture.frozenFixtureSha256[name], `${name} must match the gate`);
  }
  assert.equal(gate.capture.fixturesFrozen, true);
  assert.equal(gate.frozen, true);
});

test('emulator programs meet the frozen minimums and store no credentials', () => {
  const fixture = JSON.parse(frozen('emulator-programs.json'));
  assert.equal(fixture.target, 'official-firebase-tools-functions-and-extensions-emulator');
  assert.equal(fixture.targetVersion, gate.toolchain.firebaseToolsOracle);
  assert.equal(fixture.sdkVersions['firebase-functions'], gate.toolchain.firebaseFunctionsSdk);
  assert.equal(fixture.sdkVersions['firebase-admin'], gate.toolchain.firebaseAdminSdk);
  assert.match(fixture.projectId, /^demo-/);
  assert.equal(fixture.profileCount, gate.capture.frozenProfileCount);
  assert.equal(fixture.programCount, gate.capture.frozenProgramCount);
  assert.equal(fixture.stepCount, gate.capture.frozenStepCount);
  assert.ok(fixture.programCount >= gate.capture.minimumPrograms, `${fixture.programCount} programs`);
  assert.ok(fixture.stepCount >= gate.capture.minimumSteps, `${fixture.stepCount} steps`);
  for (const category of gate.capture.requiredCategories) {
    assert.ok(fixture.categories[category] > 0, `category ${category} must have a program`);
  }
  let programs = 0;
  let steps = 0;
  let observations = 0;
  const text = JSON.stringify(fixture);
  assert.doesNotMatch(text, /eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0\./u, 'unsigned test JWTs must be placeholders');
  assert.doesNotMatch(text, /X-Goog-Signature|Signature=|ya29\./u, 'no signed URLs or access tokens');
  for (const profile of fixture.profiles) {
    assert.ok(profile.id);
    if (profile.skipped) continue;
    assert.ok(profile.readiness || profile.startupFailure, `${profile.id} must record readiness or a startup failure`);
    for (const program of profile.programs) {
      programs += 1;
      assert.ok(program.category, `${program.id} needs a category`);
      assert.equal(program.failure, undefined, `${program.id} must not have failed`);
      for (const step of program.steps) {
        steps += 1;
        observations += step.observations.length;
        assert.ok(step.id);
        assert.ok(step.action?.kind);
        for (const observation of step.observations) {
          assert.equal(observation.gacPresent ?? false, false, `${program.id}/${step.id} handlers must not see application default credentials`);
        }
      }
    }
  }
  assert.equal(programs, fixture.programCount);
  assert.equal(steps, fixture.stepCount);
  assert.equal(observations, fixture.observationCount);
  assert.ok(observations >= gate.capture.minimumObservations, `${observations} handler observations`);
  const main = fixture.profiles.find(profile => profile.id === 'main');
  assert.ok(main.inventory.body.backends.length >= 7, 'main profile lists every codebase and the extension backend');
  const customEvent = main.programs.find(program => program.id === 'extensions-triggers').steps.find(step => step.id === 'publish-listened');
  assert.ok(customEvent.observations.some(observation => observation.handler === 'customEvent'), 'extension custom events reach user handlers on the official emulator');
});
