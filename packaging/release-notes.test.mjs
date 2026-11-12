import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotes } from './release-notes.mjs';

const changelog = [
  '# 0.2.4 — newer',
  '',
  '- four',
  '',
  '# 0.2.3 — the one asked for',
  '',
  '- three',
  '',
  '```sh',
  '# a shell comment, not a heading',
  '```',
  '',
  '## a smaller heading inside it',
  '',
  '# 0.2.3-next.1 — a prerelease of it',
  '',
  '- earlier',
  '',
].join('\n');

test('a release gets its own section, up to the next release', () => {
  assert.equal(
    releaseNotes(changelog, '0.2.3'),
    '# 0.2.3 — the one asked for\n\n- three\n\n```sh\n# a shell comment, not a heading\n```\n\n## a smaller heading inside it\n',
  );
  assert.equal(releaseNotes(changelog, '0.2.4'), '# 0.2.4 — newer\n\n- four\n');
  assert.equal(releaseNotes(changelog, '0.2.3-next.1'), '# 0.2.3-next.1 — a prerelease of it\n\n- earlier\n');
});

test('a version is matched whole, and a missing one stops the release', () => {
  assert.throws(() => releaseNotes(changelog, '0.2'), /no "# 0\.2" section/);
  assert.throws(() => releaseNotes(changelog, '0.2.5'), /no "# 0\.2\.5" section/);
});

test('the newest section of the real changelog is found and ends before the one after it', () => {
  const real = readFileSync(new URL('CHANGELOG.md', import.meta.url), 'utf8');
  const newest = real.match(/^# (\S+)/m)[1];
  const notes = releaseNotes(real, newest);
  assert.ok(notes.startsWith(`# ${newest}`));
  assert.equal(notes.match(/^# \S/gm).length, 1);
});
