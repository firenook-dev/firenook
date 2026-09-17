import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../fixtures/storage-rules-v1/', import.meta.url);
const gate = JSON.parse(readFileSync(new URL('../../benchmarks/phase-g-storage-rules.json', import.meta.url), 'utf8'));
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

test('production expression corpus meets the frozen minimums', () => {
  const corpus = JSON.parse(frozen('production-expression-corpus.json'));
  assert.equal(corpus.target, 'production-firebase-rules-projects-test');
  assert.equal(corpus.service, 'firebase.storage');
  assert.equal(corpus.credentialsStored, false);
  assert.equal(corpus.authorizationHeadersStored, false);
  assert.equal(corpus.persistentCloudReads, 0);
  assert.equal(corpus.persistentCloudWrites, 0);
  assert.ok(corpus.rulesApiRequests <= gate.oracles.cloud.maximumRulesApiRequestsPerCapture);
  assert.ok(corpus.caseCount >= gate.capture.productionExpressionCorpus.minimumCases, `${corpus.caseCount} cases`);
  const ids = new Set();
  let replayed = 0;
  for (const batch of corpus.batches) {
    assert.equal(digest(batch.source), batch.sourceSha256);
    assert.equal(batch.cases.length, batch.testCases.length);
    assert.equal(batch.cases.length, batch.response.testResults.length);
    for (const issue of batch.response.issues ?? []) assert.notEqual(issue.severity, 'ERROR');
    for (const [index, testCase] of batch.cases.entries()) {
      assert.ok(!ids.has(testCase.id), `duplicate case ${testCase.id}`);
      ids.add(testCase.id);
      assert.ok(['SUCCESS', 'FAILURE'].includes(batch.response.testResults[index].state));
      assert.ok(Array.isArray(batch.response.testResults[index].expressionReports));
      replayed += 1;
    }
  }
  assert.equal(replayed, corpus.caseCount);
  for (const category of gate.capture.productionExpressionCorpus.requiredCategories) {
    assert.ok(corpus.categories[category] > 0, `category ${category} must have cases`);
  }
});

test('emulator programs meet the frozen minimums and store no credentials', () => {
  const fixture = JSON.parse(frozen('emulator-programs.json'));
  assert.equal(fixture.target, 'official-firebase-tools-storage-emulator');
  assert.equal(fixture.targetVersion, gate.toolchain.firebaseToolsStorageOracle);
  assert.equal(fixture.rulesRuntimeSha256, gate.toolchain.storageRulesRuntimeJarSha256);
  assert.equal(fixture.firestoreEmulator.jarSha256, gate.toolchain.officialFirestoreEmulatorJarSha256);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.syntheticOnly, true);
  assert.match(fixture.targetProject, new RegExp(`^${gate.oracles.emulator.projectIdPrefix}`));
  assert.ok(fixture.programCount >= gate.capture.emulatorPrograms.minimumPrograms, `${fixture.programCount} programs`);
  assert.ok(fixture.stepCount >= gate.capture.emulatorPrograms.minimumSteps, `${fixture.stepCount} steps`);
  const categories = new Set(fixture.programs.map(program => program.category));
  for (const category of gate.capture.emulatorPrograms.requiredCategories) {
    assert.ok(categories.has(category), `category ${category} must have a program`);
  }
  for (const [name, token] of Object.entries(fixture.tokens)) {
    assert.equal(token.jwt.split('.')[0], Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), `${name} must be unsigned`);
    assert.equal(token.jwt.endsWith('.'), true);
  }
  let steps = 0;
  for (const program of fixture.programs) {
    assert.ok(program.rules.length > 0);
    assert.equal(program.rulesInstall.response.status, 200, `${program.id} ruleset must install`);
    for (const observation of program.observations) {
      assert.ok(Number.isInteger(observation.response.status));
      assert.ok(observation.request.method);
      const authorization = observation.request.headers.authorization;
      if (authorization !== undefined) {
        assert.ok(
          authorization.startsWith('@') || authorization.startsWith('firebase:@') || !/\beyJ/u.test(authorization),
          `${program.id}/${observation.id} must reference tokens, not inline them`,
        );
      }
      steps += 1;
    }
  }
  assert.equal(steps, fixture.stepCount);
  assert.ok(fixture.startupCompileError.observations.length >= 4);
  assert.equal(fixture.oracleCrashNotRecordedLive.id, 'object-name-with-empty-segment');
});
