import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../fixtures/tasks-v1/', import.meta.url);
const gate = JSON.parse(readFileSync(new URL('../../benchmarks/phase-k-tasks.json', import.meta.url), 'utf8'));
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

test('the tasks profile meets the frozen minimums, covers every route and stores no live values', () => {
  const fixture = JSON.parse(frozen('emulator-programs.json'));
  assert.equal(fixture.target, 'official-firebase-tools-functions-and-extensions-emulator');
  assert.equal(fixture.targetVersion, gate.toolchain.firebaseToolsOracle);
  assert.equal(fixture.sdkVersions['firebase-functions'], gate.toolchain.firebaseFunctionsSdk);
  assert.equal(fixture.sdkVersions['firebase-admin'], gate.toolchain.firebaseAdminSdk);
  assert.match(fixture.projectId, /^demo-/);
  assert.equal(fixture.profileCount, gate.capture.frozenProfileCount);
  assert.equal(fixture.programCount, gate.capture.frozenProgramCount);
  assert.equal(fixture.stepCount, gate.capture.frozenStepCount);
  assert.ok(fixture.programCount >= gate.capture.emulatorPrograms.minimumPrograms);
  assert.ok(fixture.stepCount >= gate.capture.emulatorPrograms.minimumSteps);
  assert.ok(fixture.observationCount >= gate.capture.emulatorPrograms.minimumObservations);
  for (const category of gate.capture.requiredCategories) {
    assert.ok(fixture.categories[category] > 0, `category ${category} must have a program`);
  }
  const text = JSON.stringify(fixture);
  assert.doesNotMatch(text, /eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0\./u, 'unsigned test JWTs must be placeholders');
  assert.doesNotMatch(text, /X-Goog-Signature|Signature=|ya29\./u, 'no signed URLs or access tokens');
  assert.doesNotMatch(text, /127\.0\.0\.1:\d{4,5}\/(?!never)/u, 'live origins must be placeholders');
  const [profile] = fixture.profiles;
  assert.equal(profile.id, 'tasks');
  assert.ok(profile.readiness, 'the tasks profile records readiness');
  const routes = new Set();
  const statuses = new Set();
  for (const program of profile.programs) {
    assert.equal(program.failure, undefined, `${program.id} recorded without a harness failure`);
    for (const step of program.steps) {
      if (step.action?.origin === 'tasks') {
        const path = step.action.path.replace(/\/projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+/u, '/queues/{q}').replace(/\/tasks\/[^/]+$/u, '/tasks/{id}');
        routes.add(`${step.action.method} ${path}`);
        statuses.add(step.response.status);
      }
    }
  }
  for (const route of ['POST /queues/{q}', 'POST /queues/{q}/tasks', 'DELETE /queues/{q}/tasks/{id}', 'GET /queueStats']) {
    assert.ok(routes.has(route), `route ${route} must be exercised`);
  }
  for (const status of [200, 400, 404, 409]) assert.ok(statuses.has(status), `status ${status} must be recorded`);
  const headerSets = profile.programs.flatMap(program => program.steps.flatMap(step => step.observations)).filter(item => item.task).map(item => Object.keys(item.task.headers));
  assert.ok(headerSets.length >= gate.capture.emulatorPrograms.minimumDispatchObservations, `${headerSets.length} dispatch observations`);
  for (const keys of headerSets) {
    for (const name of ['x-cloudtasks-queuename', 'x-cloudtasks-taskname', 'x-cloudtasks-taskretrycount', 'x-cloudtasks-taskexecutioncount', 'x-cloudtasks-tasketa']) {
      assert.ok(keys.includes(name), `dispatch carries ${name}`);
    }
  }
});
