#!/usr/bin/env node
// Which run holds the conformance report a release's GitHub release carries.
// The release run's own quality job writes it, unless those gates were
// covered by the pinned engine's CI run on main (packaging/pinned-evidence.mjs):
// then that run's report is the report of the same source.
//
//   node packaging/conformance-report-run.mjs <release run id>
//
// Prints `run=<id>` for $GITHUB_OUTPUT, or fails naming why there is none.
import { pathToFileURL } from 'node:url';
import { beyondRelease, git, passedOnMain } from './pinned-evidence.mjs';

export const REPORT = 'conformance-ledger-report';

/**
 * The run whose report to attach: the release run's own when it has one,
 * else the pinned commit's CI run on main, only when the release differs
 * from that commit in the release's own fields alone.
 */
export function chooseReportRun({source, sourceHasReport, beyond, pinnedRun, pinnedHasReport}) {
  if (sourceHasReport) return String(source);
  if (beyond) throw new Error(`run ${source} has no ${REPORT}, and its source is not the pinned engine's: ${beyond}`);
  if (!pinnedRun) throw new Error(`run ${source} has no ${REPORT}, and ci.yml has not passed on main for the pinned commit`);
  if (!pinnedHasReport) throw new Error(`neither run ${source} nor the pinned commit's CI run ${pinnedRun} has a ${REPORT}`);
  return String(pinnedRun);
}

async function hasReport(run) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run}/artifacts?name=${REPORT}`, {
    headers: {authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json'},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for run ${run}'s artifacts`);
  const {artifacts = []} = await response.json();
  return artifacts.some((artifact) => artifact.name === REPORT && !artifact.expired);
}

async function main() {
  const source = process.argv[2];
  if (!/^\d+$/.test(source ?? '')) throw new Error('name the release run: conformance-report-run.mjs <run id>');
  if (await hasReport(source)) return chooseReportRun({source, sourceHasReport: true});
  const head = git('rev-parse', 'HEAD');
  const pin = JSON.parse(git('show', `${head}:packages/cli/release.json`)).engineRevision;
  const changed = git('diff', '--name-only', pin, head).split('\n').filter(Boolean);
  const beyond = beyondRelease(changed, (file, side) => git('show', `${side === 'pin' ? pin : head}:${file}`));
  const pinned = beyond ? undefined : await passedOnMain('ci.yml', pin);
  return chooseReportRun({
    source, sourceHasReport: false, beyond, pinnedRun: pinned?.id,
    pinnedHasReport: pinned ? await hasReport(pinned.id) : false,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (run) => { console.error(`The conformance report comes from run ${run}`); console.log(`run=${run}`); },
    (error) => { console.error(error.message); process.exit(1); },
  );
}
