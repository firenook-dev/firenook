# What native SDKs and browsers send to Storage

Independent live capture from the official Storage emulator in firebase-tools
15.34.0, using only synthetic objects and local callers. Tool identities are in
`fixture.json`. `passed` means the capture completed, not that every request
succeeded. No production project or consumer data is used.

The request shapes come from the real clients:

- **iOS SDK** (`ios/13.1.1`, captured through a proxy from an iPhone simulator)
  starts an upload with `POST /v0/b/{bucket}/o/{encoded name}?uploadType=resumable&name=...`,
  `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`,
  `X-Goog-Upload-Content-Length` and `X-Goog-Upload-Content-Type`, with a JSON body
  whose `bucket` is empty.
- **Android SDK** (read from `firebase-android-sdk`, `ResumableUploadStartRequest`
  and `ResumableUploadByteRequest`) starts with `POST /v0/b/{bucket}/o?name=...&uploadType=resumable`
  and `X-Goog-Upload-Header-Content-Type`, with no body when no metadata was set,
  then sends chunks by POST with the form content type its HTTP client adds, and
  may finish with an empty `finalize`.
- **Web SDK** starts on the bucket path with `X-Goog-Upload-Header-Content-*`.

Observed contracts:

- A POST or PUT on an object path is an upload, unless it carries `create_token`
  or `delete_token`, which stay admin-only. The path names the object, whatever
  the query or the body says.
- A start checks no rules: a denied name fails on finalize, 403 with
  `x-goog-upload-status: final`, and a second finalize answers 403 again.
- A resumable start reads the object's type from its JSON body alone and defaults
  to `application/octet-stream`. No header sets it.
- A preflight is answered with the headers it asks for, whatever they are, and
  every response exposes the upload headers, so a browser can read the upload URL.
- **A list is matched as the folder's path and one more segment.**
  `match /open/{name}` proves a list of `open/`; `match /open` does not;
  `match /{name}` proves the root. The single wildcard's value is unusable: `name
  is string`, `name != 'x'` and `!(name == 'x')` all deny, while `name == 'x' ||
  true` allows. A recursive wildcard is a path that equals nothing a rule can
  write.

## Replay and differences

`conformance/test/storage-native-clients-replay.test.mjs` runs the same requests
against the native engine and lists each accepted difference with its reason:

- A one-shot v0 upload stores `application/octet-stream` natively. firebase-tools
  15.34.0 reads the request's `Content-Type`; 15.22.0, which
  `storage-rules-v1` pins (`content-type-header-ignored`), ignored it. No SDK
  sends this shape: they use multipart or resumable.
- A few refusals carry a JSON error natively and an empty body officially, with
  the same status.
- The rules `path()` function is not implemented natively, so a condition using
  it denies.
- The native preflight allows every origin; the official one repeats the origin
  it was given.

The real clients themselves are not part of this replay. They need a simulator
or an emulator, so they are checked by hand for a release.

Reproduce with Node 24.20.0 and
`node conformance/src/suite/capture-storage-native-clients.mjs <fresh-output-directory>`.
The driver starts and stops only its own official emulator.
