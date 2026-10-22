# Versions and verification

[Docs](README.md) · Versions and verification

How Firenook is versioned and released, what each release has passed, and how
to check what you installed.

## Channels and versions

Every release is published to npm as `firenook`, with one native package per
platform (`@firenook/cli-<platform>`) that npm or Bun selects for you. Install
`latest`; `next` carries a preview when one is ahead of it. The
[releases](https://github.com/firenook-dev/firenook/releases) page lists each
version with its engine revision, platform checks and publication receipt.
Pin an exact version (`--save-exact`) when you need a reproducible install;
Firenook never upgrades itself, and its start-up screen tells you when a newer
release is out on your channel (on a preview, also a later release on
`latest`).

## What you installed

Package version is separate from native engine version. `firenook --version`
prints the package version and exact engine source revision. `binary-path`
verifies the installed platform package's source/version/hash before returning
its native executable. Receipts are integrity checks, not a substitute for npm
registry provenance and your lockfile.

The package pins its engine in `release.json`, including native Windows lifecycle,
disk startup and the Auth export/import and popup/redirect flows. Since
`0.1.0-next.8` Auth carries every operation of the official Auth emulator,
replayed from a recorded corpus: every sign-in method with the fake IdP
credentials the official emulator accepts, tenants, SMS MFA, passkeys, OOB and
phone codes, blocking functions and export/import. Imported accounts can be
selected without real Google credentials; disabled accounts remain rejected.
Real provider round trips, real email/SMS delivery and the routes the official
emulator itself answers with 501 are not provided.
Release checks cover SDK conformance and packed installation, plus synthetic
read/write, listener, disk-reopen and export/import scenarios. A check passing
for one engine revision or consumer does not certify another revision or every
application. Performance figures come from recorded runs on the release
they name ([benchmarks](benchmarks.md)) and hold for the workload measured;
measure your own representative workload before relying on them.

Functions execution uses the user's Node with Firenook's runtime; user code
can still reach external services. Pub/Sub is a full emulator since
`0.1.0-next.8` (pull, streaming pull, push, ordering, filters, dead-letter,
seek, snapshots, Avro schemas); Protocol Buffer schemas, IAM and export
subscriptions are not, and neither are Realtime Database, Hosting, App Hosting
and Data Connect. The [console](console.md) covers every service the suite runs.
Windows power-loss durability and network filesystems have not been qualified;
the native Windows checks cover local-disk writes, reopen, export and import.

## What a release has passed

Release CI builds and checks the native packages on macOS arm64/x64, Linux
glibc arm64/x64 and Windows x64; a platform is supported for a release only by
that release's passing run. The Linux engines are linked against glibc 2.28;
the run reads each packed engine's glibc symbol versions, fails one that asks
for more, and starts it in AlmaLinux 8, Debian 11, Ubuntu 22.04 and
node:24-slim containers. Behaviour is pinned to the official emulator by
recorded conformance fixtures that every pull request replays. Releases are
also run side by side with the official emulator under a real application's
workload (the [benchmarks](benchmarks.md) come from the 0.2.0-next.6 run). Publication needs
reviewed source, public npm provenance and a protected release-owner approval;
see [security boundaries](../SECURITY.md) for local-only use and disclosure.

## History

Earlier `0.1.0-next.2` archives retain their original signed npm provenance and
hashes. Their original build (34294395101) and recovery publication
(34309740019) belong to the former repository, now archived privately; those
Actions links are no longer public verification links. Source cleanup does not
alter existing npm archives or qualify a changed engine. See
[source-history maintenance](../packaging/SOURCE-HISTORY.md) before updating an
older clone; releases from this repository are verified under their own source
identity, and earlier attestations are not rewritten.
