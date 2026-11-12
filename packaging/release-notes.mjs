// The notes of one release: its section of packaging/CHANGELOG.md, from its
// `# VERSION` heading to the next release's. The release job drafts the
// GitHub release with these instead of the whole changelog, which the
// release owner had to cut down by hand.
//
//   node packaging/release-notes.mjs VERSION [CHANGELOG]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The section of `changelog` whose heading names `version`, trimmed. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const heading = line => /^# \S/.test(line);
  const named = line => line === `# ${version}` || line.startsWith(`# ${version} `);
  let fenced = false;
  let start = -1;
  let end = lines.length;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !heading(line)) continue;
    if (start === -1) {
      if (named(line)) start = index;
    } else {
      end = index;
      break;
    }
  }
  if (start === -1) throw new Error(`The changelog has no "# ${version}" section`);
  return `${lines.slice(start, end).join('\n').trim()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, file = new URL('CHANGELOG.md', import.meta.url)] = process.argv.slice(2);
  if (!version) throw new Error('Usage: node packaging/release-notes.mjs VERSION [CHANGELOG]');
  process.stdout.write(releaseNotes(readFileSync(file, 'utf8'), version));
}
