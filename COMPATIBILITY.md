# Preview compatibility

Fireside is not yet a universal Firebase Emulator Suite replacement.

| Surface | Current preview | Not claimed |
| --- | --- | --- |
| Firestore | Native/Admin and browser SDK paths, rules, realtime targets, disk/WAL, official-format import/export | Every production feature, edition or arbitrary client version |
| Auth | Every operation the official Auth emulator implements (61), replayed from a 1068-step oracle corpus with parity: password, anonymous, custom token, email link, phone, fake IdP (Google/Apple/SAML/OIDC-shaped credentials), account update/delete, OOB and phone codes, session cookies, tenants, SMS MFA, passkeys, Admin batch create/get/delete/query, project and tenant configuration, emulator inspection routes, legacy `relyingparty` routes, blocking functions and lifecycle triggers, official-format export/import, the local popup/redirect helper pages | Anything the official emulator itself answers with 501 (IdP/SAML/OIDC provider configuration, `initializeAuth`, IAM on tenants, Game Center, reCAPTCHA enforcement, TOTP MFA); real email/SMS delivery; production token verification |
| Storage | Captured Firebase/GCS paths, metadata, gzip, pagination, single-file and multi-bucket rules, export/import; Security Rules evaluated natively (no Java) with the recorded official request model and production expression semantics, including `firestore.get`/`exists` and `/internal/setRules` | All GCS features; the official emulator's prefix-template `list` matching and missing `request.method` (production semantics are followed and recorded as divergences) |
| Functions | Fireside runtime with one Node worker per codebase: discovery through the pinned SDK control API or `functions.yaml`, HTTP/callable/streaming, Firestore/Storage/Auth/Pub/Sub/Eventarc/schedule triggers, blocking Auth functions, dotenv/secret files, reload, background controls, `--inspect-functions`; Extensions resolved and run by Fireside with the recorded parameter, spec and trigger semantics from local, vendored, cached or registry sources | Pure Rust JavaScript execution, a network sandbox, Python/Dart runtimes, dynamic (in-code) extensions, Secret Manager access |
| Pub/Sub | Limited function-oriented publication/dispatch adapter | General subscriber, push/pull and ordering parity |
| Hub/UI | Captured discovery/control/static/logging paths | Complete Emulator UI parity |
| Other services | None claimed | Realtime Database, Hosting, App Hosting, Data Connect and universal extensions |
| CLI | Complete local suite, explicit setup, doctor, start/exec, state/resume | Arbitrary service subsets, cloud deploy or real-project configuration |

Since `0.1.0-next.4` the published engine includes the Firestore
Requests/rule-evaluation tracing and rules-coverage tooling whose
[scoped source qualification](support/phase-bcd-qualification.md) preceded it;
`fireside emulators:start` records bounded diagnostics by default and
`--no-diagnostics` disables them. Since `0.1.0-next.7` the Eventarc port
serves trigger registration, `getTriggers` and `publishEvents` on the `google`
and named channels and delivers to `onCustomEventPublished` handlers. The
auxiliary Cloud Tasks port supports host startup registration only: dispatch
routes return HTTP 501 `UNIMPLEMENTED`, and registration is not a promise of
delivery.

The package supports only its enumerated native targets after their exact
candidate checks pass. Linux musl, Windows ARM64/32-bit, network-filesystem
durability and Windows power-loss recovery are not qualified.

Use synthetic demo data, loopback interfaces and a representative private
consumer test before adoption. Consult the CLI guide for stricter configuration
limitations. Performance depends on workload and hardware; source separation
is not evidence of faster execution or lower memory.
