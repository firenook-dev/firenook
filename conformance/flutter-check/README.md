# FlutterFire check

The same Flutter app, using the real FlutterFire plugins, runs against Firenook
and against firebase-tools on one platform, each on a fresh backend. The check
fails on any difference. On iOS and Android these plugins are the native Firebase
SDKs, so this is the only place in the repository where those clients are run.

Results are compared within a platform only: web and iOS legitimately differ
from each other.

```
node conformance/flutter-check/check.mjs --platform web
node conformance/flutter-check/check.mjs --platform ios
node conformance/flutter-check/check.mjs --platform android --device emulator-5554
```

It needs the Flutter SDK, a built engine (`--binary`, default `target/debug/firenook`),
`npm ci --prefix conformance` for firebase-tools, Java for firebase-tools, and
the platform's tools: Chrome, Xcode with an iPhone simulator, or the Android SDK
with a running emulator. It runs by schedule and before a release in
`.github/workflows/sdk-clients.yml`, not on every pull request.

`--runs <n>` repeats each backend, `--cold-boot` restarts the simulator before each
run, and `--keep` keeps the generated project, which is otherwise deleted at the end.

## What the app needs

The generated project is not kept here. `check.mjs` runs `flutter create` in a
temporary directory, copies in `app/`, and applies what a local emulator needs:

- The iOS SDK crashes at startup unless the API key is 39 characters starting
  with `A`, so `app/lib/main.dart` uses one.
- With Swift Package Manager, `build/ios/SourcePackages` must exist before
  `flutter pub get`. CocoaPods is not needed.
- iOS needs `NSAllowsLocalNetworking` in `Info.plist`.
- Android needs `android:usesCleartextTraffic`. FlutterFire turns `127.0.0.1` into
  `10.0.2.2` on Android, the emulator's address for the host.
- Each backend runs fresh and the app is uninstalled between runs, because state
  carries over otherwise.

## A kept cache

`--keep-cache` keeps the app's cache between runs and runs firebase-tools twice,
then Firenook twice, as a device does moving to Firenook. Firenook's runs are each
compared with firebase-tools' second run, because that one also starts from a cache
another run left. `fs.kept_cache` is the check that matters there: the first run on
a fresh device passes it trivially, and a later run passes only if the emulator
answers a token it did not issue by starting the target over.

No check is exempt from failing. `fs.pending_writes` once was, and the lost write
behind it is fixed. It writes a new document on every run, so a kept cache cannot
already hold it.
