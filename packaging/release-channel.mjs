// The npm dist-tag each package of a release is published to. Every package
// goes to next. A run dispatched with `latest` puts the CLI on latest instead,
// in its one OIDC publish: npm sets one tag per publish and trusted publishing
// cannot run `npm dist-tag`, so the CLI's next then stays on the previous
// release. Native packages never need latest; the CLI pins their exact versions.
import assert from 'node:assert/strict';

export function releaseLatest(env = process.env) {
  assert.ok([undefined, '', 'false', 'true'].includes(env.RELEASE_LATEST), 'RELEASE_LATEST must be true or false');
  return env.RELEASE_LATEST === 'true';
}

export const publishTag = (record, {latest = false} = {}) => latest && record.name === 'firenook' ? 'latest' : 'next';

// Shown to the protected environment's approver and in the publish log.
export function channelNote(version, {latest = false} = {}) {
  return latest
    ? `This run publishes the CLI to \`latest\`: firenook@${version} → latest, the five native packages → next. ` +
      'The CLI\'s `next` stays on the previous release: npm sets one tag per publish and OIDC cannot move tags.'
    : `This run publishes the CLI to \`next\` (default): firenook@${version} and the five native packages → next.`;
}
