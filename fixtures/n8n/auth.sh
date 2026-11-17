#!/usr/bin/env bash
# Write a Playwright storage-state JSON signed in as the seeded n8n owner.
# Usage: auth.sh <out-file>   (instance must be running; see up.sh)
# Logs in over the REST API and converts the n8n-auth cookie. No browser needed.
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
PORT="${PORT:-5678}"
BASE="http://localhost:$PORT"
EMAIL="${N8N_FIXTURE_EMAIL:-admin@docdemo.local}"
PASSWORD="${N8N_FIXTURE_PASSWORD:-DocDemo-admin-1}"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'content-type: application/json' \
  -X POST "$BASE/rest/login" \
  -d "{\"emailOrLdapLoginId\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
if [ "$code" != "200" ]; then
  echo "login failed (HTTP $code) at $BASE/rest/login; did up.sh run?" >&2
  exit 1
fi

node - "$JAR" "$OUT" "$BASE" <<'EOF'
const fs = require('fs');
const [jar, out, base] = process.argv.slice(2);
const cookies = [];
for (const raw of fs.readFileSync(jar, 'utf8').split('\n')) {
  if (!raw.trim()) continue;
  const httpOnly = raw.startsWith('#HttpOnly_');
  const line = httpOnly ? raw.slice('#HttpOnly_'.length) : raw;
  if (line.startsWith('#')) continue;
  const [domain, , path, secure, expires, name, value] = line.split('\t');
  cookies.push({ name, value, domain: domain.replace(/^\./, ''), path,
    expires: Number(expires) || -1, httpOnly, secure: secure === 'TRUE', sameSite: 'Lax' });
}
if (!cookies.some(c => c.name === 'n8n-auth')) { console.error('no n8n-auth cookie in login response'); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ cookies, origins: [{ origin: base, localStorage: [] }] }, null, 2) + '\n');
console.log(`wrote ${out}`);
EOF
