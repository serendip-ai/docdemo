#!/usr/bin/env bash
# auth.sh <out-file>: sign in the seeded admin through the REST API and write a Playwright
# storage-state JSON ({"cookies": [...], "origins": [...]}) for a running fixture instance.
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
PORT="${PORT:-8065}"
URL="http://localhost:$PORT"
HDRS=$(curl -sf -D - -o /dev/null -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
  -d '{"login_id":"admin","password":"docdemo-admin-1"}' "$URL/api/v4/users/login") \
  || { echo "login failed; is the fixture up? (fixtures/mattermost/up.sh)" >&2; exit 1; }
printf '%s' "$HDRS" | python3 -c '
import sys, json, time
out = sys.argv[1]
cookies = []
for line in sys.stdin.read().splitlines():
    if not line.lower().startswith("set-cookie:"):
        continue
    parts = [p.strip() for p in line.split(":", 1)[1].split(";")]
    name, value = parts[0].split("=", 1)
    attrs = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        attrs[k.lower()] = v
    expires = -1
    if "max-age" in attrs:
        expires = int(time.time()) + int(attrs["max-age"])
    cookies.append({
        "name": name, "value": value, "domain": "localhost", "path": attrs.get("path") or "/",
        "expires": expires, "httpOnly": "httponly" in attrs, "secure": "secure" in attrs,
        "sameSite": {"strict": "Strict", "none": "None"}.get(attrs.get("samesite", "").lower(), "Lax"),
    })
if not any(c["name"] == "MMAUTHTOKEN" for c in cookies):
    sys.exit("no MMAUTHTOKEN cookie in the login response")
with open(out, "w") as f:
    # __landingPageSeen__ skips the "open in the desktop app?" landing page that deep links
    # (e.g. /docdemo/channels/project-alpha) otherwise show on a fresh browser profile.
    origins = [{"origin": sys.argv[2], "localStorage": [{"name": "__landingPageSeen__", "value": "true"}]}]
    json.dump({"cookies": cookies, "origins": origins}, f, indent=2)
print("wrote %s (%d cookies)" % (out, len(cookies)))
' "$OUT" "$URL"
