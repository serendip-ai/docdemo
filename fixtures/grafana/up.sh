#!/usr/bin/env bash
# Start a throwaway Grafana OSS 13.2.2 on http://localhost:3000 (no volume, so every start is a clean slate),
# then seed what the benchmark procedures need. Sign in as admin / docdemo-admin-1 (see auth.sh).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"
ADMIN_USER=admin
ADMIN_PASS=docdemo-admin-1

docker rm -f docdemo-grafana >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect docdemo-grafana >/dev/null 2>&1 || break; sleep 1; done
# Bound to 127.0.0.1 only. Anonymous access is off: anonymous sessions get 401s from /api/user/teams and
# /api/user/stars, which show an "Unauthorized" toast on first load.
docker run -d --rm --name docdemo-grafana -p "127.0.0.1:$PORT:3000" \
  -e GF_SECURITY_ADMIN_USER="$ADMIN_USER" \
  -e GF_SECURITY_ADMIN_PASSWORD="$ADMIN_PASS" \
  -e GF_AUTH_ANONYMOUS_ENABLED=false \
  -e GF_AUTH_DISABLE_LOGIN_FORM=false \
  -e GF_AUTH_BASIC_ENABLED=true \
  -e GF_USERS_ALLOW_SIGN_UP=false \
  -e GF_NEWS_NEWS_FEED_ENABLED=false \
  -e GF_ANALYTICS_REPORTING_ENABLED=false \
  -e GF_ANALYTICS_CHECK_FOR_UPDATES=false \
  -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
  -e GF_ANALYTICS_FEEDBACK_LINKS_ENABLED=false \
  -v "$PWD/provisioning:/etc/grafana/provisioning:ro" \
  grafana/grafana:13.2.2 >/dev/null

up=0
for _ in $(seq 1 90); do
  if curl -sf "$URL/api/health" >/dev/null && curl -sf -u "$ADMIN_USER:$ADMIN_PASS" "$URL/api/user" >/dev/null; then up=1; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then echo "Grafana did not start; see: docker logs docdemo-grafana" >&2; exit 1; fi

api() { # api METHOD PATH [JSON]
  curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -H 'Content-Type: application/json' -X "$1" "$URL$2" ${3:+--data "$3"}
}

# A second user (for "add a team member") and a team to add them to.
api POST /api/admin/users '{"name":"Dana Demo","email":"dana@docdemo.invalid","login":"dana","password":"docdemo-user-1"}' >/dev/null
api POST /api/teams '{"name":"DocDemo Team"}' >/dev/null

# A saveable (non-provisioned) dashboard with one TestData panel, for library panel / variable procedures.
# Provisioned dashboards cannot be saved from the UI.
api POST /api/dashboards/db "$(cat <<'JSON'
{
  "overwrite": true,
  "message": "seeded by fixtures/grafana/up.sh",
  "dashboard": {
    "uid": "docdemo-sandbox",
    "title": "DocDemo Sandbox",
    "tags": ["docdemo"],
    "schemaVersion": 41,
    "time": { "from": "now-6h", "to": "now" },
    "panels": [
      {
        "id": 1,
        "type": "timeseries",
        "title": "Sandbox traffic",
        "gridPos": { "x": 0, "y": 0, "w": 12, "h": 9 },
        "datasource": { "type": "grafana-testdata-datasource", "uid": "docdemo-testdata" },
        "targets": [{ "refId": "A", "scenarioId": "random_walk" }]
      }
    ]
  }
}
JSON
)" >/dev/null

echo "Grafana is up at $URL (admin / $ADMIN_PASS)"
