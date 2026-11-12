#!/usr/bin/env node
// Lays out the two public registry Extensions of the `consumer-refs` profile
// as an Extensions source cache, so the profile replays where no Firebase CLI
// login exists (CI):
//
//   node conformance/src/functions-runtime/fetch-registry-sources.mjs <cache-dir>
//
// Each published source archive is fetched from the registry's public
// content-addressed store, checked against its SHA-256 (the registry's
// `extensionVersion.hash`, which names the object), unpacked to
// `<cache-dir>/<publisher>/<name>@<version>`, and its Functions dependencies
// installed from the archive's own lockfile without scripts. Next to it goes
// the registry's version record (`firenook-registry.json`), which the engine
// reads instead of asking the registry: the copy in
// `fixtures/extensions-registry-v1`, checked against its SHA256SUMS. The
// replay hands the engine only HOME, USER, LOGNAME, LANG, TZ and PATH, so CI
// lays the cache at the engine's default, `$HOME/.cache/firebase/extensions`.
// A source already in the cache is left as it is, and gets the record only
// when it has none. Node 24; needs `unzip` and `npm` on PATH.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The profile's two Extensions (`project.ts`), at the versions it records. */
export const SOURCES = [
  { ref: 'invertase/firestore-stripe-payments@0.3.12', sha256: '33b43e09f4c86126d3c761ab1da5c2b0243a8797c204a4b4580d07e5bbc51e30' },
  { ref: 'algolia/firestore-algolia-search@1.2.10', sha256: 'bf3bebef836a4d00847d8766756acb75d2dff6b3b089488bd6c90ac03c38ff57' },
];
const STORE = 'https://storage.googleapis.com/firebase-mod-sources-prod/';
const RECORDS = fileURLToPath(new URL('../../fixtures/extensions-registry-v1/', import.meta.url));
const SIDECAR = 'firenook-registry.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The registry's record of `ref`, checked against the fixture's SHA256SUMS and the archive's hash. */
function record(ref, sha256) {
  const name = `${ref.replace('/', '-')}.json`;
  const sums = new Map(readFileSync(join(RECORDS, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()));
  const bytes = readFileSync(join(RECORDS, name));
  if (sums.get(name) !== sha(bytes)) throw new Error(`${name}: not the content SHA256SUMS lists`);
  const parsed = JSON.parse(bytes);
  if (parsed.extensionVersion?.ref !== ref || parsed.extensionVersion?.hash !== sha256) throw new Error(`${name}: not the record of ${ref} with source ${sha256}`);
  return join(RECORDS, name);
}

async function main() {
  const cache = process.argv[2];
  if (!cache) {
    console.error('usage: node conformance/src/functions-runtime/fetch-registry-sources.mjs <cache-dir>');
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'registry-sources-'));
  try {
    for (const { ref, sha256 } of SOURCES) {
      const target = join(cache, ...ref.split('/'));
      const sidecar = record(ref, sha256);
      if (existsSync(join(target, 'extension.yaml'))) {
        if (!existsSync(join(target, SIDECAR))) copyFileSync(sidecar, join(target, SIDECAR));
        console.log(`${ref}: already in the cache`);
        continue;
      }
      const response = await fetch(STORE + sha256);
      if (!response.ok) throw new Error(`${ref}: ${response.status} ${response.statusText} from the registry's source store`);
      const archive = Buffer.from(await response.arrayBuffer());
      const actual = sha(archive);
      if (actual !== sha256) throw new Error(`${ref}: the source archive's SHA-256 is ${actual}, not ${sha256}`);
      const file = join(scratch, `${sha256}.zip`);
      writeFileSync(file, archive);
      mkdirSync(target, { recursive: true });
      execFileSync('unzip', ['-q', file, '-d', target], { stdio: 'inherit' });
      execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(target, 'functions'), stdio: 'inherit' });
      copyFileSync(sidecar, join(target, SIDECAR));
      console.log(`${ref}: ${archive.length} bytes, SHA-256 checked, unpacked and installed, with the registry's record`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
