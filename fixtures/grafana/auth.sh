#!/usr/bin/env bash
# Usage: auth.sh <out-file>
# Signs in to the running fixture as admin through Grafana's /login API and writes a Playwright
# storage-state JSON ({"cookies":[...],"origins":[]}) to <out-file>.
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' \
  --data '{"user":"admin","password":"docdemo-admin-1"}' "$URL/login")
if [ "$code" != 200 ]; then echo "login failed: POST $URL/login returned $code" >&2; exit 1; fi

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
if (!cookies.some(c => c.name === 'grafana_session')) { console.error('no grafana_session cookie in login response'); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ cookies, origins: [] }, null, 2) + '\n');
console.log(`wrote ${out} (${cookies.map(c => c.name).join(', ')})`);
JS
