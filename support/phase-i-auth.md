# Phase I — Complete Authentication (`0.1.0-next.8`, together with Phase J)

Written 2026-09-18 against `main` 10f3087 (published engine 0720434,
`firenook@0.1.0-next.8` not yet cut). It follows
[Phase H](phase-h-functions-runtime.md) and ships with
[Phase J](phase-j-pubsub.md) (Pub/Sub emulator) as `0.1.0-next.8`.

## Status (2026-09-19)

I0–I4 are done. Gate `benchmarks/phase-i-auth.json` (frozen); corpus
`conformance/fixtures/auth-v1` — 61 programs / 1068 steps against
firebase-tools 15.22.0 covering all 61 implemented and all 42 unimplemented
official routes plus the pages and legacy routes, consecutive recordings
identical after normalization (`receipts.i1`). `crates/auth-front` is
rewritten around the official `OpenAPI` document (routing, security,
validation, coercions) with every operation ported one to one, blocking
functions on every blocked method and multicasts on every lifecycle path;
`firenook auth` runs it standalone for the replay. The replay
(`npm run replay:auth`) compares 17,303 values with 0 mismatches and four
named divergences (`receipts.i4`), three runs identical; the real-SDK
popup/redirect browser gate and the five earlier `firebase-suite-v1` Auth
fixtures stay green as crate tests; the Emulator UI Auth-tab check is
recorded with the candidate. I5 qualification is recorded in `receipts.i5`
(2026-09-19): CI green on the exact head, the consumer extensions,
integration and installed-launcher gates and the nine browser journeys
(including the one-time-code login and sign-out/sign-in) pass on the
candidate; the paired 2 h soak was waived by the owner for this release
because the change set is confined to Auth and Pub/Sub and both are proven
by oracle replay. Published as `0.1.0-next.8` on 2026-09-19 (release run 35372788758,
`next` → next.8, `latest` untouched).

Implementation note: I2 as delivered keeps the account as a JSON record with
rebuilt indexes rather than the typed `Account` struct sketched below — the
official emulator's own model is untyped `UserInfo` JSON and the corpus
compares serialized records, so the JSON model is the faithful one; the
indexes, scopes, tenants and codes are as listed.

## Goal

Make the Auth port a drop-in for the official Auth emulator: every operation
the official emulator implements answers with the recorded contract, for every
sign-in method, every account operation the client and Admin SDKs use, tenants,
multi-factor (SMS) and passkey flows, out-of-band (email) and phone
verification codes, session cookies, the emulator-only inspection routes, the
legacy `relyingparty` v3 routes and the browser helper pages. Blocking
functions run on every sign-in path, not only the password one. Export/import stays byte-compatible with the official
`auth_export/` layout including the fields this phase adds.

Same discipline as Phases G and H: the official emulator is recorded first, the
corpus is frozen, the implementation replays it, and every difference is either
fixed or named.

Out of scope: production-only behaviour the official emulator does not
implement either (SAML/OIDC provider configuration, `initializeAuth`, Game
Center, `verifyIosClient`, IAM on tenants, reCAPTCHA enforcement, TOTP MFA,
`beforeSendEmail`/`beforeSendSms`, real email or SMS delivery). Those keep
answering as the official emulator answers them (recorded in I1), and the
Emulator UI is unchanged.

## State before the phase (verified 2026-09-18)

`crates/auth-front` (2,390 lines) implements 24 routes. Measured against
firebase-tools 15.22.0 (`lib/emulator/auth/apiSpec.js` + `operations.js`),
the official emulator implements 61 of the 103 operations in its OpenAPI
document (the other 42 answer `501`); Firenook implements 23 of those 61 plus
the popup handler and iframe pages.

| Area | Firenook today | Official emulator | Gap |
| --- | --- | --- | --- |
| Password | `signUp` (email+password only), `signInWithPassword`, `createAuthUri` (password only) | also anonymous `signUp`, owner-privileged `signUp` fields, `createAuthUri` listing every provider, `resetPassword` | anonymous sign-in answers `400 MISSING_EMAIL` |
| Federated | `signInWithIdp` for a fake profile, Google-shaped `federatedId` | any provider id, `idToken` linking, `needConfirmation` on email collision, `returnIdpCredential`, `pendingToken`, Apple/Twitter/GitHub/Microsoft/Facebook fields, OIDC/SAML pass-through | no linking, no collision handling, one provider verified |
| Custom token | `signInWithCustomToken` (no claim validation) | validates `aud`/`iss`/`exp`/`tenant_id`, applies `claims` | validation and tenant claim |
| Email OOB | none | `sendOobCode` (VERIFY_EMAIL, PASSWORD_RESET, EMAIL_SIGNIN, VERIFY_AND_CHANGE_EMAIL; RECOVER_EMAIL issued on email change), `resetPassword`, `signInWithEmailLink`, `update` with `oobCode`, admin `accounts:sendOobCode` with `returnOobLink`, `GET /emulator/v1/projects/{p}/oobCodes`, `/emulator/action` landing page per mode, link in the log | whole feature |
| Phone | none | `sendVerificationCode`, `signInWithPhoneNumber` (sign-in, link, `temporaryProof`), `GET …/verificationCodes`, code in the log | whole feature |
| `accounts:update` (client and admin) | `displayName`, `photoUrl`, `email`, `emailVerified`, `disabled`/`disableUser`, `phoneNumber`, `customAttributes` | also `password`, `deleteProvider`, `deleteAttribute`, `linkProviderUserInfo`, `validSince`, `mfa`, `oobCode`, `returnSecureToken` re-issue, `lastLoginAt`, `createdAt`, tenant scoping | token re-issue, unlink, revoke, MFA |
| Admin | create, update, lookup, query, delete, batchCreate, batchGet | also `batchDelete`, `:createSessionCookie`, `:queryAccounts`, `batchGet` paging, `query` with `returnUserInfo`/`sortBy: USER_ID`/`order`/`tenantId` (`expression`, `limit`, `offset` and other sort keys answer `501` there too), `batchCreate` hash options and `sanityCheck`, v2 project config GET/PATCH, `GET /v1/projects` | six operations and paging |
| Tenants | `GET /v2/projects/{p}/tenants` → `[]` | create/get/patch/delete, every account route under `/tenants/{t}/…`, tenant-scoped emulator routes, `tenant` claim in tokens, tenant `usageMode`/`allowPasswordSignup` | whole feature |
| MFA / passkeys | none | `mfaEnrollment:start/finalize/withdraw`, `mfaSignIn:start/finalize` (SMS only in 15.22.0), `passkeyEnrollment:start/finalize`, `passkeySignIn:start/finalize` (shape-only), `mfaInfo`/`mfaPendingCredential`, obfuscated `phoneInfo` | whole feature |
| Blocking functions | `beforeCreate`/`beforeSignIn` for password `signUp`/`signInWithPassword` (`lib.rs:579,602,726`) | every sign-in method incl. IdP, email link, phone and MFA finalize (custom token and anonymous are not blocked officially either); `forwardInboundCredentials`; the recorded JWT payload | coverage |
| Config | emulator config GET/PATCH stored as JSON; `allowDuplicateEmails` and `emailPrivacyConfig` not enforced | `signIn.allowDuplicateEmails` (duplicate-email semantics in every path), `emailPrivacyConfig.enableImprovedEmailPrivacy` (`INVALID_LOGIN_CREDENTIALS` masking, `createAuthUri` redaction), `blockingFunctions` with `forwardInboundCredentials`, v2 config GET/PATCH with `updateMask` | enforcement |
| Misc | readiness advertises `/emulator/openapi.json` (route absent) | serves the spec; OpenAPI request validation (`Invalid JSON payload received…`), `apiKey` required on client routes (`403 The request is missing a valid API key.`), snake_case body keys and numeric/enum coercion, legacy `/www.googleapis.com/identitytoolkit/v3/relyingparty/*` routes, `Bearer ya29.*` accepted as owner, widget page with account picker, "add new account", tenant awareness | small |

The consumer exercises password, Google popup, custom token, the Admin SDK
and the two blocking functions. None of the gaps blocks it; all of them block
a drop-in for other applications.

## Oracles and precedence (freeze before implementation)

Record in `benchmarks/phase-i-auth.json`, `frozen: true`, before any product
change, mirroring `phase-g-storage-rules.json`:

1. **Official Auth emulator**, firebase-tools 15.22.0 `AuthEmulator` in
   process (pure Node; the same bootstrap as `conformance/src/suite/capture-auth.ts`),
   with a recording HTTP server registered as the Functions emulator so that
   `trigger_multicast` and blocking-function calls are observed. This oracle
   owns everything: request validation, error codes and messages, response
   shapes, token claims, log lines (the emulator prints OOB links and SMS
   codes to its log), export layout.
2. **Firebase JS SDK 12.18.0 and firebase-admin** as the callers whose wire
   shapes the programs reproduce — the programs are raw HTTP, but a browser
   profile of the corpus drives the SDK against the official emulator so
   the request shapes are the SDK's, not guessed.
3. Identity Toolkit reference docs, for naming only.

Classification rule: the official emulator wins on everything it implements;
a divergence is allowed only where the emulator's behaviour is a defect the
official issue tracker acknowledges, and then it is named in the fixture
README and asserted in the replay.

## Work packages

### I0 — Freeze the gate (½ day)

- `benchmarks/phase-i-auth.json`: toolchain pins (Rust, Node 24, firebase-tools
  15.22.0 with the `lib/emulator/auth/*` source hashes, firebase 12.18.0),
  the operation inventory above (61 official operations, the 23 Firenook has,
  the 38 to add, the 42 that stay `501`), the named checks below with pass
  criteria, and the acceptance identities I5 fills in.

### I1 — Oracle corpus (4–5 days)

New fixture set `conformance/fixtures/auth-v1/` (`emulator-programs.json`,
`README.md`, `SHA256SUMS`, CI integrity check in `public-contracts`).
Tooling `conformance/src/auth/{emulator-plan.ts,capture-emulator.ts}` built
from the Storage rules capture: raw HTTP programs, every step recorded as
`{id, method, path, headers, body, status, response headers, response body,
logs, functions calls}`, secrets and time normalized (`{{token:step}}`,
`{{oob:step}}`, `{{code:step}}`, `{{localId:step}}`, timestamps). Target ≥60
programs / ≥500 steps, each program with a fresh emulator state (`DELETE
/emulator/v1/projects/{p}/accounts`) so a failure localizes:

- Password: sign-up validation (missing/invalid email, weak password, duplicate
  email with and without `allowDuplicateEmails`), sign-in errors, improved
  email privacy masking, owner-privileged `signUp` with `localId`/claims/
  `mfaInfo`, anonymous sign-up and upgrade by linking email+password.
- Federated: every provider id the widget offers, profile → record mapping,
  `federatedId`/`rawUserInfo`/`oauth*` fields, sign-in vs link (`idToken`),
  `needConfirmation`, `returnIdpCredential`, `pendingToken`, email collision
  with and without duplicates allowed, unverified email from a provider,
  `createAuthUri` with `continueUri`/`providerId`, popup handler and iframe
  pages with and without accounts, tenant-labelled picker.
- Custom token: valid, expired, wrong audience, `tenant_id`, `claims`
  merging and reserved claim rejection.
- Email OOB: each request type end to end (send → code listed → consume),
  `continueUrl`/`canHandleCodeInApp`, invalid/expired/reused codes, the
  `/emulator/action` page for each mode, `returnOobLink` for the Admin SDK.
- Phone: send, sign-in creates a user, link to an existing user, wrong code,
  `temporaryProof`, `sessionInfo` reuse, phone collision, codes listed.
- Update: every field, password change with token re-issue, `deleteProvider`,
  `deleteAttribute`, `linkProviderUserInfo`, `validSince` and refresh
  rejection, `disableUser`, `mfa`, tenant-scoped update.
- Refresh: reuse, revoked (`validSince`), disabled user, wrong grant type.
- Admin: create with every field, batchCreate with hash options and errors per
  index, batchGet paging (`maxResults`, `nextPageToken`), query with
  `sortBy`/`order`/`returnUserInfo` and the `501` answers for `expression`,
  `limit`, `offset` and other sort keys, batchDelete (`force`),
  createSessionCookie (validity bounds), `GET /v1/projects`, v2 config.
- Tenants: lifecycle, every account operation under a tenant, `tenant` claim,
  cross-tenant lookup isolation, tenant-scoped emulator routes and widget.
- MFA: SMS enrolment/sign-in, withdraw, `mfaInfo` on records and in
  `batchCreate`, `mfaPendingCredential`, sign-in with MFA required on each
  first factor, ineligible first factors; passkeys start/finalize both flows
  (the emulator accepts any well-formed attestation), `deletePasskey`.
- Blocking functions: `beforeCreate`/`beforeSignIn` on each sign-in method
  (password, email link, IdP, phone, MFA finalize; not custom token or
  anonymous), response updates (`displayName`, `photoUrl`, `emailVerified`,
  `disabled`, `customClaims`, `sessionClaims`), function errors, timeouts and
  non-JSON bodies, the JWT sent to the function, `forwardInboundCredentials`.
- Triggers: `trigger_multicast` for create (each method) and delete, batch
  import silent, delete-all silent.
- Export/import: the whole record set through `accounts:batchGet` / `batchCreate`
  and the `auth_export/` layout with tenants, MFA, phone, `passwordHash`.
- Errors: the 42 unimplemented operations (`501` shape), unknown routes, bad
  JSON and schema-invalid bodies, missing `apiKey`, missing or invalid
  `Authorization` on admin routes, `targetProjectId` without owner, wrong
  project id, tenant id mismatches; the legacy `relyingparty` route rewrites.

Exit: fixtures committed with checksums and README (operation coverage table,
divergences empty or justified); CI integrity green.

### I2 — Engine: account model and every operation (8–10 days)

Rewrite `crates/auth-front` around a typed store instead of the JSON-blob
users:

- `model.rs`: `Account` (every field the official `UserInfo` carries:
  identity, `providerUserInfo`, password hash/salt/`passwordUpdatedAt`,
  `validSince`, `lastLoginAt`/`lastRefreshAt`/`createdAt`, `emailVerified`,
  `initialEmail`, `emailLinkSignin`, `phoneNumber`, `customAttributes`,
  `disabled`, `tenantId`, `mfaInfo` (SMS enrolments with obfuscation),
  `passkeyInfo`, `dateOfBirth`/`language`/`screenName` from providers),
  `ProjectState` with the official indexes (email, initial email, phone,
  provider email, provider raw id, passkey credential id), OOB codes,
  verification codes, temporary proofs, self-describing refresh tokens
  (base64 JSON as the official emulator issues them), session cookies,
  tenants (each a `ProjectState` with tenant config, created on first
  reference like the official emulator), project config (v2 shape with
  `updateMask`).
- `handlers/*.rs` per operation group (password, idp, custom, oob, phone,
  update, admin, tenants, mfa, passkeys, config, emulator, legacy), each
  mapping the recorded validation order and error strings; a request layer
  that reproduces the OpenAPI validation errors, `apiKey`/owner security,
  snake_case conversion and coercions the official server applies.
- Tokens: id token claims per method (`firebase.identities`,
  `sign_in_provider`, `sign_in_second_factor`, `second_factor_identifier`,
  `tenant`), refresh grants bound to `validSince`, session cookies.
- Widget: account picker per provider, "add new account", tenant label,
  `/emulator/action` page, `/emulator/openapi.json`.
- Logs: OOB links and phone codes printed like the official emulator, on the
  suite log channel.
- Export/import: `accounts.json` and `config.json` round trip every new field;
  a next.7 export imports unchanged.

### I3 — Blocking functions and triggers on every path (2 days)

- One `run_blocking(event, method, account, oauth_tokens)` used by every
  sign-in path the official emulator blocks; the JWT payload as recorded;
  `forwardInboundCredentials` honoured; the recorded error mapping for
  function failures.
- `trigger_multicast` for every create/delete path, silent for imports and
  delete-all.

### I4 — Replay (2–3 days)

- `conformance/src/auth/replay-firenook.ts` replays every I1 program against
  the binary's standalone `firenook auth` service (one fresh process per
  program, the same functions stub) using the capture's own `normalize.ts`,
  so both sides normalize identically; parity on status, headers, normalized
  body, log lines and functions calls, or a named divergence — an empty
  divergence list is the target. Rust unit tests keep the crate-level checks.
- The SDK browser profile of I1 runs against Firenook in the existing browser
  integration job (four cells) for the flows the JS SDK drives.
- The Emulator UI Auth tab against Firenook: list/edit/add/delete users,
  MFA rows, tenants, duplicate-emails toggle (manual check recorded).

### I5 — Qualification and release (shared with J5)

Exact-candidate CI, consumer gates (integration, extensions, browser
journeys), private paired acceptance with the Auth lane extended by the new
flows, release `0.1.0-next.8`, docs (README, CLI guide, COMPATIBILITY,
ROADMAP, tracker).

## Sequencing and size

I0 → I1 → I2 → I3 → I4 → I5; J runs on the same branch after I1 so the two
corpora freeze early. Size 17–22 working days for I; the official emulator's
Auth source is 5,000 lines of TypeScript and the corpus, not the port, is the
long pole.

## Risks

- Undocumented emulator behaviour discovered late: mitigated by recording the
  corpus before the port and treating each recorded step as the spec.
- Passkey/WebAuthn: the official emulator validates only shape; the corpus
  captures exactly what it accepts.
- Existing consumers' persisted `auth_export` files: I2 imports the next.7
  layout unchanged and adds fields only on write.
