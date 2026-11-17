#!/usr/bin/env bash
# Usage: auth.sh <out-file>
# Signs in to the running fixture as docdemo-admin over HTTP and writes a Playwright storage state.
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
URL="http://localhost:3002"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

code=$(curl -s -c "$jar" -b "$jar" -o /dev/null -w '%{http_code}' -X POST \
  --data-urlencode user_name=docdemo-admin --data-urlencode password=docdemo-admin-1 -d remember=on \
  "$URL/user/login")
[ "$code" = 303 ] || { echo "login failed (HTTP $code); is ./up.sh running?" >&2; exit 1; }
# Signed in, / is the user's dashboard; signed out, it is the landing page.
home=$(curl -s -b "$jar" "$URL/")
case "$home" in *'<title>docdemo-admin - Dashboard'*) ;; *) echo "login did not stick" >&2; exit 1 ;; esac

python3 - "$jar" "$OUT" <<'PY'
import json, sys
jar, out = sys.argv[1], sys.argv[2]
cookies = []
for line in open(jar):
    http_only = line.startswith('#HttpOnly_')
    if http_only:
        line = line[len('#HttpOnly_'):]
    elif line.startswith('#') or not line.strip():
        continue
    domain, _sub, path, secure, expires, name, value = line.rstrip('\n').split('\t')
    cookies.append({
        'name': name, 'value': value, 'domain': domain, 'path': path,
        'expires': int(expires) if int(expires) > 0 else -1,
        'httpOnly': http_only, 'secure': secure == 'TRUE', 'sameSite': 'Lax',
    })
json.dump({'cookies': cookies, 'origins': []}, open(out, 'w'), indent=2)
print(f'wrote {out} ({len(cookies)} cookies: {", ".join(c["name"] for c in cookies)})')
PY
