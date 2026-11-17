#!/usr/bin/env bash
# Start a throwaway n8n 2.40.6 on http://localhost:5678 (no volume, so every run starts fresh),
# create the owner account and seed sample workflows, tags and executions (see seed.mjs).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-5678}"
IMAGE="docker.n8n.io/n8nio/n8n:2.40.6"
docker rm -f docdemo-n8n >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect docdemo-n8n >/dev/null 2>&1 || break; sleep 1; done
# Bound to 127.0.0.1 only. Telemetry, templates (need internet) and update checks are off.
docker run -d --rm --name docdemo-n8n -p "127.0.0.1:$PORT:5678" \
  -e N8N_EDITOR_BASE_URL="http://localhost:$PORT" \
  -e WEBHOOK_URL="http://localhost:$PORT/" \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_PERSONALIZATION_ENABLED=false \
  -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  -e N8N_TEMPLATES_ENABLED=false \
  -e N8N_HIRING_BANNER_ENABLED=false \
  -e GENERIC_TIMEZONE=Etc/UTC -e TZ=Etc/UTC \
  "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  if curl -sf "http://localhost:$PORT/healthz/readiness" >/dev/null; then
    node seed.mjs "http://localhost:$PORT"
    echo "n8n is up at http://localhost:$PORT (admin@docdemo.local / DocDemo-admin-1)"
    exit 0
  fi
  sleep 1
done
echo "n8n did not start; see: docker logs docdemo-n8n" >&2
exit 1
