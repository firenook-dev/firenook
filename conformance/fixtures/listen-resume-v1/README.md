# A listener resuming with a token or read time

Independent live capture from the official Firestore emulator 1.22.0, using only
synthetic documents and local callers. The jar, Node, Java and SDK identities are
recorded in `fixture.json`. `passed` means the capture completed, not that every
request succeeded. No production project or consumer data is used.

A device keeps a resume token per query in its cache and sends it when the
listener next attaches, whichever emulator it is talking to by then. The native
SDKs keep their cache by default, and the Android SDK sends an empty token for a
new target.

Observed contracts:

- The official emulator never refuses a token. Empty, malformed, issued by another
  backend, issued by itself, or issued before it restarted: each answers `ADD`,
  `RESET`, every matching document, `CURRENT`, `NO_CHANGE`.
- A read time is treated the same way, whether it is a day old, a day ahead, has
  nanoseconds or is zero.
- After a restart the answer is the data as it is now: nothing from before.

`issuedToken` is a token the official emulator issued, so the replay can send the
native engine what a device's cache would hold after moving between emulators.

`conformance/test/listen-resume-replay.test.mjs` replays the capture and lists the
differences it accepts, each with its reason.

Re-record into a new directory with
`node conformance/src/suite/capture-listen-resume.mjs <fresh-directory>`.
