#!/usr/bin/env node
// Whether a change was already tested where its engine is pinned. A release
// pull request, the push of its merge and the release's own quality run carry
// the engine packages/cli/release.json pins plus the release's own fields:
// the version, the pin, the toolchain and the notes. When that is all that
// differs from the pinned commit, and the pinned commit passed the named
// workflow on main, running that workflow again tests the same code a second
// time (a release used to: on main, on its pull request, and in its run).
//
//   node packaging/pinned-evidence.mjs --workflow ci.yml [--head <sha>]
//
// Prints `covered` or `run` on stdout and why on stderr. It never fails a
// build: a missing token or an API that does not answer only means `run`.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Documentation, as CI's `changes` job counts it: never read by a build or test. */
export function documentation(file) {
  if (!file.includes('/')) return /\.md$|^LICENSE$|^NOTICE$/.test(file);
  return /^(docs|brand)\//.test(file)
    || /^support\/[^/]+\.(md|html|gif)$/.test(file)
    || file === 'packages/cli/README.md'
    || /^packaging\/[^/]+\.md$/.test(file)
    || /^\.github\/[^/]+\.md$/.test(file)
    || file.startsWith('.github/ISSUE_TEMPLATE/');
}

/**
 * The release's own fields, blanked: two versions of one of these files are
 * the same release-wise when they are equal once blanked.
 */
export const RELEASE_FIELDS = {
  'packages/cli/package.json': (json) => ({
    ...json,
    version: '',
    optionalDependencies: Object.fromEntries(Object.keys(json.optionalDependencies ?? {}).map((name) => [name, ''])),
  }),
  'packages/cli/release.json': (json) => ({...json, engineRevision: '', rustToolchain: ''}),
  'server.json': (json) => ({...json, version: '', packages: (json.packages ?? []).map((entry) => ({...entry, version: ''}))}),
};

/**
 * Why `changed` (files that differ from the pinned commit) is more than a
 * release, or undefined when it is not. `read(file, side)` gives a file's
 * text at the pinned commit (`'pin'`) or at the change (`'head'`).
 */
export function beyondRelease(changed, read) {
  for (const file of changed) {
    if (documentation(file)) continue;
    const blank = RELEASE_FIELDS[file];
    if (!blank) return `${file} differs from the pinned commit`;
    let pinned;
    let head;
    try {
      pinned = blank(JSON.parse(read(file, 'pin')));
      head = blank(JSON.parse(read(file, 'head')));
    } catch {
      return `${file} is new, gone or not JSON`;
    }
    if (JSON.stringify(pinned) !== JSON.stringify(head)) return `${file} differs beyond the release's own fields`;
  }
  return undefined;
}

export const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();

/** The pinned commit's successful run of `workflow` on main, or undefined. */
export async function passedOnMain(workflow, sha) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('no repository or token to ask GitHub with');
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&per_page=50`;
  const response = await fetch(url, {
    headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json'},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const {workflow_runs: runs = []} = await response.json();
  return runs.find((run) => run.conclusion === 'success' && (run.event === 'push' || run.event === 'workflow_dispatch'));
}

async function main() {
  const option = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const workflow = option('--workflow');
  if (!workflow) throw new Error('name the workflow: --workflow ci.yml');
  const head = option('--head') || process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
  const pin = JSON.parse(git('show', `${head}:packages/cli/release.json`)).engineRevision;
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error('release.json pins no commit');
  if (git('rev-parse', `${head}^{commit}`) === pin) throw new Error('this is the pinned commit itself');
  try {
    git('merge-base', '--is-ancestor', pin, head);
  } catch {
    throw new Error(`the pinned commit ${pin.slice(0, 8)} is not in this change's history`);
  }
  const changed = git('diff', '--name-only', pin, head).split('\n').filter(Boolean);
  const read = (file, side) => git('show', `${side === 'pin' ? pin : head}:${file}`);
  const beyond = beyondRelease(changed, read);
  if (beyond) throw new Error(beyond);
  const run = await passedOnMain(workflow, pin);
  if (!run) throw new Error(`${workflow} has not passed on main for the pinned commit ${pin.slice(0, 8)}`);
  return `only the release's own fields differ from the pinned commit ${pin.slice(0, 8)}, which passed ${workflow} on main: ${run.html_url}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (why) => { console.error(`Covered: ${why}`); console.log('covered'); },
    (error) => { console.error(`Runs in full: ${error.message}`); console.log('run'); },
  );
}
