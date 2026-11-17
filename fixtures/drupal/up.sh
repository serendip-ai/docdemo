#!/usr/bin/env bash
# Start a throwaway Drupal 11.4.8 (standard profile, SQLite) on http://localhost:3003 (no volume, so every
# start is a clean slate). Sign in as admin / docdemo-admin-1 (see auth.sh).
set -euo pipefail
PORT="${PORT:-3003}"
URL="http://localhost:$PORT"
ADMIN_PASS=docdemo-admin-1

docker rm -f docdemo-drupal >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect docdemo-drupal >/dev/null 2>&1 || break; sleep 1; done
docker run -d --rm --name docdemo-drupal -p "127.0.0.1:$PORT:80" drupal:11.4.8-apache >/dev/null

up=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$URL/"; then up=1; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then echo "Drupal did not start; see: docker logs docdemo-drupal" >&2; exit 1; fi

# The install script looks for vendor/ next to web/core, but the image keeps it one level up.
docker exec -w /opt/drupal/web docdemo-drupal sh -c "
  ln -sfn ../vendor vendor &&
  php core/scripts/dr install standard --site-name 'DocDemo Site' --password '$ADMIN_PASS' --quiet 2>/dev/null &&
  chown -R www-data:www-data sites/default"

code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/user/login")
if [ "$code" != 200 ]; then echo "Drupal installed, but $URL/user/login returned $code" >&2; exit 1; fi
echo "Drupal is up at $URL (admin / $ADMIN_PASS)"
