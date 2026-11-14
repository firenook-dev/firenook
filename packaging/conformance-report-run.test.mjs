import assert from 'node:assert/strict';
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
