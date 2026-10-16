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

// The custom-claims length corpus: recorded after Phase I1 into its own
// directory, frozen by its own receipt.
const claimsRoot = new URL('../fixtures/auth-claims-length-v1/', import.meta.url);
const claimsGate = JSON.parse(readFileSync(new URL('../../benchmarks/auth-claims-length.json', import.meta.url), 'utf8'));

test('the custom-claims length corpus is frozen by its receipt', () => {
  const sums = new Map(readFileSync(new URL('SHA256SUMS', claimsRoot), 'utf8').trim().split('\n').map(line => {
    const [hash, name] = line.split(/\s+/);
    return [name, hash];
  }));
  for (const name of claimsGate.capture.requiredFixtures) {
    if (name === 'SHA256SUMS') continue;
    const actual = digest(readFileSync(new URL(name, claimsRoot)));
    assert.equal(sums.get(name), actual, `${name} must match SHA256SUMS`);
    assert.equal(claimsGate.capture.frozenFixtureSha256[name], actual, `${name} must match the receipt`);
  }
  assert.equal(claimsGate.frozen, true);
  assert.equal(claimsGate.capture.fixturesFrozen, true);
});

test('the custom-claims length corpus records UTF-16 code units against the limit', () => {
  const raw = readFileSync(new URL('emulator-programs.json', claimsRoot), 'utf8');
  const fixture = JSON.parse(raw);
  assert.equal(fixture.target, 'official-firebase-tools-auth-emulator');
  assert.equal(fixture.targetVersion, claimsGate.toolchain.firebaseToolsAuthOracle);
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
  for (const [file, hash] of Object.entries(gate.toolchain.firebaseToolsAuthSourceSha256)) {
    assert.equal(fixture.sourceHashes[file], hash, `${file} must be the oracle source Phase I pins`);
  }
  assert.equal(fixture.programCount, claimsGate.capture.programs);
  assert.equal(fixture.stepCount, claimsGate.capture.steps);
  const produced = JSON.stringify(fixture.programs.map(program => program.steps.map(step => [step.response, step.logs, step.functionsCalls])));
  assert.doesNotMatch(produced, /"(idToken|refreshToken|sessionCookie|id_token|access_token)":"ey/, 'tokens must be decoded');
  assert.doesNotMatch(produced, /fakeSalt[A-Za-z0-9]{20}/, 'salts must be templated');
  assert.doesNotMatch(produced, /127\.0\.0\.1:\d+/, 'origins must be templated');
  assert.doesNotMatch(raw, /\/Users\/|\/home\//, 'machine paths must not be recorded');

  const steps = new Map(fixture.programs[0].steps.map(step => [step.id, step]));
  const units = text => text.length; // JavaScript length: UTF-16 code units
  const claimsOf = id => steps.get(id).request.body.customAttributes;
  const status = id => steps.get(id).response.status;
  for (const [id, length, accepted] of [
    ['ascii-1000', 1000, true],
    ['ascii-1001', 1001, false],
    ['accented-999', 999, true],
    ['accented-1000', 1000, true],
    ['accented-1001', 1001, false],
    ['emoji-1000', 1000, true],
    ['emoji-1001', 1001, false],
  ]) {
    const claims = claimsOf(id);
    assert.equal(units(claims), length, `${id} measures ${length}`);
    assert.equal(status(id), accepted ? 200 : 400, `${id}`);
    if (!accepted) assert.equal(steps.get(id).response.body.error.message, 'CLAIMS_TOO_LARGE');
  }
  // Bytes do not count: 1,000 units of é are far more than 1,000 bytes.
  assert.ok(Buffer.byteLength(claimsOf('accented-1000')) > 1900);
  // 🔥 counts two: 1,000 characters that measure 1,001 are refused.
  assert.equal([...claimsOf('emoji-1001')].length, 1000);
  assert.deepEqual(steps.get('import').response.body.error, [
    {index: 1, message: 'Custom claims provided are too large.'},
    {index: 3, message: 'Custom claims provided are too large.'},
  ]);
  assert.equal(status('blocking-accented-1000'), 200);
  assert.equal(status('blocking-emoji-1000'), 200);
  assert.equal(status('blocking-emoji-1001'), 400);
  assert.equal(steps.get('lookup-blocking').response.body.users.length, 2);
});
