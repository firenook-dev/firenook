// What counts as a release on top of its pinned engine (pinned-evidence.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beyondRelease, documentation } from './pinned-evidence.mjs';

const pinned = {
  'packages/cli/package.json': {name: 'firenook', version: '0.2.4', optionalDependencies: {'@firenook/cli-linux-x64': '0.2.4'}, engines: {node: '>=20'}},
  'packages/cli/release.json': {engineRevision: 'a'.repeat(40), rustToolchain: '1.98.0', platforms: {'linux-x64': {}}},
  'server.json': {name: 'io.github.firenook-dev/firenook', version: '0.2.4', packages: [{identifier: 'firenook', version: '0.2.4'}]},
};
const released = {
  'packages/cli/package.json': {...pinned['packages/cli/package.json'], version: '0.2.5', optionalDependencies: {'@firenook/cli-linux-x64': '0.2.5'}},
  'packages/cli/release.json': {...pinned['packages/cli/release.json'], engineRevision: 'b'.repeat(40), rustToolchain: '1.100.0'},
  'server.json': {...pinned['server.json'], version: '0.2.5', packages: [{identifier: 'firenook', version: '0.2.5'}]},
};
const reader = (head) => (file, side) => JSON.stringify((side === 'pin' ? pinned : head)[file]);

test('a release changes its versions, pin, toolchain and notes, and nothing else', () => {
  const changed = [...Object.keys(released), 'packaging/CHANGELOG.md', 'ROADMAP.md', 'docs/terminal.md'];
  assert.equal(beyondRelease(changed, reader(released)), undefined);
});

test('anything else differs beyond the release', () => {
  assert.match(beyondRelease(['crates/cli/src/main.rs'], reader(released)), /crates\/cli\/src\/main\.rs differs/);
  assert.match(beyondRelease(['packaging/build-packages.mjs'], reader(released)), /differs from the pinned commit/);
  const engines = {...released, 'packages/cli/package.json': {...released['packages/cli/package.json'], engines: {node: '>=22'}}};
  assert.match(beyondRelease(['packages/cli/package.json'], reader(engines)), /beyond the release's own fields/);
  const platform = {...released, 'packages/cli/package.json': {...released['packages/cli/package.json'], optionalDependencies: {'@firenook/cli-linux-riscv64': '0.2.5'}}};
  assert.match(beyondRelease(['packages/cli/package.json'], reader(platform)), /beyond the release's own fields/);
  const renamed = {...released, 'server.json': {...released['server.json'], name: 'other'}};
  assert.match(beyondRelease(['server.json'], reader(renamed)), /beyond the release's own fields/);
  assert.match(beyondRelease(['server.json'], () => { throw new Error('gone'); }), /new, gone or not JSON/);
});

test('documentation is what CI counts as documentation', () => {
  for (const file of ['README.md', 'LICENSE', 'docs/x.md', 'support/a.html', 'packaging/PUBLISHING.md', 'packages/cli/README.md', '.github/ISSUE_TEMPLATE/bug.yml']) assert.ok(documentation(file), file);
  for (const file of ['crates/cli/README.md', 'conformance/fixtures/a/README.md', 'packaging/check-release.mjs', 'console/src/a.md']) assert.ok(!documentation(file), file);
});
