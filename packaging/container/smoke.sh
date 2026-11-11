#!/usr/bin/env bash
# Starts a built image the way a test suite would and checks it answers
# through mapped ports: Firestore writes and reads a document, Auth signs a
# user up, the console's page loads, and a stop is clean.
#
#   packaging/container/smoke.sh <image>
set -euo pipefail

image=${1:?usage: smoke.sh <image>}
project=demo-container-smoke
work=$(mktemp -d)
cat >"$work/firebase.json" <<'JSON'
{
  "emulators": {
    "firestore": { "port": 8080 },
    "auth": { "port": 9099 },
    "ui": { "enabled": true, "port": 4000 }
  }
}
JSON
# The image runs as its node user; the project it is given must be its to write.
chmod -R a+rwX "$work"

container=$(docker run --detach \
  --publish 127.0.0.1:8080:8080 --publish 127.0.0.1:9099:9099 --publish 127.0.0.1:4000:4000 \
  --volume "$work:/project" "$image" \
  emulators:start --only firestore,auth --project "$project" --host 0.0.0.0)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$container" 2>&1 | tail -60; fi
  docker rm --force "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

document="http://127.0.0.1:8080/v1/projects/$project/databases/(default)/documents/smoke/one"
# Any answer means Firestore is listening (the document is not there yet).
ready=false
for _ in $(seq 1 90); do
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Authorization: Bearer owner' "$document" || true)
  if [ "$code" != 000 ]; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || { echo "Firestore did not answer within 90 s"; exit 1; }

curl --silent --fail -X PATCH -H 'Authorization: Bearer owner' -H 'content-type: application/json' \
  "$document" -d '{"fields":{"ok":{"booleanValue":true}}}' >/dev/null
curl --silent --fail -H 'Authorization: Bearer owner' "$document" | grep -q '"booleanValue": *true'
echo "Firestore: a document written and read through the mapped port"

curl --silent --fail -X POST -H 'content-type: application/json' \
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake' \
  -d '{"email":"smoke@example.com","password":"secret123","returnSecureToken":true}' | grep -q '"localId"'
echo "Auth: a user signed up through the mapped port"

curl --silent --fail --output /dev/null http://127.0.0.1:4000/console
echo "The console answers through the mapped port"

docker stop --time 20 "$container" >/dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
[ "$code" -eq 0 ] || { echo "the stop exited $code"; exit 1; }
echo "A stop exits cleanly"
