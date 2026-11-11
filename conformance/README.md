# Conformance: recorded answers, replayed against Firenook

`fixtures/` holds what the official emulator, and for some surfaces
production Firebase, answered to synthetic requests: 41 recorded sets, about
6,500 answers, from firebase-tools and the Firestore emulator, and from Cloud
Firestore and the Firebase Rules API in projects that hold only made-up
data. A set's README says what it covers, which version recorded it and
how. The Rust tests and the Node replays here run Firenook against them on
every pull request.

## What is checked, case by case

- `src/report/cases.mjs` lists every recorded answer: one entry per request
  (or rules expression, or rules test case) a reference answered, with the
  set, the reference and its version. Each recording is counted once.
- Every replay notes each case it compared, and what it compared (`answer`,
  `error`, `status`, `verdict` or `behaviour`), in a ledger when
  `FIRENOOK_CONFORMANCE_LEDGER` names a directory: `crates/conformance-ledger`
  for the Rust tests, `src/report/ledger.mjs` for the Node replays. A case
  where Firenook answers differently on purpose is noted as `differs`, with
  the reason its test asserts.
- `src/report/verify.mjs` joins the two: per case `checked`, `differs` or
  `unreplayed`, and per set the counts. CI's `conformance-ledger` job runs it
  on every pull request, and the release attaches `conformance-cases.json`
  and `conformance-verify.json` to its GitHub release, which
  firenook.dev/compatibility is built from.

From the repository root:

```sh
FIRENOOK_CONFORMANCE_LEDGER=/tmp/ledger cargo test --workspace
node conformance/src/report/cases.mjs /tmp/cases.json
node conformance/src/report/verify.mjs /tmp/cases.json /tmp/ledger /tmp/verify.json
```

`cases.mjs --history` counts a past release's fixtures (a set not recorded
then is left out).

## Adding a recording

A new directory under `fixtures/` with a README (what it covers, which
firebase-tools or emulator version recorded it, how), the recorded requests
and answers with synthetic names only, and a replay that compares Firenook
with them and notes each case in the ledger. `rules-v2/complex-rules-cases.json`
is the shape for a rules file and its cases. Recordings are never rewritten:
a new version is a new directory.

## The Storage captures

The three Storage oracle captures below are described in detail because
they are recorded with their own scripts:

| Capture | Observed scope |
| --- | --- |
| `storage-content-encoding` | Five upload/copy paths, both APIs, gzip and decoded downloads, ranges, browser-equivalent JSON decode and exported metadata |
| `storage-list-pagination` | 1,002 synthetic objects, default and explicit page sizes, continuation tokens and SDK auto-pagination |
| `storage-missing-object` | Both APIs' metadata/media 404s and the browser image error with an HTTP response rather than a failed request |

These are new recordings made on 2026-09-09 from the local official Storage
emulator in firebase-tools **15.22.0**. They are not rewritten historical
captures. The bucket is `synthetic-objects.example.test`; all servers bind to
ephemeral loopback ports and use local `demo-*` projects. No cloud access or
application dataset is needed. `Bearer owner` is an emulator-only test identity.
Random download tokens and upload session IDs refer only to the isolated
synthetic objects from the capture.

Each fixture records official module SHA-256 values and relevant SDK/browser
versions. `SHA256SUMS` covers the fixture bytes; captured body records also carry
base64, byte lengths and SHA-256. Timestamps and local ports are measurements,
not stable expected identifiers. The capture machine used macOS arm64, Node
24.20.0 and Java 25.0.1; this is not a Java 26 or cross-platform CI result.

## Check

```sh
npm ci --ignore-scripts
npm run check
npm run test:storage-fixtures
```

The committed dependency lock is retained for reproducibility. This preparation
does not declare the dependency audit clean; reported advisories need separate
review before release. Do not run an automatic breaking dependency upgrade to
make an oracle check appear green.

## Record independently

Use an isolated installed firebase-tools 15.22.0 tree and its Storage rules
runtime asset. Set `FIREBASE_TOOLS_15_22_ROOT` to that package directory. The
scripts verify its version and do not download a different oracle implicitly.
The missing-object case also needs an installed Chrome (`CHROME_BIN` may select
its executable).

Run from this directory. Choose **new output directories** using
`STORAGE_ENCODING_FIXTURE_OUTPUT`, `STORAGE_PAGINATION_FIXTURE_OUTPUT` or
`STORAGE_MISSING_OBJECT_FIXTURE_OUTPUT`, then run the corresponding
`capture:storage:encoding`, `capture:storage:pagination` or
`capture:storage:missing` npm command. Existing recordings are exclusive-create
and must not be overwritten. Capture logs and temporary exports are local
diagnostic material, not automatically approved repository content.
