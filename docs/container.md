# Run Firenook in a container

Each release is also an image, `ghcr.io/firenook-dev/firenook:<version>`, for
linux/amd64 and linux/arm64: Node 24 and the `firenook` npm package of that
version, nothing else. It needs Docker (or any OCI runtime) and no Node on the
machine. `latest` is the newest release published as latest, `next` the
newest published as next.

## Start it

Mount the project (its `firebase.json`, rules, indexes and functions) at
`/project`, publish the ports you use, and start the emulators on every
address in the container:

```sh
docker run --rm -v "$PWD:/project" \
  -p 8080:8080 -p 9099:9099 -p 9199:9199 -p 4000:4000 \
  ghcr.io/firenook-dev/firenook:0.2.3 \
  emulators:start --project demo-my-app --host 0.0.0.0
```

The arguments after the image are Firenook's: `emulators:exec`, `--only`,
`--import` and every other command and flag work as with `npx firenook`. The
image runs as its `node` user (uid 1000), so on Linux give it a project it can
write, or run it as yourself with `--user "$(id -u):$(id -g)"`.

Started with `--host 0.0.0.0`, the console answers whatever name it is reached
by, so `http://localhost:4000/console` works through the published port and
`http://firebase:4000/console` works from another container. Clients connect
to the published ports as they would to a local suite.

## With Compose

```yaml
services:
  firebase:
    image: ghcr.io/firenook-dev/firenook:0.2.3
    command: emulators:start --project demo-my-app --host 0.0.0.0
    volumes: ['./firebase:/project']
    ports: ['8080:8080', '9099:9099', '9199:9199', '4000:4000']
  app:
    build: .
    environment:
      FIRESTORE_EMULATOR_HOST: firebase:8080
      FIREBASE_AUTH_EMULATOR_HOST: firebase:9099
      FIREBASE_STORAGE_EMULATOR_HOST: firebase:9199
```

In CI, the same image is a service container: GitHub Actions' `services:`,
GitLab CI's `services:` or a pod beside the tests.

## Keeping data

Data lives where it does outside a container, so it outlives the container
when that place is under the mounted `/project`: `--keep-data` keeps it in
`/project/.firenook/state`, and `--import` and `--export-on-exit` take paths
under `/project`.

## Functions

Your functions run on the image's Node, from the mounted source. Their
`node_modules` must be installed for Linux: a module with native code
installed on macOS or Windows does not load in the container. Install them in
the container, or in a Linux CI job, before starting the emulators.

## How the image is made

`.github/workflows/container.yml` builds it from the version just published to
npm, starts it as a test suite would (`packaging/container/smoke.sh`: a
Firestore write and read, an Auth sign-up and the console through published
ports, then a clean stop), and only then publishes both platforms, with
provenance and an SBOM. The reviewed npm release runs it after its publish.
