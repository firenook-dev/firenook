import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../fixtures/pubsub-v1/', import.meta.url);
const gate = JSON.parse(readFileSync(new URL('../../benchmarks/phase-j-pubsub.json', import.meta.url), 'utf8'));
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

test('emulator programs meet the frozen minimums, cover every RPC over both transports and store no live values', () => {
  const fixture = JSON.parse(frozen('emulator-programs.json'));
  assert.equal(fixture.target, 'official-cloud-pubsub-emulator');
  assert.equal(fixture.targetVersion, gate.toolchain.officialPubsubEmulator);
  assert.equal(fixture.jarSha256, gate.toolchain.officialPubsubEmulatorJarSha256);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.realDataStored, false);
  assert.ok(fixture.programs.length >= gate.capture.emulatorPrograms.minimumPrograms, `${fixture.programs.length} programs`);
  let steps = 0;
  const programIds = new Set();
  const transports = new Set();
  for (const program of fixture.programs) {
    assert.ok(!programIds.has(program.id), `duplicate program ${program.id}`);
    programIds.add(program.id);
    const stepIds = new Set();
    for (const step of program.steps) {
      assert.ok(!stepIds.has(step.id), `duplicate step ${program.id}/${step.id}`);
      stepIds.add(step.id);
      assert.ok(step.request && typeof step.request.transport === 'string', `${program.id}/${step.id} transport`);
      transports.add(step.request.transport);
      assert.ok(step.response && typeof step.response === 'object', `${program.id}/${step.id} response`);
      steps += 1;
    }
  }
  assert.ok(steps >= gate.capture.emulatorPrograms.minimumSteps, `${steps} steps`);
  for (const transport of ['grpc', 'http', 'stream', 'pushes']) assert.ok(transports.has(transport), `${transport} steps recorded`);
  // Every RPC of the four services is exercised over gRPC and over HTTP/JSON
  // (StreamingPull has no HTTP form).
  assert.equal(fixture.coverage.rpcTotal, gate.inventory.rpcTotal);
  assert.deepEqual(fixture.coverage.grpcMissing, []);
  assert.deepEqual(fixture.coverage.httpMissing, ['Subscriber.StreamingPull']);
  // No live value survives normalization in what the emulator produced.
  const produced = JSON.stringify(fixture.programs.map(program => program.steps.map(step => [step.response, step.pushes ?? null])));
  assert.doesNotMatch(produced, /127\.0\.0\.1:\d+/, 'origins must be templated');
  assert.doesNotMatch(produced, /"publishTime":"\d{4}-/, 'publish times must be templated');
  assert.doesNotMatch(produced, /"publishTime":\{/, 'publish times must be templated');
  assert.doesNotMatch(produced, /"ackId":"projects\//, 'ack ids must be templated');
  assert.doesNotMatch(produced, /"revisionId":"[0-9a-f]{8}"/, 'revision ids must be templated');
  const raw = readFileSync(new URL('emulator-programs.json', root), 'utf8');
  assert.doesNotMatch(raw, /\/Users\/|\/home\//, 'machine paths must not be recorded');
});
