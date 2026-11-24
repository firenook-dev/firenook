import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chooseReportRun } from './conformance-report-run.mjs';

test('a release run with its own conformance report attaches it', () => {
  assert.equal(chooseReportRun({source: 7, sourceHasReport: true}), '7');
});

test('a covered release attaches the pinned engine CI run report', () => {
  assert.equal(chooseReportRun({source: 7, sourceHasReport: false, pinnedRun: 3, pinnedHasReport: true}), '3');
});

test('a release that differs beyond its own fields never borrows a report', () => {
  assert.throws(
    () => chooseReportRun({source: 7, sourceHasReport: false, beyond: 'crates/x.rs differs from the pinned commit', pinnedRun: 3, pinnedHasReport: true}),
    /not the pinned engine's: crates\/x.rs/,
  );
});

test('no report anywhere fails the release notes instead of attaching none', () => {
  assert.throws(() => chooseReportRun({source: 7, sourceHasReport: false}), /has not passed on main/);
  assert.throws(() => chooseReportRun({source: 7, sourceHasReport: false, pinnedRun: 3, pinnedHasReport: false}), /neither run 7 nor/);
});

test('the release notes job checks out the history the script compares', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-npm.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const job = workflow.split(/^  (?=[a-z-]+:$)/m).find((text) => text.startsWith('release-notes:'));
  assert.match(job, /conformance-report-run\.mjs/);
  const checkout = job.split(/^      - /m).find((step) => step.startsWith('uses: actions/checkout@'));
  assert.match(checkout, /^          fetch-depth: 0$/m, 'a depth-1 checkout has no pinned commit to diff against');
});
