#!/usr/bin/env bash
# Start a throwaway Metabase OSS v0.63.18.2 on http://localhost:3001 (no volume: state resets),
# run first-time setup (admin + Sample Database) and seed the DocDemo content (seed.mjs).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3001}"
IMAGE="metabase/metabase:v0.63.18.2"
URL="http://localhost:$PORT"
docker rm -f docdemo-metabase >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect docdemo-metabase >/dev/null 2>&1 || break; sleep 1; done
docker run -d --rm --name docdemo-metabase -p "127.0.0.1:$PORT:3000" \
  -e JAVA_OPTS="-Xmx1g" \
  -e MB_ANON_TRACKING_ENABLED=false \
  -e MB_CHECK_FOR_UPDATES=false \
  "$IMAGE" >/dev/null
for i in $(seq 1 180); do
  if curl -sf "$URL/api/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 180 ]; then echo "Metabase did not start; see: docker logs docdemo-metabase" >&2; exit 1; fi
  sleep 1
done
ids="$(node seed.mjs "$URL")"
echo "seeded: $ids"
# cases.json hard-codes these ids (start URLs); fail loudly if a new image changes them.
expected='{"collection":5,"ordersCard":40,"byCategoryCard":41,"dashboard":2}'
if [ "$ids" != "$expected" ]; then
  echo "WARNING: seeded ids differ from $expected; update appUrl values in cases.json" >&2
  exit 1
fi
echo "Metabase is up at $URL (admin@docdemo.example / docdemo-admin-1)"
