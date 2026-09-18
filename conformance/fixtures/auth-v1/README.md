# Auth oracle corpus (Phase I1)

Raw HTTP programs recorded against the official Firebase Auth emulator
(firebase-tools 15.22.0 `AuthEmulator`, in process) with a recording HTTP
server registered as the Functions emulator, so that user lifecycle
multicasts and blocking-function calls are observed as well. Everything is
synthetic: no credentials, no real user data, no access tokens.

| File | Contents |
| --- | --- |
| `emulator-programs.json` | `61` programs / `1068` steps, every step with its request, the normalized response (status, selected headers, body), the emulator's log lines and the calls the functions stub received |
| `SHA256SUMS` | digests frozen in `benchmarks/phase-i-auth.json` (`capture.frozenFixtureSha256`) |

Re-record with `FIREBASE_TOOLS_15_22_ROOT=<firebase-tools 15.22.0> npm run
capture:auth:emulator` (about three minutes; `--programs=a,b` records a subset,
`--debug` prints raw responses). Two recordings differ only in `capturedAt` /
`completedAt`: the normalization below removes every run-dependent value, which
consecutive recordings confirmed byte for byte (three under the first
normalization, two after the sorted-key walk that made `#n` numbering
independent of response key order).

## Programs

Every program starts on a fresh emulator instance (fresh project state, no
leftover codes) so a failing step localizes. Plan: `conformance/src/auth/emulator-plan.ts`;
runner: `conformance/src/auth/capture-emulator.ts`; normalization shared with
the replay: `conformance/src/auth/normalize.ts`.

| Program | Category | Steps | Title |
| --- | --- | --- | --- |
| `signup-validation` | password | 19 | signUp validation order, canonical email and the issued tokens |
| `signin-password` | password | 16 | signInWithPassword success and every recorded failure |
| `improved-email-privacy` | password | 12 | emailPrivacyConfig.enableImprovedEmailPrivacy masks enumeration |
| `anonymous` | password | 12 | anonymous sign-up, its token claims and the upgrade to email+password |
| `create-auth-uri` | password | 16 | createAuthUri reports registration and sign-in methods |
| `owner-signup` | admin | 19 | privileged signUp (Admin SDK createUser) fields and errors |
| `idp-google` | idp | 10 | signInWithIdp with a fake Google id_token: new user, repeat, profile and verification fields |
| `idp-request-forms` | idp | 4 | signInWithIdp credential forms: fragment, query, JWT id_token, access_token alongside |
| `idp-providers` | idp | 13 | every provider id the widget offers plus OIDC and SAML |
| `idp-errors` | idp | 14 | signInWithIdp request validation and the not-implemented credential forms |
| `idp-email-collision` | idp | 15 | one account per email: federated sign-in against existing password accounts |
| `idp-duplicate-emails-allowed` | idp | 13 | signIn.allowDuplicateEmails changes federated sign-in and sign-up semantics |
| `idp-link-unlink` | idp | 20 | linking a federated identity to a signed-in account and unlinking it |
| `custom-token` | custom | 23 | signInWithCustomToken: JSON and JWT tokens, claims and validation |
| `oob-verify-email` | oob | 22 | VERIFY_EMAIL: send, list, consume via update and via the action page |
| `oob-password-reset` | oob | 25 | PASSWORD_RESET: send, resetPassword, effects on providers and the action page |
| `oob-email-link` | oob | 27 | EMAIL_SIGNIN: send, signInWithEmailLink for new and existing users, action page |
| `oob-change-email` | oob | 18 | VERIFY_AND_CHANGE_EMAIL: send, consume via update and via the action page |
| `oob-recover-email` | oob | 17 | plain email updates issue RECOVER_EMAIL codes; the recoverEmail action page |
| `oob-admin-return-link` | oob | 16 | privileged sendOobCode with returnOobLink (Admin SDK generate*Link) |
| `phone-signin` | phone | 22 | sendVerificationCode and signInWithPhoneNumber for new and existing users |
| `phone-link` | phone | 19 | linking a phone number to a signed-in account, collisions and temporary proofs |
| `update-client` | update | 31 | client accounts:update: profile, email, password, token re-issue, deleteAttribute and errors |
| `update-admin` | update | 26 | privileged accounts:update: claims, phone, flags, timestamps, validSince, password and email |
| `update-admin-providers-mfa` | update | 26 | privileged accounts:update: providers, MFA enrolments, deleteAttribute and the security forms |
| `refresh-token` | token | 15 | securetoken grant: bodies, reuse, revocation and errors |
| `admin-lookup-delete` | admin | 24 | privileged lookup by every key, dedupe, not found; delete; project scoping |
| `admin-batch-create` | admin | 7 | batchCreate (importUsers): every imported field and the sign-ins it enables |
| `admin-batch-create-errors` | admin | 14 | batchCreate: per-index errors, whole-request errors, overwrite and hash options |
| `admin-batch-get-paging` | admin | 14 | batchGet (listUsers) paging by localId with maxResults and nextPageToken |
| `admin-query` | admin | 14 | accounts:query and :queryAccounts: counts, sorting and the not-implemented filters |
| `admin-batch-delete` | admin | 9 | batchDelete (deleteUsers): limits, NOT_DISABLED, force and lifecycle events |
| `admin-session-cookie` | admin | 12 | createSessionCookie validity bounds and the cookie claims |
| `admin-project-config` | config | 21 | v2 project config, the emulator config routes and getProjects |
| `tenant-lifecycle` | tenants | 28 | tenant create/get/list/patch/delete and the auto-created tenant |
| `tenant-accounts` | tenants | 30 | client sign-in flows scoped to a tenant, tenant claims and isolation from the root project |
| `tenant-admin-routes` | tenants | 23 | privileged account routes scoped to a tenant, tenant export and delete-all |
| `mfa-sms` | mfa | 14 | SMS second factor: enrolment start/finalize and its validation |
| `mfa-signin-withdraw` | mfa | 29 | SMS second factor: MFA sign-in, withdraw and ineligible first factors |
| `mfa-imported-and-email-link` | mfa | 12 | MFA users created by import, pending credentials on email link and IdP first factors |
| `passkeys` | mfa | 21 | passkey enrolment and sign-in as the emulator fakes them |
| `blocking-password` | blocking | 23 | beforeCreate and beforeSignIn on password sign-up and sign-in: JWT payload, updates, errors |
| `blocking-other-methods` | blocking | 6 | blocking functions on IdP sign-ins with inbound credential forwarding |
| `blocking-email-link-phone` | blocking | 9 | blocking functions on email-link and phone sign-ins |
| `blocking-mfa-tenant` | blocking | 9 | blocking functions on MFA finalize and under a tenant |
| `lifecycle-triggers` | triggers | 18 | trigger_multicast for every create and delete path; silent for imports and delete-all |
| `readiness-openapi-legacy` | misc | 7 | readiness, the OpenAPI document, CORS and unknown routes |
| `legacy-relyingparty` | misc | 23 | the legacy v3 relyingparty routes rewrite onto v1 operations |
| `not-implemented-operations` | misc | 9 | client operations the official emulator answers with 501 |
| `not-implemented-admin-operations` | misc | 34 | privileged operations the official emulator answers with 501 |
| `widget-pages` | misc | 9 | the popup handler page with and without accounts, the iframe page |
| `delete-all-and-codes` | misc | 13 | delete-all clears accounts but keeps issued codes; verification codes listing |
| `export-import-roundtrip` | export | 11 | the record set the CLI export writes (batchGet + config) re-imported through the CLI's import route |
| `export-import-tenants` | export | 4 | tenant accounts in the export layout |
| `token-claims` | token | 23 | id token claims per sign-in method, custom and session claims, multi-provider identities |
| `disabled-user-everywhere` | update | 32 | every operation against a disabled account |
| `deleted-user-everywhere` | update | 18 | tokens and codes of a deleted account against every operation |
| `api-key-forms` | misc | 14 | apiKey in the query, in the header, missing, and owner bearer on client routes |
| `validation-coercion` | misc | 23 | OpenAPI body validation: coercions, unknown fields, wrong types and enum handling |
| `email-canonicalization` | password | 19 | mixed-case e-mail addresses are lower-cased at every entry point |
| `provider-user-info` | idp | 22 | providerUserInfo ordering and content through links, unlinks and profile updates |

## Operation coverage

The official emulator implements 61 of the 103 operations in its OpenAPI
document (path and method pairs); the other 42 answer `501`. The corpus exercises all 61 and
all 42 (each recorded with its `501` body), plus the
readiness route, the OpenAPI document, the popup handler and iframe pages, the
`/emulator/action` landing page and the legacy `relyingparty` v3 routes.
`coverage.operations` in the fixture lists steps and programs per operation.

Status distribution: 200 × 708, 204 × 1, 303 × 4, 400 × 269, 401 × 2, 403 × 16, 404 × 4, 405 × 1, 500 × 1, 501 × 62.

## Normalization

Values that differ between two runs are replaced by templates that name the
step that produced them, so the replay can resolve them against its own live
values (`Registry` in `normalize.ts`):

| Template | Source |
| --- | --- |
| `{{localId:step}}` | `localId`, `user_id`, `uid`, `sub` first seen in `step` (`#2`, `#3` for further distinct values in the same step); program-chosen ids stay literal |
| `{{token:step}}`, `{{refresh:step}}`, `{{cookie:step}}`, `{{pending:step}}` | id tokens, refresh tokens, session cookies, MFA pending credentials — recorded structurally as `{"$jwt": {header, payload}}` or `{"$b64json": {...}}` with their claims normalized recursively |
| `{{oob:step}}`, `{{code:step}}`, `{{sessionInfo:step}}`, `{{temporaryProof:step}}`, `{{enrollmentId:step}}`, `{{sessionId:step}}`, `{{tenantId:step}}`, `{{challenge:step}}` | out-of-band codes (from the log line or the response), SMS codes (from the log line), phone sessions, temporary proofs, MFA enrolment ids, `createAuthUri` sessions, generated tenant ids, passkey challenges |
| `{{salt:account}}` | a password salt, named after the account (the step that created it, or its literal id), so listings normalize identically in any order; `passwordHash` values embed it |
| `{{time}}` | `createdAt`, `lastLoginAt`, `lastRefreshAt`, `passwordUpdatedAt`, `validSince`, `iat`, `exp`, `auth_time`, `enrolledAt`, `timestamp`, `creation_time`, `last_sign_in_time`, `creationTime`, `lastSignInTime`, `enrollment_time`; program-chosen timestamps stay literal |
| `{{eventId}}` | lifecycle and blocking event ids |
| `{{origin}}`, `{{functionsOrigin}}` | the emulator and the functions stub |
| `{"$base64": template}` | a registered value base64-encoded (passkey `user.id`) |
| `{"$html": {sha256, bytes, accounts}}`, `{"$digest": {sha256, bytes}}` | HTML pages (with the account entries the picker offers, decoded) and the OpenAPI document |

Arrays under `users`, `userInfo`, `oobCodes`, `verificationCodes` and
`tenants` are ordered by random identifiers in the emulator and are stored
and compared order-insensitively. Response headers are limited to
`content-type`, `location` and the CORS headers. A step's `sleepMs` waits
before the request: `validSince` has one-second resolution, so a token
revoked in the same second it was issued would still be valid.

The functions stub answers `{}` to every blocking call unless the step's
`functions` object configures a response (`{status, body}`); every call is
recorded with its decoded JWT.

## What the official emulator does (facts the implementation follows)

- Client routes need an API key (`?key=` or `x-goog-api-key`, any value) or
  answer `403 The request is missing a valid API key.`; `Bearer owner` and any
  `Bearer ya29.*` token are the project owner; any other bearer is `401`. The
  `securetoken` route needs a key even with owner credentials.
- Request bodies are validated against the OpenAPI document: snake_case keys
  are camel-cased, numbers coerced to strings, enum indexes to their names;
  wrong types answer `400 Invalid JSON payload received. /field must be …`;
  unknown fields are ignored; `text/plain` and form bodies are rejected
  (`Invalid content-type`), an empty JSON body is an empty object (so `signUp`
  with no body creates an anonymous user).
- `signUp`: password sign-up needs `email` + `password` (≥ 6 characters),
  rejects `localId` (`UNEXPECTED_PARAMETER : User ID`); without either it
  creates an anonymous user (`provider_id: anonymous` in the token); the owner
  may set `localId`, `displayName`, `photoUrl`, `emailVerified`,
  `phoneNumber`, `disabled`, `mfaInfo` and gets no tokens back.
- Emails are lower-cased everywhere; `EMAIL_EXISTS` is checked on the
  canonical form.
- `enableImprovedEmailPrivacy` turns `EMAIL_NOT_FOUND`/`INVALID_PASSWORD`
  into `INVALID_LOGIN_CREDENTIALS`, hides `registered`/providers from
  `createAuthUri` and makes `PASSWORD_RESET` for an unknown email succeed.
- Federated sign-in accepts any provider id; the credential must carry an
  `id_token` that is strict JSON or a JWT with a string `sub`; `access_token`
  alone is `501`. With one account per email, a verified provider email joins
  the existing account (and strips password, phone and other providers when
  that account's email was unverified); an unverified provider email answers
  `needConfirmation` with `verifiedProvider`; with duplicates allowed the new
  account gets no email. Linking (`idToken`) refuses an already-linked
  federated id and a foreign email; `returnIdpCredential` turns those errors
  into `200` bodies with `errorMessage`.
- Custom tokens: strict JSON `{uid}` or a JWT whose `aud` is the Identity
  Toolkit audience; signed JWTs are accepted with a warning; `claims` become
  session claims and are also stored as the account's `customAttributes`.
- `sendOobCode` logs the action link (`BULLET`), `sendVerificationCode` and
  MFA start log the six-digit code; `returnOobLink` needs the owner. Codes are
  single-use; `resetPassword` without `newPassword` only verifies the code;
  a reset marks the email verified and removes every other provider. A plain
  email change stores `initialEmail` and issues a `RECOVER_EMAIL` code.
- Any update that changes the password or email bumps `validSince` and
  re-issues tokens; older id tokens answer `TOKEN_EXPIRED`; refresh tokens are
  deterministic base64 JSON records and are never revoked by `validSince`.
- Blocking functions run for password, email-link, federated, phone and MFA
  sign-ins only (not anonymous, custom token, passkey or the owner's create);
  the JWT payload is recorded per method; an HTTP error from the function is a
  `400 BLOCKING_FUNCTION_ERROR_RESPONSE`, a non-JSON body a `500`; a missing
  `updateMask` is `400`; `disabled` from `beforeCreate` still creates the
  account then answers `USER_DISABLED`.
- Lifecycle multicasts (`providers/firebase.auth/eventTypes/user.create` /
  `user.delete`) are sent for every create and delete path except
  `batchCreate` and delete-all, asynchronously after the response.
- Tenants: any tenant id referenced by a path, body, id token or refresh
  token creates the tenant with the default config; tenant users are invisible
  to root lookups; `TENANT_ID_MISMATCH` when the body, token or refresh token
  disagree; phone sign-in and `getProjects` are `UNSUPPORTED_TENANT_OPERATION`
  under a tenant; tenant `disableAuth` makes every operation `PROJECT_DISABLED`.
- MFA is SMS only (`PHONE_SMS`), needs a verified email and a password,
  email-link or federated first factor; a sign-in on an enrolled account
  answers `mfaPendingCredential` + obfuscated `mfaInfo` instead of tokens; the
  finalized token carries `sign_in_second_factor` and
  `second_factor_identifier`. Passkeys are shape-only: any credential id is
  accepted and later found by id.
- `batchGet` pages by `localId` (`maxResults` capped at 1000, default 20);
  `query` sorts by `USER_ID` only and answers `501` for `expression`, `limit`,
  `offset` and other sort keys; `batchDelete` refuses enabled accounts unless
  `force`; `batchCreate` validates per index, accepts the fake hash only and
  never verifies imported password hashes of other algorithms.
- The legacy `relyingparty` v3 routes rewrite onto v1 operations
  (`downloadAccount`/`uploadAccount` need `targetProjectId`); `signOutUser` is
  `501`; `publicKeys` is `404`.

## Divergences

The fixture is the official emulator's behaviour. Replaying it against
Fireside (`npm run replay:auth -- --binary <fireside>`) compares every step's
status, recorded headers, normalized body, log lines, ordered blocking calls
and the set of lifecycle multicasts; 17,303 values are compared and every one
is parity except the four named divergences below, which the replay accepts
only at the listed paths (`DIVERGENCES` in `src/auth/replay-fireside.ts`).

| Where | Official | Fireside | Why it stays |
| --- | --- | --- | --- |
| `malformed-json` / `body-string` steps, `error.message` and `errors[0].message` | V8's `JSON.parse` wording (`Unexpected token ...`) | serde's wording | same `400`, same error shape; the parser's prose is not a contract |
| `signin-function-text`, `error.errors[0].reason` | V8's parse error for a blocking function's non-JSON body | serde's | same `500 INTERNAL`, same `BLOCKING_FUNCTION_ERROR_RESPONSE : ((Response body is not valid JSON.))` message |
| the `WARN` log line of any `500` | `InternalError: ...` followed by a Node stack trace | the same first line only | the stack is the reference implementation's source layout |
| `$html.sha256` / `$html.bytes` of `/emulator/auth/handler` | the official widget page | Fireside's own page | the accounts the page offers (`data-id-token` entries: subject, name, email, picture) are compared exactly; the SDK popup and redirect flows run against the official browser fixture in `test/auth-popup.test.mjs` |
