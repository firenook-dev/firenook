# Extensions registry version records

The Extensions registry's records for the two public registry Extensions of
the `functions-runtime-v1` `consumer-refs` profile, as Firenook's registry
resolution saved them next to their cached sources (`firenook-registry.json`,
`{extension, extensionVersion}`), on 2026-09-19:

| File | Extension | Source archive SHA-256 |
| --- | --- | --- |
| `invertase-firestore-stripe-payments@0.3.12.json` | `invertase/firestore-stripe-payments@0.3.12` | `33b43e09…` |
| `algolia-firestore-algolia-search@1.2.10.json` | `algolia/firestore-algolia-search@1.2.10` | `bf3bebef…` |

Reading them from the registry needs a Firebase CLI login, which CI does not
have. `src/functions-runtime/fetch-registry-sources.mjs` fetches each
version's published source archive (public, named by the SHA-256 these
records give as `extensionVersion.hash`) and lays these records next to it,
so the profile replays offline against the registry's own, unsubstituted
spec. They are inputs, not recorded answers: `src/report/cases.mjs` counts
nothing here. A published version's spec and source do not change; the
listing's install counts and times are those of the day they were saved,
not of the recording.
