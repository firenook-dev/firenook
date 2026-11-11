# Contributed rules cases: rooms

A synthetic Firestore ruleset and 29 cases, 10 allowed and 19 denied,
contributed for #156. Collections, fields and users are invented; the language
features are the ones a consumer's real rulesets use.

## What it covers

| Feature | Cases |
| --- | --- |
| a function outside the `service` block | 2 |
| the conditional operator `? :` inside a function (#138) | 3 |
| `keys().hasOnly`, `hasAll`, `hasAny` | 4 |
| type, length and list-membership checks | 3 |
| `diff().affectedKeys()` on update, `allow delete: if false` | 3 |
| `exists()` on another document | 3 |
| a field check in the proof of a `list` query (#154) | 2 |
| `get(key, default)` on the payload, `is int` | 3 |
| `get()` on the parent document | 1 |
| a `null` value on write (#158) | 1 |
| a query pinned to a missing document id (#143) | 2 |
| `matches()` on the document id | 2 |

## Files

- `firestore.rules`: the ruleset.
- `cases.json`: the seed documents and the cases in order. Each case holds the
  REST request (method, path below `/v1/projects/{project}/databases/(default)/`,
  body with `{documents}` for the documents root), the signed-in user and
  claims or `null`, the expected verdict, and the status and body observed
  from the official emulator.
- `replay.mjs`: records the cases or replays them. Node 24, no dependencies.

The cases run in order against one seed. Some of them write, and later cases
see those writes, as in the recording.

## Recording

Recorded from the official emulator `cloud-firestore-emulator-v1.22.0.jar`
(SHA-256 in `cases.json`), as downloaded by firebase-tools 15.35.0, on
OpenJDK 21. The recording fails unless every observed verdict matches the
expected one.

```sh
node replay.mjs --record --jar <cloud-firestore-emulator-v1.22.0.jar> --firebase-tools 15.35.0
```

## Replay

Against any running Firestore emulator. The script loads the rules, clears
the database, seeds it and runs the cases; it exits 1 on a verdict mismatch.

```sh
node replay.mjs --origin http://127.0.0.1:8080
```

Firenook 0.2.2 matches all 29 verdicts and all 29 status codes.
