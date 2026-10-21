# Storage targets without buckets

A synthetic capture of the official CLI (firebase-tools and Node versions in
`fixture.json`, Storage rules runtime 1.1.3) starting Storage for
`firebase.json` Storage targets that `.firebaserc` maps to no bucket. Every
target's rules deny everything; the project ids are `demo-media` and a
made-up `real-media-project`; no cloud is involved. Reproduce with Node
24.20.0 and Java on the path:

```
npm run capture:storage:demo-targets --prefix conformance -- --output /tmp/fresh-storage-demo-targets
```

For each case the capture records whether the emulator started and its exit
code, the `storage` lines that mention the demo project, the error a failed
start prints, and the status of an unauthenticated upload to three buckets
(`demo-media-images`, which `.firebaserc` maps to the target `media` when it
maps anything, `demo-media.appspot.com` and `anything-else`).

What it shows (`getStorageRulesConfig`):

- A demo project with a target that maps to no bucket starts. At the first
  such target, in `firebase.json` order, every target is ignored, mapped ones
  included, and the default open rules
  (`templates/emulators/default_storage.rules`) govern every bucket, so each
  upload is 200. It prints, as a `storage` information line:
  `Detected demo project ID "demo-media", using a default (open) rules
  configuration. Storage targets in firebase.json will be ignored.`
- When every target maps to a bucket, its rules govern that bucket (403 here)
  and a bucket no target names refuses everything (403).
- A real project with an unmapped target does not start: `Error: Deploy
  target media not configured for project real-media-project. Configure
  with: firebase target:apply storage media <resources...>`, exit code 1.

`test/storage-demo-targets-replay.test.ts` replays the cases against the
Firenook suite. Its one difference is the real project's error, which names
`firenook target:apply` and adds `or pass --storage-bucket media=<bucket>.`
for the flag only this CLI has.
