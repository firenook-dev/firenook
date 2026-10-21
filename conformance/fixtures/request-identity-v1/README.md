# Request identity: who a Firestore request is from

A synthetic capture of the official Firestore emulator 1.22.0 (jar hash,
Node and Java recorded in `fixture.json`). No cloud project, consumer source
or document data is involved; every token is an unsigned `demo-*` token built
at capture time, and the fixture keeps descriptions of the headers, never the
headers themselves. Reproduce with Node 24.20.0 and the pinned jar in the
Firebase CLI cache (or `FIREBASE_EMULATORS_PATH` / `FIRESTORE_EMULATOR_JAR`):

```
npm run capture:rules:identity --prefix conformance -- --output /tmp/fresh-request-identity
```

The capture starts three emulators: one with `identityRules`
(`src/rules/request-identity-cases.ts`), one without rules, and one in
Enterprise edition with the same rules. It records:

- **reads**: every identity reads `deny/x` (`if false`), `anon/x`
  (`request.auth == null`) and `alice/x` (`request.auth.uid == 'alice'`) on
  `(default)` and on `unlisted`, a database the emulator was never told
  about, over gRPC (`GetDocument`) and REST (`GET /v1/{name}`).
- **claims**: what `request.auth` holds for each token: `uid` is `sub` when
  `sub` is a string and null otherwise (never `user_id`), and
  `request.auth.token` is the whole payload.
- **denials**: the message of a refused read with two allows, a path no
  allow matches and a refused create.
- **metadata**: `ListCollectionIds` over gRPC and REST, and `PartitionQuery`
  over gRPC, with and without rules.
- **pipelines**: an Enterprise pipeline and a query as a user and as the
  owner.
- **reload**: the rules reload route (`PUT
  /emulator/v1/projects/{project}:securityRules`) with an `application/json`,
  a `text/plain;charset=UTF-8` (what `fetch` sends for a string body, as
  `@firebase/rules-unit-testing` does) and no content type.
- **sdkHeaders**: the `Authorization` each SDK sends, recorded by a listener
  that refuses every request: the Admin SDK sends `Bearer owner`; the client
  SDK sends nothing when signed out, over gRPC (Node) and REST (lite), and a
  `mockUserToken` is an unsigned token issued at time 0 that expires at 3600.

What it shows:

- A request without an `Authorization` header is a signed-out client on
  gRPC as on REST: the rules decide, and `request.auth` is null.
  `Bearer owner` is the only administrator credential, in any letter case.
- A token is read, not verified: its times, its project (`aud`, `iss`), its
  algorithm and signature, and its claims are not checked. Three
  base64 segments whose first two are JSON objects are a token, padded or
  not; anything else is `INVALID_ARGUMENT` "invalid jwt". A credential that
  is not `Bearer` is an empty `UNKNOWN` (gRPC 2, HTTP 500).
- One rules file governs every database of the project, the unlisted one
  included.
- `ListCollectionIds` needs the owner, with rules and without:
  `PERMISSION_DENIED` "Metadata operations require admin authentication.".
  `PartitionQuery` is not implemented by this jar (`UNIMPLEMENTED`).
- Pipelines are evaluated by the rules as a `list`, as queries are.
- The reload route reads the body as JSON whatever its content type says.
- A denial names each allow that refused it, `false for 'get' @ L11`, or "No
  matching allow statements" when no allow applies. Production answers
  "Missing or insufficient permissions.".

`test/request-identity-fixture.test.mjs` checks the fixture and these
statements; `test/request-identity-replay.test.ts` replays the same capture
against Firenook and compares it through
`src/rules/request-identity-verification.ts`, whose divergence table holds
the real differences: Firenook answers a non-`Bearer` credential
`INVALID_ARGUMENT` naming the problem, as it answers any credential it
cannot read, where the jar answers an empty `UNKNOWN` that the SDKs retry;
and Firenook serves `PartitionQuery` (the Admin SDKs' `getPartitions()`) to
the owner and refuses everyone else with `PERMISSION_DENIED`, as the jar
refuses the other read no rule governs, `ListCollectionIds`, where the jar
does not implement it.
