import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../fixtures/auth-v1/', import.meta.url);
const gate = JSON.parse(readFileSync(new URL('../../benchmarks/phase-i-auth.json', import.meta.url), 'utf8'));
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

test('emulator programs meet the frozen minimums, cover every implemented operation and store no secrets', () => {
  const fixture = JSON.parse(frozen('emulator-programs.json'));
  assert.equal(fixture.target, 'official-firebase-tools-auth-emulator');
  assert.equal(fixture.targetVersion, gate.toolchain.firebaseToolsAuthOracle);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.freshEmulatorPerProgram, true);
  for (const [file, hash] of Object.entries(gate.toolchain.firebaseToolsAuthSourceSha256)) {
    assert.equal(fixture.sourceHashes[file], hash, `${file} must be the oracle source the gate pins`);
  }
  assert.ok(fixture.programCount >= gate.capture.emulatorPrograms.minimumPrograms, `${fixture.programCount} programs`);
  assert.ok(fixture.stepCount >= gate.capture.emulatorPrograms.minimumSteps, `${fixture.stepCount} steps`);
  assert.equal(fixture.programs.length, fixture.programCount);
  let steps = 0;
  const programIds = new Set();
  const raw = readFileSync(new URL('emulator-programs.json', root), 'utf8');
  for (const program of fixture.programs) {
    assert.ok(!programIds.has(program.id), `duplicate program ${program.id}`);
    programIds.add(program.id);
    const stepIds = new Set();
    for (const step of program.steps) {
      assert.ok(!stepIds.has(step.id), `duplicate step ${program.id}/${step.id}`);
      stepIds.add(step.id);
      assert.ok(Number.isInteger(step.response.status), `${program.id}/${step.id} status`);
      assert.ok(step.request.method, `${program.id}/${step.id} method`);
      assert.ok(Array.isArray(step.logs) && Array.isArray(step.functionsCalls));
      steps += 1;
    }
  }
  assert.equal(steps, fixture.stepCount);
  // No live token, code or identifier survives normalization in what the
  // emulator produced (requests carry program constants, including literal
  // test JWTs).
  const produced = JSON.stringify(fixture.programs.map(program => program.steps.map(step => [step.response, step.logs, step.functionsCalls])));
  assert.doesNotMatch(produced, /"(idToken|refreshToken|sessionCookie|id_token|access_token)":"ey/, 'tokens must be decoded');
  assert.doesNotMatch(produced, /fakeSalt[A-Za-z0-9]{20}/, 'salts must be templated');
  assert.doesNotMatch(produced, /127\.0\.0\.1:\d+/, "origins must be templated");
  assert.doesNotMatch(raw, /\/Users\/|\/home\//, 'machine paths must not be recorded');
  // Every implemented operation of the official emulator is exercised.
  for (const operation of fixture.coverage.officialImplementedMissing) {
    assert.fail(`operation ${operation} is not covered`);
  }
  assert.equal(fixture.coverage.officialImplementedMissing.length, 0);
  assert.equal(fixture.coverage.officialNotImplementedMissing.length, 0);
  assert.equal(fixture.coverage.officialImplemented, gate.inventory.officialImplementedOperations.length);
});
