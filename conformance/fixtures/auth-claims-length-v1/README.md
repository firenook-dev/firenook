# Auth custom-claims length corpus

How the official Firebase Auth emulator measures custom claims against its
1,000 limit, recorded against firebase-tools 15.22.0 (`AuthEmulator`, in
process) with the runner, functions stub and normalization of the Phase I1
corpus (`../auth-v1`, whose README describes the templates). Everything is
synthetic: no credentials, no real user data, no access tokens.

| File | Contents |
| --- | --- |
| `emulator-programs.json` | `1` program / `18` steps: every step with its request, the normalized response, the emulator's log lines and the calls the functions stub received |
| `SHA256SUMS` | digests frozen in `benchmarks/auth-claims-length.json` (`capture.frozenFixtureSha256`) |

The plan is `conformance/src/auth/claims-length-plan.ts`. Re-record with
`FIREBASE_TOOLS_15_22_ROOT=<firebase-tools 15.22.0> npm run
capture:auth:claims-length` (a few seconds). Two consecutive recordings were
byte for byte identical apart from `capturedAt` / `completedAt`.

It is a corpus of its own, rather than a program added to `auth-v1`, so the
frozen Phase I1 corpus and its receipt are never rewritten; the replay runs
both.

## Program

| Program | Category | Steps | Title |
| --- | --- | --- | --- |
| `custom-claims-length` | claims | 18 | custom claims are measured in UTF-16 code units: é counts one, 🔥 counts two, at 999 to 1,001 |

Each claims object is `{"k":"<value>"}` sized to an exact JavaScript length:
`é` is one UTF-16 code unit and two UTF-8 bytes, `🔥` is two code units (a
surrogate pair) and four bytes. A 1,000-unit object of `é` is about 1,990
UTF-8 bytes.

| Step | Path | Claims | Official answer |
| --- | --- | --- | --- |
| `ascii-1000`, `ascii-1001` | privileged `accounts:update` | ASCII, 1,000 / 1,001 | `200` / `400 CLAIMS_TOO_LARGE` |
| `accented-999`, `accented-1000`, `accented-1001` | privileged `accounts:update` | `é`, 999 / 1,000 / 1,001 | `200` / `200` / `400 CLAIMS_TOO_LARGE` |
| `emoji-1000`, `emoji-1001` | privileged `accounts:update` | `é` ending in `🔥`, 1,000 / 1,001 (999 / 1,000 characters) | `200` / `400 CLAIMS_TOO_LARGE` |
| `lookup-accented`, `lookup-emoji` | `accounts:lookup` | — | the accepted claims, stored verbatim |
| `signin-carries-claims` | `signInWithPassword` | — | the ID token carries the 1,000-unit claim |
| `import` | `batchCreate` | `é` and `é`+`🔥`, 1,000 / 1,001 each | `200` with per-index errors `Custom claims provided are too large.` for the two 1,001-unit users |
| `imported` | `accounts:lookup` | — | only the 1,000-unit users exist |
| `blocking-accented-1000`, `blocking-emoji-1000` | `signUp` with a beforeCreate function returning `customClaims` | 1,000 | `200`, the claims stored and minted |
| `blocking-emoji-1001` | the same | 1,001 | `400 CLAIMS_TOO_LARGE`; no account is created |
| `lookup-blocking` | `accounts:lookup` by email | — | the two accepted sign-ups only |

## What the official emulator does

- `validateSerializedCustomClaims` compares `claims.length` with 1,000: the
  JavaScript string length, in UTF-16 code units. Bytes do not count, and
  neither do characters: a character outside the Basic Multilingual Plane
  counts two.
- The same measure applies on every path that validates a serialized claims
  object: the privileged `accounts:update`, `batchCreate` (per user) and a
  blocking function's `customClaims` (serialized with `JSON.stringify` before
  the check).

## Replay

`npm run replay:auth -- --binary <firenook>` replays this corpus after
`auth-v1` (`--corpus=auth-claims-length-v1` replays it alone). Firenook used
to measure UTF-8 bytes, which refused every accented or emoji case near the
limit: 59 mismatches in 11 of the 18 steps. It now counts UTF-16 code units
and the corpus replays at 0 mismatches, with no named divergence.
