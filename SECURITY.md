# Security boundaries

This is a local development emulator, not a production database or network
sandbox. Use synthetic accounts and demo projects. Do not expose its
ports publicly or import production credentials. User Functions may make
outbound requests independently of the emulator.

Report suspected sensitive exposure privately to the repository owner; do not
paste secrets, user exports or private application logs in public issues.

Source review and actual-package allowlists reduce accidental publication risk;
neither proves that formerly accessible material was never copied. Updating a
package does not erase older immutable package versions.

## What the package installs and runs

The `firenook` npm package has no dependencies of its own and no install
script. Its only other packages are the five optional platform packages
(`@firenook/cli-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`,
`-win32-x64`), of which npm installs the one for the host: each holds the
native engine and a receipt with its SHA-256, which the launcher checks
before it runs the binary (a mismatch refuses to run). The launcher itself
is plain Node with no third-party modules.

Nothing is fetched at run time. Since `0.1.0-next.7` neither firebase-tools
nor Java is installed or run: Functions, Extensions and Storage rules run in
Firenook's own runtime. Since `0.2.0-next.3` the console is part of the
binary, and `firenook setup` downloads nothing. The CLI reaches the network
in two places only: the update check asks the npm registry for `firenook`'s
version tags at most once a day (off in CI, in the plain output and with
`FIRENOOK_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`), and an Extension instance that is neither a
local path nor vendored is resolved from the Extensions registry with the
Firebase CLI's stored login or `FIREBASE_TOKEN` (`firenook ext:vendor`
copies it into the project, and `--offline` or `FIRENOOK_OFFLINE=1` turns
any remaining registry access into a start-up error).

Your Functions run on your Node 24 with the packages of your own codebase
(`firebase-functions`, `firebase-admin` and what they bring); their
advisories are your project's, as they are in production, and the emulator
does not sandbox them. The conformance tooling in this repository pins
firebase-tools 15.28.1 to record the official emulator's behaviour; it is
development tooling and is not part of any package.

## Earlier reviews

The reviews below describe the `0.1.0-next.2` era, when the CLI installed a
Functions compatibility host built on firebase-tools 15.22.0. They are kept
as they were recorded; none of those dependencies ships today.

### Dependency review during source preparation

On 2026-09-09 MYT, `npm audit --json` reported the following dependency entries
(including transitive propagation, not distinct vulnerabilities):

| Isolated installation | Moderate | High / critical |
| --- | ---: | ---: |
| Pinned conformance development lockfile | 9 | 0 / 0 |
| Packed CLI and native package only, production dependency closure | 9 | 0 / 0 |
| Tiny suite consumer, additionally using Firestore 9.0.0 and firebase-functions 7.2.5 | 16 | 0 / 0 |

They include transitive OpenTelemetry, qs, stream-json and uuid advisories.
These JavaScript dependencies are not bundled into the native binary, but are
installed alongside the CLI for its Functions compatibility host. They are
not harmless merely because this is local development. The additional suite
dependencies belong to the synthetic consumer, not the CLI manifest.

The oracle versions have not been silently changed or force-downgraded to make
an audit summary green. Updates require a separate pinned compatibility check.
Before publication, refresh both audits and review remaining findings. The
registry's suggested automatic fixes included breaking version changes; none
was applied. This release does not claim a zero-advisory dependency closure.
Relevant advisories:
[OpenTelemetry](https://github.com/advisories/GHSA-8988-4f7v-96qf),
[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
[stream-json](https://github.com/advisories/GHSA-528h-pc64-c93x),
[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

### Prerelease publication review

The release preparation refresh on 2026-09-09 MYT found **11 moderate** entries
in the conformance lockfile, **10 moderate** entries in a new production-only
installation of the exact `0.1.0-next.2` CLI/native archives, and **16 moderate**
entries in the retained tiny-suite consumer. All three had zero high/critical
entries. The earlier table is preserved as its original snapshot; advisory
feeds and newly resolved transitive dependencies can change between checks.
Conformance tooling pins firebase-tools 15.28.1; the shipped Functions
compatibility host pins 15.22.0. These are different audited scopes.

The refresh additionally reports
[csv-parse prototype replacement](https://github.com/advisories/GHSA-8cw4-87c7-c6xx)
and, in the conformance lockfile,
[morgan log forging](https://github.com/advisories/GHSA-jxfw-x594-9x9m).
The qs findings also include an
[array-limit bypass](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx).

Review of the installed 15.22.0 source places csv-parse in its Auth-import
command, stream-json filters in its import/framework commands, and morgan in
its Hosting server. The reviewed gaxios call uses UUID v4, rather than the
advisory's caller-provided-buffer v3/v5/v6 path. These observations narrow
those specific call paths; they do not prove every transitive use unreachable.
Express/qs request parsing and OpenTelemetry input handling still warrant
care around untrusted traffic and data.

This distribution-cleanup prerelease leaves dependency versions and engine
behavior unchanged. It is limited to local development with trusted synthetic
inputs and loopback access, not public hosting or hostile-data isolation.
Do not treat these advisories as fixed or harmless. A pinned, compatibility-
tested dependency upgrade is follow-up work; no force downgrade, audit
suppression or zero-advisory claim is part of this release.
