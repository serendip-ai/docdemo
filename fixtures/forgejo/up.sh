#!/usr/bin/env bash
# Start a throwaway Forgejo 16.0.5 on http://localhost:3002 (SQLite, no volume, install wizard skipped)
# and seed the data the benchmark cases need. Re-running replaces the container, so state resets.
set -euo pipefail

NAME=docdemo-forgejo
IMAGE=codeberg.org/forgejo/forgejo:16.0.5
PORT=3002
URL="http://localhost:$PORT"
ADMIN_USER=docdemo-admin
ADMIN_PASS=docdemo-admin-1
USER2=docdemo-user2
USER2_PASS=docdemo-user2-1

docker rm -f "$NAME" >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect "$NAME" >/dev/null 2>&1 || break; sleep 1; done

# Forgejo listens on 3002 inside the container too, so http://localhost:3002/... URLs work both from
# the host browser and from Forgejo itself (used by the pull-mirror case to migrate from this instance).
# Bound to 127.0.0.1 only.
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:$PORT" \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__database__DB_TYPE=sqlite3 \
  -e FORGEJO__server__HTTP_PORT="$PORT" \
  -e FORGEJO__server__DOMAIN=localhost \
  -e FORGEJO__server__ROOT_URL="$URL/" \
  -e FORGEJO__server__DISABLE_SSH=true \
  -e FORGEJO__server__OFFLINE_MODE=true \
  -e FORGEJO__service__DISABLE_REGISTRATION=true \
  -e FORGEJO__service__REQUIRE_SIGNIN_VIEW=false \
  -e FORGEJO__mailer__ENABLED=false \
  -e FORGEJO__migrations__ALLOW_LOCALNETWORKS=true \
  -e FORGEJO__cron.update_checker__ENABLED=false \
  -e FORGEJO__log__LEVEL=Warn \
  "$IMAGE" >/dev/null

ok=
for _ in $(seq 1 90); do
  if curl -sf "$URL/api/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "Forgejo did not start; see: docker logs $NAME" >&2; exit 1; }

fj() { docker exec -u git "$NAME" forgejo --config /data/gitea/conf/app.ini "$@"; }
fj admin user create --admin --username "$ADMIN_USER" --password "$ADMIN_PASS" \
  --email admin@docdemo.test --must-change-password=false >/dev/null
fj admin user create --username "$USER2" --password "$USER2_PASS" \
  --email user2@docdemo.test --must-change-password=false >/dev/null

api() { # api METHOD PATH [JSON]
  curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -X "$1" -H 'content-type: application/json' \
    ${3:+--data "$3"} "$URL/api/v1$2"
}

# Repository with two commits on README.md (blame view needs history) and a second file.
api POST /user/repos '{"name":"docdemo-repo","description":"DocDemo sample repository","auto_init":true,"readme":"Default","default_branch":"main","private":false}' >/dev/null
sha=$(api GET "/repos/$ADMIN_USER/docdemo-repo/contents/README.md" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sha"])')
readme=$(printf '# docdemo-repo\n\nDocDemo sample repository.\n\nThis line was added in the second commit.\n' | base64 | tr -d '\n')
api PUT "/repos/$ADMIN_USER/docdemo-repo/contents/README.md" \
  "{\"content\":\"$readme\",\"sha\":\"$sha\",\"message\":\"Expand README\",\"branch\":\"main\"}" >/dev/null
hello=$(printf 'print("hello from DocDemo")\n' | base64 | tr -d '\n')
api POST "/repos/$ADMIN_USER/docdemo-repo/contents/hello.py" \
  "{\"content\":\"$hello\",\"message\":\"Add hello.py\",\"branch\":\"main\"}" >/dev/null

# Two generic packages: docdemo-tool is linked to docdemo-repo, docdemo-lib is not linked.
printf 'DocDemo tool 1.0.0\n' | curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -X PUT -H 'content-type: application/octet-stream' --data-binary @- \
  "$URL/api/packages/$ADMIN_USER/generic/docdemo-tool/1.0.0/docdemo-tool.txt" >/dev/null
printf 'DocDemo lib 0.1.0\n' | curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -X PUT -H 'content-type: application/octet-stream' --data-binary @- \
  "$URL/api/packages/$ADMIN_USER/generic/docdemo-lib/0.1.0/docdemo-lib.txt" >/dev/null
api POST "/packages/$ADMIN_USER/generic/docdemo-tool/-/link/docdemo-repo" >/dev/null

echo "Forgejo is up at $URL (sign in as $ADMIN_USER / $ADMIN_PASS)"
