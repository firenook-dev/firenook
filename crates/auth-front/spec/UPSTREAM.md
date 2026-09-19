# Identity Toolkit OpenAPI document provenance

`openapi.json` is the OpenAPI 3.0 description of the Identity Toolkit API that
the official Firebase Auth emulator routes and validates requests with,
including its emulator-only paths (`/emulator/v1/...`). It is the JSON
serialization of the object exported by `lib/emulator/auth/apiSpec.js`,
copied without modification from:

- package: `firebase-tools` on npm
- version: `15.22.0`
- retrieved: 2026-09-18
- license: MIT; see `LICENSE` in this directory

The document is an interface description (paths, parameters, schemas and
security schemes), not implementation code. Firenook embeds it verbatim so
that routing, credential checks, request validation and the served
`/emulator/openapi.json` follow the same contract as the official emulator.
The emulator behaviour itself is implemented independently in `src/`.
