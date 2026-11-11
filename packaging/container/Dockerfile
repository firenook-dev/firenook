# Firenook in a container: Node 24 and the firenook npm package, nothing else.
#
# .github/workflows/container.yml builds it from a version already on npm,
# for linux/amd64 and linux/arm64, and publishes it as
# ghcr.io/firenook-dev/firenook:<version>. Mount the project (firebase.json,
# rules, functions) at /project and start the emulators on every address:
#
#   docker run --rm -v "$PWD:/project" -p 8080:8080 -p 4000:4000 \
#     ghcr.io/firenook-dev/firenook:<version> \
#     emulators:start --project demo-my-app --host 0.0.0.0
#
# docs/container.md has the rest: ports, keeping data, functions' modules.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG FIRENOOK_VERSION
RUN test -n "$FIRENOOK_VERSION" \
    && npm install --global --no-audit --no-fund "firenook@${FIRENOOK_VERSION}" \
    && npm cache clean --force \
    && firenook --version

LABEL org.opencontainers.image.title="Firenook" \
      org.opencontainers.image.description="Firebase emulators: Firestore, Auth, Storage, Functions, Pub/Sub, Cloud Tasks and Eventarc" \
      org.opencontainers.image.source="https://github.com/firenook-dev/firenook" \
      org.opencontainers.image.licenses="Apache-2.0"

# Not root: the image's node user (uid 1000) runs the emulators.
USER node
WORKDIR /project
# The official suite's ports: UI and console, hub, logging, Functions,
# Firestore, Pub/Sub, Auth, Firestore's WebSocket, Storage, Eventarc, Tasks.
EXPOSE 4000 4400 4500 5001 8080 8085 9099 9150 9199 9299 9499
ENTRYPOINT ["firenook"]
CMD ["emulators:start", "--host", "0.0.0.0"]
