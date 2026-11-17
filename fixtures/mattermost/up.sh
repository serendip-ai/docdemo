#!/usr/bin/env bash
# Start a throwaway Mattermost Team Edition 11.11.1 (preview image: app + bundled Postgres, no volume)
# on http://localhost:8065 and seed it for the DocDemo benchmark cases. Every run starts from scratch.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="mattermost/mattermost-preview:11.11.1"
NAME="docdemo-mattermost"
PORT="${PORT:-8065}"
URL="http://localhost:$PORT"
ADMIN_USER="admin"
ADMIN_PASS="docdemo-admin-1"
TEAM="docdemo"

# -v also drops the anonymous Postgres volume of the previous container, so state really resets.
docker rm -fv "$NAME" >/dev/null 2>&1 || true
# A container started with --rm can still be shutting down from the previous run; wait for its name to free up.
for _ in $(seq 1 30); do docker inspect "$NAME" >/dev/null 2>&1 || break; sleep 1; done
# The image is amd64-only; on Apple silicon it runs under emulation (about 40 s to boot).
docker run -d --rm --name "$NAME" --platform linux/amd64 -p "127.0.0.1:$PORT:8065" \
  -e MM_SERVICESETTINGS_SITEURL="$URL" \
  -e MM_SERVICESETTINGS_ENABLELOCALMODE=true \
  -e MM_SERVICESETTINGS_ENABLETUTORIAL=false \
  -e MM_SERVICESETTINGS_ENABLEONBOARDINGFLOW=false \
  -e MM_SERVICESETTINGS_ENABLESECURITYFIXALERT=false \
  -e MM_LOGSETTINGS_ENABLEDIAGNOSTICS=false \
  -e MM_ANNOUNCEMENTSETTINGS_ADMINNOTICESENABLED=false \
  -e MM_ANNOUNCEMENTSETTINGS_USERNOTICESENABLED=false \
  "$IMAGE" >/dev/null

ready=""
for _ in $(seq 1 180); do
  if curl -sf "$URL/api/v4/system/ping" >/dev/null 2>&1 \
     && docker exec "$NAME" mmctl --local system version >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "Mattermost did not start; see: docker logs $NAME" >&2; exit 1; }

mm() { docker exec "$NAME" mmctl --local "$@" >/dev/null; }

# Plugins that add unrelated UI (call buttons, AI menus) to every channel.
mm plugin disable com.mattermost.calls mattermost-ai || true

# Users and team.
mm user create --username "$ADMIN_USER" --email admin@docdemo.test --password "$ADMIN_PASS" \
  --firstname DocDemo --lastname Admin --system-admin --email-verified
mm user create --username jordan.lee --email jordan.lee@docdemo.test --password docdemo-user-1 \
  --firstname Jordan --lastname Lee --email-verified
mm team create --name "$TEAM" --display-name "DocDemo Team"
mm team users add "$TEAM" "$ADMIN_USER" jordan.lee
# Channels: admin is a member of Project Alpha; Design Reviews exists but admin has not joined it.
mm channel create --team "$TEAM" --name project-alpha --display-name "Project Alpha" \
  --purpose "Planning for the Alpha launch"
mm channel create --team "$TEAM" --name design-reviews --display-name "Design Reviews" \
  --purpose "Weekly design critiques"
mm channel users add "$TEAM:project-alpha" "$ADMIN_USER" jordan.lee
mm channel users add "$TEAM:design-reviews" jordan.lee

# The rest goes through the REST API as the admin.
TOKEN=$(curl -sf -D - -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"login_id\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" "$URL/api/v4/users/login" \
  | awk 'tolower($1)=="token:" {print $2}' | tr -d '\r')
[ -n "$TOKEN" ] || { echo "admin login failed" >&2; exit 1; }
api() { curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

ME=$(api "$URL/api/v4/users/me" | json "['id']")
TEAM_ID=$(api "$URL/api/v4/teams/name/$TEAM" | json "['id']")
TOWN=$(api "$URL/api/v4/teams/$TEAM_ID/channels/name/town-square" | json "['id']")
ALPHA=$(api "$URL/api/v4/teams/$TEAM_ID/channels/name/project-alpha" | json "['id']")

post() { api -X POST "$URL/api/v4/posts" -d "{\"channel_id\":\"$1\",\"message\":\"$2\"}" | json "['id']"; }
post "$TOWN" "Welcome to the DocDemo Team workspace." >/dev/null
post "$TOWN" "Reminder: the release checklist lives in Project Alpha." >/dev/null
post "$ALPHA" "Kickoff notes: scope is frozen until Friday." >/dev/null
# A message with edit history (for the restore-previous-version case).
EDITED=$(post "$ALPHA" "Launch date is March 3.")
api -X PUT "$URL/api/v4/posts/$EDITED/patch" -d '{"message":"Launch date is March 10."}' >/dev/null

# A custom sidebar category (for the rename-category case).
api -X POST "$URL/api/v4/users/$ME/teams/$TEAM_ID/channels/categories" \
  -d "{\"user_id\":\"$ME\",\"team_id\":\"$TEAM_ID\",\"type\":\"custom\",\"display_name\":\"Launch Work\",\"channel_ids\":[\"$ALPHA\"]}" >/dev/null

# Dismiss first-run tours and tips for the admin so they do not cover the UI.
prefs=""
for p in "tutorial_step:$ME:999" "crt_thread_pane_step:$ME:999" "crt_tutorial_triggered:$ME:999" \
         "crt_tutorial_step:$ME:999" "drafts:drafts_tour_tip_showed:{\\\"drafts_tour_tip_showed\\\":true}" \
         "app_bar:channel_header_app_bar_tour:{\\\"channel_header_app_bar_tour\\\":true}" \
         "recommended_next_steps:hide:true" "onboarding_task_list:onboarding_task_list_show:false" \
         "onboarding_task_list:onboarding_task_list_open:false"; do
  IFS=: read -r cat name val <<<"$p"
  prefs="$prefs{\"user_id\":\"$ME\",\"category\":\"$cat\",\"name\":\"$name\",\"value\":\"$val\"},"
done
api -X PUT "$URL/api/v4/users/$ME/preferences" -d "[${prefs%,}]" >/dev/null

echo "Mattermost is up at $URL (team: $URL/$TEAM, login $ADMIN_USER / $ADMIN_PASS)"
