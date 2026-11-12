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
// installed from the archive's own lockfile without scripts. Point
// FIREBASE_EXTENSIONS_CACHE_PATH at <cache-dir>, with FIRENOOK_OFFLINE=1, for
// the replay. A cache entry that is already there is left as it is. Node 24;
// needs `unzip` and `npm` on PATH.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The profile's two Extensions (`project.ts`), at the versions it records. */
export const SOURCES = [
  { ref: 'invertase/firestore-stripe-payments@0.3.12', sha256: '33b43e09f4c86126d3c761ab1da5c2b0243a8797c204a4b4580d07e5bbc51e30' },
  { ref: 'algolia/firestore-algolia-search@1.2.10', sha256: 'bf3bebef836a4d00847d8766756acb75d2dff6b3b089488bd6c90ac03c38ff57' },
];
const STORE = 'https://storage.googleapis.com/firebase-mod-sources-prod/';

async function main() {
  const cache = process.argv[2];
  if (!cache) {
    console.error('usage: node conformance/src/functions-runtime/fetch-registry-sources.mjs <cache-dir>');
    process.exit(2);
  }
  const scratch = mkdtempSync(join(cache, '..', '.registry-sources-'));
  try {
    for (const { ref, sha256 } of SOURCES) {
      const target = join(cache, ...ref.split('/'));
      if (existsSync(join(target, 'extension.yaml'))) {
        console.log(`${ref}: already in the cache`);
        continue;
      }
      const response = await fetch(STORE + sha256);
      if (!response.ok) throw new Error(`${ref}: ${response.status} ${response.statusText} from the registry's source store`);
      const archive = Buffer.from(await response.arrayBuffer());
      const actual = createHash('sha256').update(archive).digest('hex');
      if (actual !== sha256) throw new Error(`${ref}: the source archive's SHA-256 is ${actual}, not ${sha256}`);
      const file = join(scratch, `${sha256}.zip`);
      writeFileSync(file, archive);
      mkdirSync(target, { recursive: true });
      execFileSync('unzip', ['-q', file, '-d', target], { stdio: 'inherit' });
      execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(target, 'functions'), stdio: 'inherit' });
      console.log(`${ref}: ${archive.length} bytes, SHA-256 checked, unpacked and installed`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
