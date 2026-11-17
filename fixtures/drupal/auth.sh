#!/usr/bin/env bash
# Usage: auth.sh <out-file>
# Signs in to the running fixture as admin through Drupal's login form and writes a Playwright
# storage-state JSON ({"cookies":[...],"origins":[]}) to <out-file>.
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
PORT="${PORT:-3003}"
URL="http://localhost:$PORT"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# Drupal forms need the form_build_id from the rendered form.
build=$(curl -s -c "$JAR" -b "$JAR" "$URL/user/login" | sed -n 's/.*name="form_build_id" value="\([^"]*\)".*/\1/p' | head -1)
if [ -z "$build" ]; then echo "no login form at $URL/user/login" >&2; exit 1; fi
curl -s -o /dev/null -c "$JAR" -b "$JAR" --data-urlencode name=admin --data-urlencode pass=docdemo-admin-1 \
  --data-urlencode form_id=user_login_form --data-urlencode "form_build_id=$build" --data-urlencode 'op=Log in' "$URL/user/login"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$URL/admin/config")
if [ "$code" != 200 ]; then echo "login failed: $URL/admin/config returned $code after signing in" >&2; exit 1; fi

node - "$JAR" "$OUT" <<'JS'
const fs = require('fs');
const [jar, out] = process.argv.slice(2);
const cookies = [];
for (let line of fs.readFileSync(jar, 'utf8').split('\n')) {
  let httpOnly = false;
  if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); }
  else if (!line.trim() || line.startsWith('#')) continue;
  const [domain, , p, secure, expires, name, value] = line.split('\t');
  if (!name) continue;
  cookies.push({
    name, value: value ?? '', domain: domain.replace(/^\./, ''), path: p,
    expires: Number(expires) || -1, httpOnly, secure: secure === 'TRUE', sameSite: 'Lax',
  });
}
if (!cookies.some(c => /^S?SESS/.test(c.name))) { console.error('no Drupal session cookie in login response'); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ cookies, origins: [] }, null, 2) + '\n');
console.log(`wrote ${out} (${cookies.map(c => c.name).join(', ')})`);
JS
