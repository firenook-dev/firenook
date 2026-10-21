# Rules unit testing: `@firebase/rules-unit-testing` against the emulators

Synthetic rules (`firestore.rules`, `storage.rules`) and two test files the
console exports from saved rules tests (`console-firestore.test.ts`,
`console-storage.test.ts`; `console/src/firestore/rules-page/tests-export.test.ts`
and `console/src/storage/rules-page/tests-export.test.ts` keep them equal to
what the console writes, `UPDATE_CONFORMANCE_EXPORTS=1` rewrites them). No
cloud project or user data is involved.

```
npm run test:rules:unit-testing --prefix conformance -- --target firenook
npm run test:rules:unit-testing --prefix conformance -- --target java
```

`src/rules/run-rules-unit-testing.ts` starts Firestore and Storage with these
rules (the Firenook suite, or the official CLI's `emulators:exec`) and runs,
under `node --test`, `test/rules-unit-testing.test.ts` and the two exported
files (their `vitest` imports resolve to `node:test` through
`src/rules/vitest-as-node-test.mjs`). The library (`5.0.2`, with
`firebase@12.18.0`) loads the rules through the reload routes,
`initializeTestEnvironment({ firestore: { rules }, storage: { rules } })`,
then asserts verdicts as `authenticatedContext()` (an unsigned token issued at
time 0), `unauthenticatedContext()` (no Authorization header over gRPC) and
`withSecurityRulesDisabled()` (`Bearer owner`, `Firebase owner`), and empties
the emulators with `clearFirestore()` and `clearStorage()`.

All 24 tests pass against the official emulator (Firestore 1.22.0, Storage
rules runtime 1.1.3, firebase-tools 15.34.0) and against Firenook. Firenook
`0.2.0-next.8` failed 18 of them: its reload route answered 415 to the
library's `text/plain` body, so every Firestore environment failed to start.
